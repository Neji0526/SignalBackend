import { config } from "../config.js";
import type {
  NewUserInput, UserResult,
  NewTradingAccountInput, NewTradingAccountResult,
  NewSubscriptionInput, SubscriptionResult,
  TradingTokenInput, TradingTokenResult,
  DxSymbol,
} from "./types.js";

/* dxFeed / Volumetrica Propfirm REST client.
 *
 * The "management" half of the dxFeed integration: provision users, trading
 * accounts and market-data subscriptions, and mint the per-user token the Admin
 * Trading API (WSS) needs to place orders. Broker-credential-free — the only
 * secret is the propfirm x-api-key, held once by the backend.
 *
 * Transport notes (from probing the LIVE staging API, not the stale PDF):
 *  - Base:   {propfirmUrl}/api/Propsite/{Action}
 *  - Auth:   header  x-api-key: {config.dxfeed.apiKey}
 *  - GETs carry their args as query params; POSTs as a JSON body.
 *  - Success returns the entity as RAW json (no {success,data} envelope). We still
 *    unwrap an envelope defensively in case production wraps them.
 *  - Errors come back non-2xx; we surface status + body so callers can log why. */

export class DxFeedApiError extends Error {
  constructor(
    readonly action: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`dxFeed ${action} failed (HTTP ${status}): ${body.slice(0, 500)}`);
    this.name = "DxFeedApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class PropfirmClient {
  constructor(
    private readonly baseUrl: string = config.dxfeed.propfirmUrl,
    private readonly apiKey: string = config.dxfeed.apiKey,
  ) {}

  private async call<T>(
    action: string,
    opts: { method?: "GET" | "POST"; query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const method = opts.method ?? (opts.body ? "POST" : "GET");
    const url = new URL(`/api/Propsite/${action}`, this.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const res = await fetch(url, {
      method,
      headers: {
        "x-api-key": this.apiKey,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    if (!res.ok) throw new DxFeedApiError(action, res.status, text);

    if (!text) return undefined as T;
    const json = JSON.parse(text) as unknown;
    // Defensive unwrap: if a {success, data} envelope ever appears, return .data.
    if (json && typeof json === "object" && "success" in json && "data" in json) {
      return (json as { data: T }).data;
    }
    return json as T;
  }

  /** Liveness/auth probe — also the "which accounts are still active" poll. */
  getEnabledAccountsId(): Promise<string[]> {
    return this.call<string[]>("GetEnabledAccountsId");
  }

  /** Tradeable instruments with margins/commissions/tick values (id → symbol map). */
  getSymbolList(): Promise<DxSymbol[]> {
    return this.call<DxSymbol[]>("GetSymbolList");
  }

  getContractName(contractId: number): Promise<string> {
    return this.call<string>("GetContractName", { query: { contractId } });
  }

  /** Full account state: balance/equity snapshot, open orders and positions. */
  getAccountInfo(accountId: string): Promise<unknown> {
    return this.call<unknown>("GetAccountInfo", { query: { accountId } });
  }

  getUserAccounts(userId: string): Promise<unknown[]> {
    return this.call<unknown[]>("GetUserAccounts", { query: { userId } });
  }

  // --- provisioning --------------------------------------------------------

  /** Create (or update, keyed by email) a customer. Returns the userId to store. */
  newUser(input: NewUserInput): Promise<UserResult> {
    return this.call<UserResult>("NewUser", { method: "POST", body: input });
  }

  /** Create a trading account, optionally enabled and bound to a rule template. */
  createTradingAccount(input: NewTradingAccountInput): Promise<NewTradingAccountResult> {
    return this.call<NewTradingAccountResult>("CreateTradingAccount", { method: "POST", body: input });
  }

  /** Create the user's market-data subscription (platform + data-feed products). */
  newSubscription(input: NewSubscriptionInput): Promise<SubscriptionResult> {
    return this.call<SubscriptionResult>("NewSubscription", { method: "POST", body: input });
  }

  /**
   * Mint the per-user keys the Admin Trading API (WSS) needs to place orders.
   * The `tradingWssToken` is single-use — request one per session.
   */
  generateTradingToken(input: TradingTokenInput): Promise<TradingTokenResult> {
    return this.call<TradingTokenResult>("GenerateTradingTokenForUser", { method: "POST", body: input });
  }

  // --- account / subscription lifecycle ------------------------------------

  enableTradingAccount(accountId: string): Promise<unknown> {
    return this.call<unknown>("EnableTradingAccount", { query: { accountId } });
  }

  disableTradingAccount(accountId: string, reason = "", forceClose = true): Promise<unknown> {
    return this.call<unknown>("DisableTradingAccount", { query: { accountId, reason, forceClose } });
  }

  /** Delete an account. Must be disabled first — cannot delete an active account. */
  deleteTradingAccount(userId: string, accountId: string): Promise<unknown> {
    return this.call<unknown>("DeleteTradingAccount", { query: { userId, accountId } });
  }

  deactivateSubscription(subscriptionId: string): Promise<unknown> {
    return this.call<unknown>("DeactiveSubscription", { query: { subscriptionId } });
  }

  deleteSubscription(subscriptionId: string): Promise<unknown> {
    return this.call<unknown>("DeleteSubscription", { query: { subscriptionId } });
  }

  /**
   * Fetch subscription by userId and/or subscriptionId.
   * Swagger: pass userId OR subscriptionId — not both (userId must be null if
   * subscriptionId is sent). Prefer userId alone to adopt an existing sub.
   */
  getSubscriptionStatus(userId?: string | null, subscriptionId?: string | null): Promise<unknown> {
    return this.call<unknown>("GetSubscriptionStatus", {
      query: {
        userId: userId || undefined,
        subscriptionId: subscriptionId || undefined,
      },
    });
  }
}

/** Shared singleton, configured from env. */
export const propfirm = new PropfirmClient();
