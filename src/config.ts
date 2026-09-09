import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}


export const config = {
  port: num("PORT", 8100),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  databaseUrl: process.env.DATABASE_URL?.trim() ?? "",

  jwt: {
    secret: process.env.JWT_SECRET?.trim() || "dev-insecure-signal-secret-change-me",
    expiresInSec: num("JWT_EXPIRES_IN_SEC", 7 * 24 * 60 * 60),
  },

  /** TradingBackend REST base — the chart proxies its operator-key candle history from here. */
  tradingApiUrl: process.env.TRADING_API_URL?.trim() || "http://localhost:8000",
  /** Shared secret sent to the TradingBackend's /api/market/history (must match its SERVICE_TOKEN). */
  serviceToken: process.env.SERVICE_TOKEN?.trim() ?? "",

  /** Rolling window (hours) of closed signals shown on the Signals page. */
  signalWindowHours: num("SIGNAL_WINDOW_HOURS", 24),

  /** AES key for broker credentials at rest. Unset = subscribers cannot connect a broker. */
  brokerEncKey: process.env.BROKER_ENC_KEY?.trim() ?? "",
  /**
   * Master switch for placing real orders. OFF unless explicitly enabled, so a
   * deploy can never start trading a subscriber's account by accident (a bad
   * config, a restored backup, a copied .env). Per-user `copyEnabled` is required
   * on top of this.
   */
  copyExecutionEnabled: process.env.COPY_EXECUTION === "1",

  /**
   * dxFeed / Volumetrica prop-firm platform. The regulated account + execution
   * infrastructure we are migrating copy execution onto. The Propfirm REST API
   * provisions users/accounts/subscriptions and mints per-user trading tokens; the
   * Admin Trading API (WSS) then places the copied orders. See src/dxfeed.
   */
  dxfeed: {
    /** Propfirm REST base, e.g. https://dxfeed.volumetricaprop.com (staging). */
    propfirmUrl: process.env.DXFEED_PROPFIRM_URL?.trim() || "https://dxfeed.volumetricaprop.com",
    /** x-api-key for the Propfirm REST API + webhooks. Unset = dxFeed disabled. */
    apiKey: process.env.DXFEED_API_KEY?.trim() ?? "",
    /** AES-256 key (base64) for encrypting user passwords in API exchanges. Optional. */
    aesKey: process.env.DXFEED_AES_KEY?.trim() ?? "",
    /** 0 = production, 1 = staging. Sent on the trading-token/auth requests. */
    environment: num("DXFEED_ENVIRONMENT", 1),

    /** Admin Trading API (WSS/protobuf) — order execution. */
    trading: {
      /** Auth endpoint that mints the WSS token. The C# example uses /api/auth/token
       *  (the v4 PDF says /api/v2/…) — configurable in case staging differs. */
      authUrl: process.env.DXFEED_TRADING_AUTH_URL?.trim()
        || "https://authdxfeed.volumetricatrading.com/api/auth/token",
      /** Platform key sent as the `PltfKey` header on the auth request. */
      pltfKey: process.env.DXFEED_PLTF_KEY?.trim() ?? "",
      /** The fullTrading SYSTEM credential (created in the dashboard) — one session
       *  places orders across every account. */
      systemLogin: process.env.DXFEED_SYSTEM_LOGIN?.trim() ?? "",
      systemPassword: process.env.DXFEED_SYSTEM_PASSWORD?.trim() ?? "",
      /**
       * Trading API version, sent as `version` on the auth body. REQUIRED —
       * omitting it is rejected with 401 "Your platform is obsolete", which
       * reads like a credential failure but isn't (confirmed vs staging
       * 2026-08-18). 5 matches the v5.1 protos we generate the codec from; the
       * C# example still defaults to 3, and the server accepts either, so this
       * must track the PROTOS rather than the example.
       */
      apiVersion: num("DXFEED_TRADING_API_VERSION", 5),
    },

    /** Defaults applied when provisioning a subscriber's dxFeed account. */
    provisioning: {
      /** Starting balance for a new evaluation account. */
      balance: num("DXFEED_DEFAULT_BALANCE", 50_000),
      /** Optional challenge-template rule id to attach (empty = no rule / plain account). */
      ruleId: process.env.DXFEED_DEFAULT_RULE_ID?.trim() ?? "",
      /** Market-data entitlements (DataFeedProduct ints), CSV. Default: CME L1 (0). */
      dataFeedProducts: (process.env.DXFEED_DATA_PRODUCTS?.trim() || "0")
        .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)),
      /** Subscription platform: 0 = Volumetrica, 1 = Quantower, 2 = ATAS. */
      platform: num("DXFEED_PLATFORM", 0),
      /** Country used for the market-data agreement when we only have an email. */
      country: process.env.DXFEED_DEFAULT_COUNTRY?.trim() || "US",
    },
  },
} as const;

/** dxFeed provisioning/REST is usable only once an API key is configured. */
export const dxfeedReady = config.dxfeed.apiKey.length > 0;

/** dxFeed order EXECUTION is usable only once the trading credentials are set. */
export const dxfeedTradingReady =
  config.dxfeed.trading.pltfKey.length > 0 &&
  config.dxfeed.trading.systemLogin.length > 0 &&
  config.dxfeed.trading.systemPassword.length > 0;

if (config.jwt.secret === "dev-insecure-signal-secret-change-me") {
  console.warn("[auth] JWT_SECRET not set — using an insecure dev secret. Set JWT_SECRET in production.");
}

export const useDatabase = config.databaseUrl.length > 0;
