import { getPool } from "../db/pool.js";
import { config } from "../config.js";
import { DxFeedApiError, propfirm } from "./propfirm.js";
import { getDxFeedLink, upsertDxFeedLink, type DxFeedLinkInput } from "./store.js";
import {
  AccountMode, Currency, EncryptionMode, IdReference, UserType,
  type DataFeedProduct, type Platform,
} from "./types.js";

/* Provision a subscriber's dxFeed identity: user → trading account → market-data
 * subscription, all linked back to our signal.User. This is the "single front
 * door" mechanic — the subscriber exists once in our app, and dxFeed is created
 * for them behind the scenes.
 *
 * SAFE TO RETRY. The link row is upserted after EACH dxFeed call, so a failure
 * part-way (or a re-run) resumes from where it stopped instead of creating
 * duplicate accounts. A subscriber who is already fully provisioned is a no-op.
 *
 * ALSO ADOPTS EXISTING dxFeed state: if the email was already registered on
 * Volumetrica (e.g. Vault onboarding signed the data agreement), we link that
 * user / trading account / subscription into signal.DxFeedAccount instead of
 * failing on NewSubscription "User already has a subscription". */

export interface ProvisionOptions {
  balance?: number;
  /** Challenge-template rule id to attach (defaults to config; empty = no rule). */
  ruleId?: string;
  dataFeedProducts?: number[];
  platform?: number;
}

export type ProvisionResult = DxFeedLinkInput & {
  /** True when we reused an existing Volumetrica subscription instead of NewSubscription. */
  linkedExisting: boolean;
};

/** Best-effort split of a display name (or email) into first/last for dxFeed. */
function splitName(name: string | null, email: string): { firstName: string; lastName: string } {
  const raw = (name || email.split("@")[0] || "Trader").trim();
  const parts = raw.split(/\s+/);
  return { firstName: parts[0] || "Trader", lastName: parts.slice(1).join(" ") || parts[0] || "Account" };
}

/* Returns the LINK ONLY. Provisioning deliberately does not confer trade
 * readiness — a fully provisioned account can still silently swallow orders, so
 * that is earned separately via verifyTradeReady() in readiness.ts. */
export async function provisionSubscriber(userId: string, opts: ProvisionOptions = {}): Promise<ProvisionResult> {
  const existing = await getDxFeedLink(userId);
  if (existing?.dxAccountId && existing?.dxSubscriptionId) {
    return { ...existing, linkedExisting: false };
  }

  const { rows } = await getPool().query(
    `SELECT "email","name" FROM "signal"."User" WHERE "id" = $1`,
    [userId],
  );
  if (!rows[0]) throw new Error(`provisionSubscriber: no signal user ${userId}`);
  const email = String(rows[0].email);
  const { firstName, lastName } = splitName(rows[0].name as string | null, email);

  const p = config.dxfeed.provisioning;
  const ruleId = opts.ruleId ?? p.ruleId;
  const link: DxFeedLinkInput = existing ?? {
    userId, dxUserId: "", dxAccountId: null, dxSubscriptionId: null,
    accountStatus: null, subscriptionStatus: null,
    agreementSigned: false, agreementLink: null, platform: null,
  };
  let linkedExisting = false;

  // 1) dxFeed user (upsert by email on their side; we keep the id).
  if (!link.dxUserId) {
    const user = await propfirm.newUser({
      firstName, lastName, email, country: p.country,
      extEntityId: userId, // our id, echoed back for correlation
      encryptionMode: EncryptionMode.NONE,
      userType: UserType.USER,
    });
    if (!user.userId) throw new Error("provisionSubscriber: NewUser returned no userId");
    link.dxUserId = user.userId;
    await upsertDxFeedLink(link);
  }

  // Adopt remote subscription early (Vault may have created it already).
  if (!link.dxSubscriptionId) {
    const remote = await fetchRemoteSubscription(link.dxUserId);
    if (remote?.subscriptionId) {
      applyRemoteSubscription(link, remote);
      linkedExisting = true;
      await upsertDxFeedLink(link);
    }
  }

  // 2) Trading account — reuse an existing Volumetrica account when present.
  if (!link.dxAccountId) {
    const existingAccountId = await findExistingTradingAccountId(link.dxUserId);
    if (existingAccountId) {
      link.dxAccountId = existingAccountId;
      linkedExisting = true;
      await upsertDxFeedLink(link);
    } else {
      const acct = await propfirm.createTradingAccount({
        userId: link.dxUserId,
        balance: opts.balance ?? p.balance,
        currency: Currency.USD,
        enabled: true,
        mode: AccountMode.EVALUATION,
        description: `SignalApp ${userId}`,
        ...(ruleId ? { accountRuleReference: IdReference.APPLICATION, accountRuleId: ruleId } : {}),
      });
      if (!acct.accountId) throw new Error("provisionSubscriber: CreateTradingAccount returned no accountId");
      link.dxAccountId = acct.accountId;
      await upsertDxFeedLink(link);
    }
  }

  // 3) Market-data subscription — create only if remote has none; otherwise adopt.
  if (!link.dxSubscriptionId) {
    try {
      const sub = await propfirm.newSubscription({
        userId: link.dxUserId,
        dataFeedProducts: (opts.dataFeedProducts ?? p.dataFeedProducts) as DataFeedProduct[],
        platform: (opts.platform ?? p.platform) as Platform,
        enabled: true,
      });
      link.dxSubscriptionId = sub.subscriptionId;
      link.subscriptionStatus = sub.status;
      link.agreementLink = sub.dxAgreementLink;
      link.agreementSigned = sub.dxAgreementSigned;
      link.platform = sub.platform;
      await upsertDxFeedLink(link);
    } catch (err) {
      if (err instanceof DxFeedApiError && /already has a subscription/i.test(err.message)) {
        const remote = await fetchRemoteSubscription(link.dxUserId);
        if (!remote?.subscriptionId) {
          throw new Error(
            `dxFeed reports an existing subscription for ${email}, but GetSubscriptionStatus returned no id. ${(err as Error).message}`,
          );
        }
        applyRemoteSubscription(link, remote);
        linkedExisting = true;
        await upsertDxFeedLink(link);
      } else {
        throw err;
      }
    }
  }

  return { ...link, linkedExisting };
}

