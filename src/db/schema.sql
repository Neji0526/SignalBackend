-- SignalBackend schema. Everything the signal app OWNS lives under the "signal"
-- schema, kept completely separate from the trading platform's tables (public.*).
-- This app only READS the trading tables; it never creates or alters them.
-- Idempotent — safe to run repeatedly (applied by `npm run db:migrate`).

CREATE SCHEMA IF NOT EXISTS "signal";

-- Signal-app customers. A DIFFERENT user base from the trading platform's
-- "public"."User": a trader can never log into the signal app because they have
-- no row here (and the JWT secret differs).
CREATE TABLE IF NOT EXISTS "signal"."User" (
  "id"           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "email"        text UNIQUE NOT NULL,
  "passwordHash" text NOT NULL,
  "name"         text,
  "role"         text NOT NULL DEFAULT 'SUBSCRIBER', -- 'SUBSCRIBER' | 'ADMIN'
  "status"       text NOT NULL DEFAULT 'ACTIVE',     -- 'ACTIVE' | 'SUSPENDED'
  "createdAt"    timestamptz NOT NULL DEFAULT now(),
  "updatedAt"    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "signal_User_email_idx" ON "signal"."User" ("email");

-- Per-user ACCESS configuration (entitlements). Controls which signals each
-- subscriber receives on their live feed. Added as nullable/defaulted columns so
-- the migration is idempotent and safe on an existing table.
--   accessMarkets       text[]  : allowed markets (empty = ALL)  e.g. {NQ,ES}
--   accessDirection     text    : 'LONG' | 'SHORT' | 'BOTH'
--   accessDailyLimit    integer : max signals/day (NULL = unlimited); extra are locked
--   accessMinConviction integer : only deliver conviction >= this (1..4)
--   accessLive          boolean : see ACTIVE (live) signals, or only closed history
--   accessSuspended     boolean : cut the feed entirely (without deleting the user)
--   accessAllocationPercent integer : COPY share of eligible signals (0-100). The
--                                     subscriber still SEES all of them; only the
--                                     copy engine trades this slice, so a fleet of
--                                     accounts doesn't place identical trades. 100 = all.
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessMarkets"       text[]  NOT NULL DEFAULT '{}';
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessDirection"     text    NOT NULL DEFAULT 'BOTH';
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessDailyLimit"    integer;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessMinConviction" integer NOT NULL DEFAULT 1;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessLive"          boolean NOT NULL DEFAULT true;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessSuspended"     boolean NOT NULL DEFAULT false;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessAllocationPercent" integer NOT NULL DEFAULT 100;
--   accessMaxCopiesPerDay integer : admin HARD cap on COPIED trades per rolling 24h
--                                   (NULL = no cap). Enforced in the copy engine as
--                                   min(this, the subscriber's own Max-per-day), so
--                                   the admin cap always wins. Distinct from
--                                   accessDailyLimit, which caps the FEED, not execution.
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "accessMaxCopiesPerDay" integer;

-- ---------------------------------------------------------------------------
-- Broker integration (Tradovate). Phase 1 is strictly ONE-TO-ONE: a subscriber
-- links exactly one brokerage account, enforced by the UNIQUE constraint on
-- "userId". Expanding to one-user-many-accounts later means dropping that
-- constraint and adding a "primary" flag — every other column already allows it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "signal"."BrokerLink" (
  "id"            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"        text NOT NULL UNIQUE REFERENCES "signal"."User"("id") ON DELETE CASCADE,
  "broker"        text NOT NULL DEFAULT 'tradovate',
  -- 'demo' | 'live'. Defaults to demo: connecting to a live account must be a
  -- deliberate act, never something a default lands you in.
  "env"           text NOT NULL DEFAULT 'demo',
  -- AES-256-GCM blobs (BROKER_ENC_KEY). The password and API secret are NEVER
  -- stored or logged in plaintext and are never returned over the API.
  "usernameEnc"   text NOT NULL,
  "passwordEnc"   text NOT NULL,
  "cidEnc"        text NOT NULL,
  "secEnc"        text NOT NULL,
  -- Resolved after a successful login; identifies which account orders go to.
  "accountId"     integer,
  "accountSpec"   text,
  "accountName"   text,
  "status"        text NOT NULL DEFAULT 'PENDING',  -- 'PENDING' | 'CONNECTED' | 'ERROR'
  "lastError"     text,
  "lastCheckedAt" timestamptz,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

-- Auto-copy settings. Separate from BrokerLink so a user can keep their broker
-- connected while automation is switched off — disconnecting to pause trading
-- would force them to re-enter credentials.
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyEnabled"       boolean NOT NULL DEFAULT false;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyMinConviction" integer NOT NULL DEFAULT 1;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyMarkets"       text[]  NOT NULL DEFAULT '{}';
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyQuantity"      integer NOT NULL DEFAULT 1;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyMaxConcurrent" integer NOT NULL DEFAULT 3;
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyMaxPerDay"     integer NOT NULL DEFAULT 10;

-- Per-account BASE dollar risk per trade. The risk taken on a copied signal is
-- baseRisk × its conviction level (1..4); the engine then sizes in micro contracts
-- to hit that figure. Set per subscriber (their account, their risk tolerance).
-- NULL = inherit the global default base (signal.AppSetting key 'baseRisk').
-- Supersedes the flat "copyQuantity" (contracts per signal), now vestigial: the
-- copy engine sizes by risk, not by a fixed contract count.
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyBaseRisk"      integer;

-- Every copy attempt, successful or not. This table is what makes automation
-- SAFE to re-run: the UNIQUE (userId, signalId) pair means a signal can only ever
-- be placed once per user, so a restart, a duplicate broadcast or an overlapping
-- engine tick can never double-fill a live account.
CREATE TABLE IF NOT EXISTS "signal"."CopyOrder" (
  "id"            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"        text NOT NULL REFERENCES "signal"."User"("id") ON DELETE CASCADE,
  "signalId"      text NOT NULL,
  "symbol"        text NOT NULL,
  "contract"      text,
  "side"          text NOT NULL,             -- signal side: 'LONG' | 'SHORT'
  "quantity"      integer NOT NULL,
  "status"        text NOT NULL,             -- 'PLACED' | 'REJECTED' | 'SKIPPED'
  "brokerOrderId" text,
  "reason"        text,                      -- rejection cause / skip reason
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CopyOrder_user_signal_key" UNIQUE ("userId", "signalId")
);
CREATE INDEX IF NOT EXISTS "signal_CopyOrder_user_idx" ON "signal"."CopyOrder" ("userId", "createdAt" DESC);

-- Three-way copy mode, superseding the boolean "copyEnabled" (kept in sync for
-- any older reader). 'confirm' prepares an order but waits for the user to
-- approve it — required wherever automation is only permitted with active human
-- oversight.
ALTER TABLE "signal"."User" ADD COLUMN IF NOT EXISTS "copyMode" text NOT NULL DEFAULT 'off';

-- CopyOrder gains the queue/confirm lifecycle:
--   PENDING_CONFIRM -> user must approve  |  QUEUED -> awaiting their terminal
--   PLACED / REJECTED / SKIPPED           -> terminal states
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "adapter"     text;
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "stopLoss"    numeric(18,6);
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "takeProfit"  numeric(18,6);
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "conviction"  integer;
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "claimedAt"   timestamptz;
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "updatedAt"   timestamptz NOT NULL DEFAULT now();

-- The signal's entry price, carried through so the terminal can work the entry as
-- a LIMIT order at the price the signal was published at, rather than paying
-- whatever the market offers. A market entry fills at any price, which in a fast
-- market is exactly where a copied result stops resembling the advertised one.
-- NULL = no price known; the terminal falls back to a market entry.
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "limitPrice"  numeric(18,6);

-- Copy orders are now either an ENTRY or a CLOSE (mirroring the trader exiting).
-- 'kind' defaults to ENTRY so every existing row keeps its meaning.
ALTER TABLE "signal"."CopyOrder" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'ENTRY';

-- The UNIQUE(userId, signalId) guard stops a signal being ENTERED twice — but a
-- CLOSE for that same signal must still be allowed through. Widening the key to
-- include 'kind' permits exactly one entry AND one close per signal, per user,
-- and nothing more.
ALTER TABLE "signal"."CopyOrder" DROP CONSTRAINT IF EXISTS "CopyOrder_user_signal_key";
CREATE UNIQUE INDEX IF NOT EXISTS "CopyOrder_user_signal_kind_key"
  ON "signal"."CopyOrder" ("userId", "signalId", "kind");

-- DRY_RUN: the terminal deliberately did not place this because it is in
-- log-only mode. Distinct from SKIPPED (a filter/limit stopped it) and REJECTED
-- (the broker refused it), because a DRY_RUN entry represents a position that
-- WOULD exist — so it must still generate a CLOSE. Without this, log-only mode
-- could exercise entries but never exits, and close bugs would only surface
-- once real money was on the line.
COMMENT ON COLUMN "signal"."CopyOrder"."status" IS
  'PENDING_CONFIRM | QUEUED | PLACED | DRY_RUN | REJECTED | SKIPPED | EXPIRED | ABANDONED';

-- Global key/value settings for the signal service (admin-configured). Currently
-- holds the conviction->risk map that drives position sizing; a table rather than
-- env vars because the admin edits it live from the dashboard.
CREATE TABLE IF NOT EXISTS "signal"."AppSetting" (
  "key"       text PRIMARY KEY,
  "value"     jsonb NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- dxFeed / Volumetrica prop-account link. One row per subscriber, mapping our
-- signal.User to the dxFeed identity provisioned for them (user + trading
-- account + market-data subscription). This is how a subscriber ends up with a
-- single front door: they sign up here, and their dxFeed account is created and
-- linked behind the scenes (see src/dxfeed/provision.ts). Phase 1 is ONE-TO-ONE
-- (a subscriber → one dxFeed account); expanding later means dropping the PK on
-- userId and adding a "primary" flag, like BrokerLink.
--
-- No per-user broker credentials are stored: copy execution places orders via a
-- single fullTrading SYSTEM credential keyed by "dxAccountId", so the account id
-- is the only thing we need to persist here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "signal"."DxFeedAccount" (
  "userId"             text PRIMARY KEY REFERENCES "signal"."User"("id") ON DELETE CASCADE,
  "dxUserId"           text NOT NULL,                 -- dxFeed's internal user id
  "dxAccountId"        text,                          -- dxFeed trading account id (orders target this)
  "dxSubscriptionId"   text,                          -- market-data subscription id
  "accountStatus"      integer,                       -- TradingAccountStatusEnum (1=Enabled, 4=Failed, …)
  "subscriptionStatus" integer,                       -- SubscriptionStatusEnum (1=Active, 3=UserOnHold, …)
  -- The user must sign dxFeed's data agreement (pro/no-pro) before real-time data;
  -- the link is surfaced so we can prompt them. Signed state arrives via webhook.
  "agreementSigned"    boolean NOT NULL DEFAULT false,
  "agreementLink"      text,
  "platform"           integer,                       -- PlatformEnum the subscription was created for
  "createdAt"          timestamptz NOT NULL DEFAULT now(),
  "updatedAt"          timestamptz NOT NULL DEFAULT now()
);

-- Trade readiness. Provisioning returning 200 does NOT mean the account can
-- trade: a freshly provisioned identity can sit in a state where the trading
-- session logs in, lists the account and reports it enabled, yet OrderInsert
-- gets NO response at all — orders vanish with no rejection to detect. The only
-- reliable test is to place a real (far-from-market, immediately cancelled)
-- order and see it acked, so we do that ONCE and record the result here.
--
-- tradeVerifiedAt NULL = never proven tradeable; the copy engine must not route
-- signals to this subscriber yet. Cleared again if a live order ever times out
-- waiting for an ack, so a subscriber that regresses is re-probed instead of
-- silently losing further orders.
ALTER TABLE "signal"."DxFeedAccount" ADD COLUMN IF NOT EXISTS "tradeVerifiedAt" timestamptz;
ALTER TABLE "signal"."DxFeedAccount" ADD COLUMN IF NOT EXISTS "tradeProbeError" text;

-- ---------------------------------------------------------------------------
-- Closed trades taken on the dxFeed / Volumetrica platforms (Deepchart, ATAS,
-- Quantower), synced read-only from the Propfirm Bulk/TradesList API by
-- src/dxfeed/platform-feed.ts. These never reach the trading platform's own
-- ClosedPosition table, so without this copy a trade placed in Deepchart would
-- never become a signal. Stored in the TRADER's terms (side, P&L) exactly like
-- ClosedPosition; source.ts inverts them the same way.
-- "side" is inferred (the API has no side field): see inferTradeSide().
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "signal"."PlatformTrade" (
  "accountId"   text NOT NULL,                 -- dxFeed trading account id
  "tradeId"     text NOT NULL,
  "symbol"      text NOT NULL,                 -- contract root, e.g. ES / MNQ
  "side"        text NOT NULL,                 -- trader side: 'LONG' | 'SHORT'
  "quantity"    integer NOT NULL,
  "entryPrice"  numeric(18,6) NOT NULL,
  "exitPrice"   numeric(18,6) NOT NULL,
  "realizedPnl" numeric(18,2) NOT NULL,        -- trader gross P&L (USD)
  "openedAt"    timestamptz NOT NULL,
  "closedAt"    timestamptz NOT NULL,
  "phaseAtOpen" integer,
  "syncedAt"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("accountId", "tradeId")
);
CREATE INDEX IF NOT EXISTS "signal_PlatformTrade_closedAt_idx" ON "signal"."PlatformTrade" ("closedAt" DESC);
