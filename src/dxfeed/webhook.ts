import { config } from "../config.js";
import { getLinkByAccountId, getLinkByDxUserId, upsertDxFeedLink } from "./store.js";
import { AccountStatus } from "./types.js";
import { requestTradesSync } from "./platform-feed.js";

/* dxFeed webhook receiver — real-time account/subscription/trade events.
 *
 * dxFeed POSTs a WebhookEventViewModel (see GetWebhookModel) whenever something
 * changes: an account passes/fails its challenge, a balance moves, a subscriber
 * signs the data agreement, a trade closes. We keep the local link in sync and log
 * the notable events, so the app reflects account state WITHOUT polling — and
 * without placing a single order (pure Part-A monitoring).
 *
 * CRITICAL contract from dxFeed's docs: once we've received a request we must
 * answer 200 even if our own processing throws — a non-200 makes dxFeed retry it
 * forever and BLOCK every later webhook behind it. So the only non-200 we return
 * is 401 for a caller that doesn't present our token (i.e. not really dxFeed). */

export const NotificationCategory = {
  ACCOUNTS: 0, OVERNIGHT: 1, SUBSCRIPTIONS: 2, TRADE_REPORT: 3, PORTFOLIO: 4, ORG_USER: 5,
} as const;
export const NotificationEvent = { CREATED: 0, UPDATED: 1, DELETED: 2, OVERNIGHT: 3 } as const;

interface WebhookEvent {
  dtUtc?: string;
  category?: number;
  event?: number;
  userId?: string | null;
  accountId?: string | null;
  tradingAccount?: {
    id?: string | null;
    status?: number;
    reason?: string | null;
    enabled?: boolean;
    snapshot?: { balance?: number; equity?: number } | null;
  } | null;
  subscription?: {
    subscriptionId?: string | null;
    status?: number;
    dxAgreementSigned?: boolean;
    dxAgreementLink?: string | null;
  } | null;
  tradeReport?: Record<string, unknown> | null;
}

export interface WebhookResult { status: number; note: string }

export async function handleDxFeedWebhook(apiKey: string | undefined, body: unknown): Promise<WebhookResult> {
  // Public endpoint — reject anything not carrying our token. (Not "really dxFeed",
  // so it's safe to 401; this is the one case we DON'T ack.)
  if (!config.dxfeed.apiKey || apiKey !== config.dxfeed.apiKey) {
    return { status: 401, note: "bad or missing x-api-key" };
  }
  try {
    const ev = (body ?? {}) as WebhookEvent;
    await dispatch(ev);
    return { status: 200, note: `category=${ev.category} event=${ev.event}` };
  } catch (err) {
    // Swallow — MUST still 200 so the webhook queue isn't blocked.
    console.warn("[dxfeed webhook] processing error (ack 200 anyway):", (err as Error).message);
    return { status: 200, note: "error swallowed" };
  }
}

async function dispatch(ev: WebhookEvent): Promise<void> {
  switch (ev.category) {
    case NotificationCategory.ACCOUNTS: {
      const accountId = ev.accountId ?? ev.tradingAccount?.id ?? null;
      if (!accountId) return;
      const link = await getLinkByAccountId(accountId);
      if (!link) return; // not one of ours
      const status = ev.tradingAccount?.status;
      if (status != null && status !== link.accountStatus) {
        link.accountStatus = status;
        await upsertDxFeedLink(link);
        if (status === AccountStatus.CHALLENGE_SUCCESS) console.log(`[dxfeed] account ${accountId} CHALLENGE PASSED`);
        else if (status === AccountStatus.CHALLENGE_FAILED) console.log(`[dxfeed] account ${accountId} CHALLENGE FAILED — ${ev.tradingAccount?.reason ?? "?"}`);
        else if (status === AccountStatus.DISABLED) console.log(`[dxfeed] account ${accountId} DISABLED — ${ev.tradingAccount?.reason ?? "?"}`);
      }
      return;
    }
    case NotificationCategory.SUBSCRIPTIONS: {
      // Subscription events key on the dxFeed userId (no accountId in the payload).
      const uid = ev.userId ?? null;
      if (!uid) return;
      const link = await getLinkByDxUserId(uid);
      if (!link) return;
      const sub = ev.subscription;
      if (sub) {
        if (sub.status != null) link.subscriptionStatus = sub.status;
        if (typeof sub.dxAgreementSigned === "boolean") link.agreementSigned = sub.dxAgreementSigned;
        if (sub.dxAgreementLink !== undefined) link.agreementLink = sub.dxAgreementLink ?? link.agreementLink;
        await upsertDxFeedLink(link);
        if (sub.dxAgreementSigned) console.log(`[dxfeed] user ${uid} SIGNED the data agreement`);
      }
      return;
    }
    case NotificationCategory.TRADE_REPORT:
      // A closed trade with realized P&L — pull it into the signal feed now
      // instead of waiting for the next scheduled platform-feed sync.
      console.log(`[dxfeed] trade report (account ${ev.accountId}):`, JSON.stringify(ev.tradeReport));
      requestTradesSync();
      return;
    default:
      // OVERNIGHT / PORTFOLIO / ORG_USER — accepted (200) but nothing to persist yet.
      return;
  }
}