async function findExistingTradingAccountId(dxUserId: string): Promise<string | null> {
  try {
    const accounts = await propfirm.getUserAccounts(dxUserId);
    for (const raw of accounts ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const id = o.id ?? o.accountId;
      if (typeof id === "string" && id) return id;
    }
  } catch (err) {
    console.warn("[dxfeed] GetUserAccounts failed:", (err as Error).message.slice(0, 200));
  }
  return null;
}

async function fetchRemoteSubscription(dxUserId: string): Promise<{
  subscriptionId?: string;
  status?: number;
  agreementSigned?: boolean;
  agreementLink?: string | null;
  platform?: number | null;
} | null> {
  try {
    // userId only — never send both userId and subscriptionId together.
    const raw = await propfirm.getSubscriptionStatus(dxUserId, null);
    return parseSubscriptionStatus(raw);
  } catch (err) {
    console.warn("[dxfeed] GetSubscriptionStatus failed:", (err as Error).message.slice(0, 200));
    return null;
  }
}

function applyRemoteSubscription(
  link: DxFeedLinkInput,
  remote: {
    subscriptionId?: string;
    status?: number;
    agreementSigned?: boolean;
    agreementLink?: string | null;
    platform?: number | null;
  },
): void {
  if (remote.subscriptionId) link.dxSubscriptionId = remote.subscriptionId;
  if (remote.status != null) link.subscriptionStatus = remote.status;
  if (typeof remote.agreementSigned === "boolean") link.agreementSigned = remote.agreementSigned;
  if (remote.agreementLink !== undefined) link.agreementLink = remote.agreementLink ?? link.agreementLink;
  if (remote.platform != null) link.platform = remote.platform;
}

function parseSubscriptionStatus(raw: unknown): {
  subscriptionId?: string;
  status?: number;
  agreementSigned?: boolean;
  agreementLink?: string | null;
  platform?: number | null;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nested = (o.subscription && typeof o.subscription === "object"
    ? o.subscription
    : o.data && typeof o.data === "object"
      ? o.data
      : o) as Record<string, unknown>;

  const subscriptionId = nested.subscriptionId ?? o.subscriptionId;
  const status = nested.status ?? nested.subscriptionStatus ?? o.status;
  const agreementSignedRaw =
    nested.dxAgreementSigned ?? nested.agreementSigned ?? o.dxAgreementSigned ?? o.agreementSigned;
  const agreementSigned =
    typeof agreementSignedRaw === "boolean"
      ? agreementSignedRaw
      : agreementSignedRaw === 1 || agreementSignedRaw === "1" || agreementSignedRaw === "true"
        ? true
        : agreementSignedRaw === 0 || agreementSignedRaw === "0" || agreementSignedRaw === "false"
          ? false
          : undefined;
  const agreementLink = (nested.dxAgreementLink ?? nested.agreementLink ?? o.dxAgreementLink) as
    | string
    | null
    | undefined;
  const platform = nested.platform ?? o.platform;

  return {
    subscriptionId: typeof subscriptionId === "string" && subscriptionId ? subscriptionId : undefined,
    status: typeof status === "number" ? status : undefined,
    agreementSigned,
    agreementLink,
    platform: typeof platform === "number" ? platform : null,
  };
}
