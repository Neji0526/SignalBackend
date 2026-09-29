/* dxFeed / Volumetrica Propfirm API — types.
 *
 * Hand-transcribed from the LIVE staging Swagger ("Propfirm API V1",
 * https://dxfeed.volumetricaprop.com/swagger/v1/swagger.json), NOT the year-old
 * PDF (whose endpoint names and response envelope are out of date). Only the
 * subset we actually use for provisioning + trading-token minting is modelled;
 * the full trading-rule schema (100+ risk fields) is deliberately omitted — we
 * reference pre-built rule templates by id rather than construct them here.
 *
 * All enums are integers on the wire. We keep them as `const` maps so call sites
 * read as names, not magic numbers. */

export const Platform = { VOLUMETRICA: 0, QUANTOWER: 1, ATAS: 2 } as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const Currency = { EUR: 0, USD: 1 } as const;
export type Currency = (typeof Currency)[keyof typeof Currency];

export const EncryptionMode = { NONE: 0, AES256: 1 } as const;
export type EncryptionMode = (typeof EncryptionMode)[keyof typeof EncryptionMode];

export const UserType = { USER: 0, SYSTEM: 1 } as const;
export type UserType = (typeof UserType)[keyof typeof UserType];

/** System-credential trading scope. FullTrading is what places copied orders. */
export const SystemAccess = { READ_ONLY: 0, LIQUIDATION: 1, FULL_TRADING: 2 } as const;
export type SystemAccess = (typeof SystemAccess)[keyof typeof SystemAccess];

/** Trading-account status. NOTE: values are a BITFLAG-style set — 4=Failed, 8=Disabled. */
export const AccountStatus = {
  INITIALIZED: 0,
  ENABLED: 1,
  CHALLENGE_SUCCESS: 2,
  CHALLENGE_FAILED: 4,
  DISABLED: 8,
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const AccountMode = {
  EVALUATION: 0,
  SIM_FUNDED: 1,
  FUNDED: 2,
  LIVE: 3,
  TRIAL: 4,
  CONTEST: 5,
  TRAINING: 100,
} as const;
export type AccountMode = (typeof AccountMode)[keyof typeof AccountMode];

/** Which id namespace a reference (e.g. a trading-rule id) resolves in. */
export const IdReference = { APPLICATION: 0, ORGANIZATION: 1, ORGANIZATION_OWNER: 2 } as const;
export type IdReference = (typeof IdReference)[keyof typeof IdReference];

/** dxFeed market-data entitlement products (staging list, per Volumetrica email). */
export const DataFeedProduct = {
  CME_L1: 0, CBOT_L1: 1, COMEX_L1: 2, NYMEX_L1: 3,
  CME_L2: 4, CBOT_L2: 5, COMEX_L2: 6, NYMEX_L2: 7,
  EUREX_L1: 8, EUREX_L2: 9,
} as const;
export type DataFeedProduct = (typeof DataFeedProduct)[keyof typeof DataFeedProduct];

// --- request models --------------------------------------------------------

/** POST /api/Propsite/NewUser — "create or update user details". */
export interface NewUserInput {
  firstName: string;
  lastName: string;
  email: string;
  country: string;
  username?: string;
  mobilePhone?: string;
  language?: string;
  /** Our own id for this user (the SignalApp userId), echoed back for correlation. */
  extEntityId?: string;
  encryptionMode?: EncryptionMode;
  forceNewPassword?: boolean;
  passwordToSet?: string;
  userType?: UserType;
  systemAccess?: SystemAccess;
  /**
   * Undocumented in the PDF, present in the live Swagger. Believed to bypass the
   * web dashboard's "choose your trading platform" step — the setting that makes
   * OrderInsert return NO response at all for a user who has never picked one.
   * See system-credential.smoke.ts --fix-platform.
   */
  overrideWebPlatform?: boolean;
}

/** POST /api/Propsite/CreateTradingAccount. */
export interface NewTradingAccountInput {
  userId: string;
  balance: number;
  currency: Currency;
  /** Reference a pre-built (global) trading rule/template by id. */
  accountRuleReference?: IdReference;
  accountRuleId?: string;
  enabled?: boolean;
  mode?: AccountMode;
  description?: string;
}

/** POST /api/Propsite/NewSubscription. */
export interface NewSubscriptionInput {
  userId: string;
  dataFeedProducts: DataFeedProduct[];
  platform: Platform;
  enabled?: boolean;
  durationMonths?: number;
  durationDays?: number;
}

/** POST /api/Propsite/GenerateTradingTokenForUser — bootstraps the Admin Trading API. */
export interface TradingTokenInput {
  login: string;
  password: string;
  /** Trading API version. The Admin Trading API doc targets v3. */
  version: number;
  platform: Platform;
}

// --- response models -------------------------------------------------------

export interface UserResult {
  userId: string;
  username: string | null;
  /** Encrypted per `encryptionMode`. Store it (or let dxFeed email the user). */
  password: string | null;
  encryptionMode: EncryptionMode;
}

export interface NewTradingAccountResult {
  accountId: string;
  header: string | null;
  /** Present only when an account-level (custom) rule was created. */
  tradingRuleId: string | null;
}

export interface SubscriptionResult {
  subscriptionId: string | null;
  confirmationId: string | null;
  status: number; // SubscriptionStatusEnum
  /** Set when status = UserOnHold: the dxFeed data agreement the user must sign. */
  dxAgreementLink: string | null;
  dxAgreementSigned: boolean;
  platform: Platform;
  userId: string | null;
}

/** The keys the Admin Trading API (WSS) needs — minted per user, on demand. */
export interface TradingTokenResult {
  tradingWssEndpoint: string | null;
  /** Single-use token for the WSS LoginRequest. */
  tradingWssToken: string | null;
  tradingRestReportHost: string | null;
  tradingRestReportToken: string | null;
  tradingRestTokenExpiration: number; // unix ms
  tradingApiVersion: number;
}

/** One row of GET /api/Propsite/GetSymbolList. */
export interface DxSymbol {
  id: number;
  name: string; // "ES", "MNQ", …
  description: string;
  exchange: string; // "CME", "CBOT", …
  symbolGroup: string; // "FUTURE_STANDARD" | "FUTURE_MICRO" | …
  category: string;
  margin: number;
  commission: number;
  tickSize: number;
  tickValue: number;
  inhibitTrading: boolean;
  archived: boolean;
}

/** Contract descriptor shared by positions, orders and trades. `name` is the root ("ES", "MNQ"). */
export interface PlatformContract {
  name?: string | null;
  symbol?: string | null;
  contractName?: string | null;
}

/** Open position from Bulk/AccountsInfosEnabled. Short == NEGATIVE quantity;
 *  a flat contract traded earlier in the session still appears with quantity 0. */
export interface PlatformPositionRow {
  contractId?: number | null;
  symbolName?: string | null;
  contract?: PlatformContract | null;
  entryDateUtc?: string | null;
  price?: number | null;
  quantity?: number | null;
  openPl?: number | null;
  convertedOpenPl?: number | null;
}

/** Order from Bulk/AccountsInfosEnabled. status 1 = Working; ordType 1 = Limit, 2 = Stop.
 *  Sell == NEGATIVE totalQty. */
export interface PlatformOrderRow {
  contractId?: number | null;
  status?: number | null;
  ordType?: number | null;
  insertPrice?: number | null;
  totalQty?: number | null;
  insertDtUtc?: string | null;
}

export interface PlatformAccountInfo {
  status?: number | null;
  positions?: PlatformPositionRow[] | null;
  orders?: PlatformOrderRow[] | null;
}

/** Closed trade from Bulk/TradesList. There is no side field; entry/exit dates are unix ms. */
export interface PlatformTrade {
  tradeId?: number | string | null;
  symbolName?: string | null;
  contract?: PlatformContract | null;
  entryDate?: number | null;
  exitDate?: number | null;
  quantity?: number | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  grossPl?: number | null;
  convertedGrossPl?: number | null;
}
