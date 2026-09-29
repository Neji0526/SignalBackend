import { config, dxfeedReady } from "../config.js";
import { getPool } from "../db/pool.js";
import { propfirm } from "./propfirm.js";
import type { PlatformContract, PlatformTrade } from "./types.js";

/* Platform trade feed — trades placed DIRECTLY on the dxFeed / Volumetrica
 * platforms (Deepchart, ATAS, Quantower).
 *
 * The signal source reads the trading platform's own tables, but a trade placed
 * in Deepchart never touches them: it lives only on dxFeed. This feed pulls those
 * trades READ-ONLY from the Propfirm API so they become signals like any other:
 *   - open positions: Bulk/AccountsInfosEnabled, snapshotted in memory every few
 *     seconds (the WS broadcast ticks at 1s, so it must never call dxFeed itself)
 *   - closed trades:  Bulk/TradesList, upserted into signal.PlatformTrade
 *
 * Everything here is in the TRADER's terms; source.ts does the inversion.
 * Accounts provisioned by this app for its own subscribers (signal.DxFeedAccount)
 * are excluded — those hold COPIES of signals, and feeding them back in would
 * turn every copied trade into a new signal. Never places an order. */

export interface PlatformPosition {
  id: string;
  accountId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  entry: number;
  openedAt: number;
  traderStop: number | null;
  traderTarget: number | null;
  /** The trader's open P&L as reported by dxFeed, used when no live mark is available. */
  traderOpenPl: number | null;
  conviction: number;
}

const num = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

const ORDER_WORKING = 1;
const ORDER_LIMIT = 1;
const ORDER_STOP = 2;
const ORDER_STOP_LIMIT = 3;
const MAX_WINDOW_MS = 7 * 86_400_000;
const INCREMENTAL_LOOKBACK_MS = 24 * 3_600_000;
/** A snapshot older than this is dropped rather than shown as live. */
const POSITIONS_MAX_AGE_MS = 60_000;

let positions: PlatformPosition[] = [];
let positionsAt = 0;
let positionsBusy = false;
let tradesBusy = false;
let backfilled = false;
let positionsTimer: NodeJS.Timeout | null = null;
let tradesTimer: NodeJS.Timeout | null = null;
let syncSoonTimer: NodeJS.Timeout | null = null;

const warned = new Set<string>();
function warnOnce(key: string, msg: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[platform-feed] ${msg}`);
}

/** Contract root ("ES", "MNQ") from the contract descriptor or its display name. */
export function symbolRoot(contract: PlatformContract | null | undefined, symbolName?: string | null): string {
  const name = contract?.name?.trim();
  if (name) return name.toUpperCase();
  const raw = (symbolName ?? contract?.contractName ?? contract?.symbol ?? "").replace(/^\//, "");
  return (raw.split(/[\s\-:]/)[0] ?? "").replace(/[FGHJKMNQUVXZ]\d{1,2}$/, "").toUpperCase();
}

/**
 * The trader's side of a closed trade. TradesList carries no side, so it is
 * derived from how price moved versus the P&L sign (a long profits when price
 * rises). A scratch trade (no move or zero P&L) falls back to the quantity
 * sign, dxFeed's convention being short == negative.
 */
export function inferTradeSide(t: PlatformTrade): "LONG" | "SHORT" {
  const move = num(t.exitPrice) - num(t.entryPrice);
  const pl = t.convertedGrossPl ?? t.grossPl;
  const plNum = num(pl);
  if (Math.abs(move) > 1e-9 && Math.abs(plNum) > 0.005) return move > 0 === plNum > 0 ? "LONG" : "SHORT";
  return num(t.quantity) < 0 ? "SHORT" : "LONG";
}

/** dxFeed account ids this app provisioned for its own subscribers. */
async function ownAccountIds(): Promise<Set<string>> {
  try {
    const { rows } = await getPool().query(
      `SELECT "dxAccountId" FROM "signal"."DxFeedAccount" WHERE "dxAccountId" IS NOT NULL`,
    );
    return new Set(rows.map((r) => String(r.dxAccountId)));
  } catch {
    return new Set();
  }
}

/** Trader risk phase (conviction) per dxFeed account, for accounts linked to a trading-platform user. */
async function convictionByAccount(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const { rows } = await getPool().query(
      `SELECT d."dxAccountId", a."riskPhase"
       FROM "public"."DxFeedAccount" d
       JOIN "public"."Account" a ON a."userId" = d."userId"
       WHERE d."dxAccountId" IS NOT NULL`,
    );
    for (const r of rows) out.set(String(r.dxAccountId), num(r.riskPhase) || 1);
  } catch (err) {
    warnOnce("conviction", `trader risk phases unreadable (${(err as Error).message}) — platform signals default to conviction 1`);
  }
  return out;
}

async function pollPositions(): Promise<void> {
  if (positionsBusy) return;
  positionsBusy = true;
  try {
    const [infos, excluded, conviction] = await Promise.all([
      propfirm.bulkAccountsInfosEnabled(),
      ownAccountIds(),
      convictionByAccount(),
    ]);
    const next: PlatformPosition[] = [];
    for (const [accountId, info] of Object.entries(infos ?? {})) {
      if (excluded.has(accountId)) continue;
      const working = (info?.orders ?? []).filter((o) => o.status === ORDER_WORKING);
      for (const p of info?.positions ?? []) {
        const qty = num(p.quantity);
        if (qty === 0) continue;
        const symbol = symbolRoot(p.contract, p.symbolName);
        if (!symbol) continue;
        // Protective legs sit on the opposite side of the position.
        const exits = working
          .filter((o) => o.contractId === p.contractId && Math.sign(num(o.totalQty)) === -Math.sign(qty))
          .sort((a, b) => Date.parse(b.insertDtUtc ?? "") - Date.parse(a.insertDtUtc ?? ""));
        const stop = exits.find((o) => o.ordType === ORDER_STOP || o.ordType === ORDER_STOP_LIMIT);
        const target = exits.find((o) => o.ordType === ORDER_LIMIT);
        const openPl = p.convertedOpenPl ?? p.openPl;
        next.push({
          id: `${accountId}:${p.contractId ?? symbol}`,
          accountId,
          symbol,
          side: qty > 0 ? "LONG" : "SHORT",
          quantity: Math.abs(qty),
          entry: num(p.price),
          openedAt: Date.parse(p.entryDateUtc ?? "") || Date.now(),
          traderStop: stop?.insertPrice != null ? num(stop.insertPrice) : null,
          traderTarget: target?.insertPrice != null ? num(target.insertPrice) : null,
          traderOpenPl: openPl != null ? num(openPl) : null,
          conviction: conviction.get(accountId) ?? 1,
        });
      }
    }
    // A position that disappeared was closed — fetch its trade row now rather
    // than waiting for the next scheduled sync.
    const nextIds = new Set(next.map((p) => p.id));
    if (positions.some((p) => !nextIds.has(p.id))) requestTradesSync();
    positions = next;
    positionsAt = Date.now();
    warned.delete("positions");
  } catch (err) {
    warnOnce("positions", `open positions unavailable (${(err as Error).message})`);
  } finally {
    positionsBusy = false;
  }
}

async function latestSyncedClose(): Promise<number | null> {
  const { rows } = await getPool().query(`SELECT max("closedAt") AS "last" FROM "signal"."PlatformTrade"`);
  return rows[0]?.last ? new Date(rows[0].last).getTime() : null;
}

async function upsertTrades(
  accountId: string,
  trades: PlatformTrade[],
  conviction: Map<string, number>,
): Promise<number> {
  let n = 0;
  for (const t of trades) {
    if (t.tradeId == null || t.entryDate == null || t.exitDate == null) continue;
    const symbol = symbolRoot(t.contract, t.symbolName);
    if (!symbol) continue;
    await getPool().query(
      `INSERT INTO "signal"."PlatformTrade"
         ("accountId","tradeId","symbol","side","quantity","entryPrice","exitPrice","realizedPnl","openedAt","closedAt","phaseAtOpen","syncedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
       ON CONFLICT ("accountId","tradeId") DO UPDATE SET
         "symbol" = EXCLUDED."symbol", "side" = EXCLUDED."side", "quantity" = EXCLUDED."quantity",
         "entryPrice" = EXCLUDED."entryPrice", "exitPrice" = EXCLUDED."exitPrice",
         "realizedPnl" = EXCLUDED."realizedPnl", "openedAt" = EXCLUDED."openedAt",
         "closedAt" = EXCLUDED."closedAt", "syncedAt" = now()`,
      [
        accountId,
        String(t.tradeId),
        symbol,
        inferTradeSide(t),
        Math.abs(num(t.quantity)),
        num(t.entryPrice),
        num(t.exitPrice),
        Math.round(num(t.convertedGrossPl ?? t.grossPl) * 100) / 100,
        new Date(num(t.entryDate)),
        new Date(num(t.exitDate)),
        conviction.get(accountId) ?? 1,
      ],
    );
    n++;
  }
  return n;
}

async function syncWindow(start: number, end: number, excluded: Set<string>, conviction: Map<string, number>): Promise<number> {
  let n = 0;
  let token: string | undefined;
  do {
    const page = await propfirm.bulkTradesList(new Date(start), new Date(end), token);
    for (const [accountId, trades] of Object.entries(page.data)) {
      if (excluded.has(accountId) || !Array.isArray(trades)) continue;
      n += await upsertTrades(accountId, trades, conviction);
    }
    token = page.nextPageToken ?? undefined;
  } while (token);
  return n;
}

async function syncTrades(): Promise<void> {
  if (tradesBusy) return;
  tradesBusy = true;
  try {
    const now = Date.now();
    const [excluded, conviction] = await Promise.all([ownAccountIds(), convictionByAccount()]);
    let start = now - INCREMENTAL_LOOKBACK_MS;
    if (!backfilled) {
      const last = await latestSyncedClose();
      const floor = now - config.dxfeed.platformFeed.backfillDays * 86_400_000;
      start = Math.min(start, Math.max(floor, last != null ? last - INCREMENTAL_LOOKBACK_MS : floor));
    }
    let n = 0;
    for (let from = start; from < now; from += MAX_WINDOW_MS) {
      n += await syncWindow(from, Math.min(from + MAX_WINDOW_MS, now), excluded, conviction);
    }
    if (!backfilled) console.log(`[platform-feed] closed trades synced (${n} in the last ${Math.round((now - start) / 86_400_000)}d)`);
    backfilled = true;
    warned.delete("trades");
  } catch (err) {
    warnOnce("trades", `closed trades unavailable (${(err as Error).message})`);
  } finally {
    tradesBusy = false;
  }
}

/** Pull closed trades shortly — called when a position closes or a trade report webhook arrives. */
export function requestTradesSync(): void {
  if (!positionsTimer || syncSoonTimer) return;
  syncSoonTimer = setTimeout(() => {
    syncSoonTimer = null;
    void syncTrades();
  }, 2_000);
}

/** Current open platform positions (empty if the feed is off or its snapshot went stale). */
export function getPlatformPositions(): PlatformPosition[] {
  if (Date.now() - positionsAt > POSITIONS_MAX_AGE_MS) return [];
  return positions;
}

export function startPlatformFeed(): void {
  const cfg = config.dxfeed.platformFeed;
  if (!cfg.enabled) {
    console.log("[platform-feed] disabled (PLATFORM_FEED=0) — Deepchart / platform trades are not mirrored");
    return;
  }
  if (!dxfeedReady) {
    console.log("[platform-feed] DXFEED_API_KEY not set — Deepchart / platform trades are not mirrored");
    return;
  }
  if (positionsTimer) return;
  void pollPositions();
  void syncTrades();
  positionsTimer = setInterval(() => void pollPositions(), cfg.positionsPollMs);
  tradesTimer = setInterval(() => void syncTrades(), cfg.tradesPollMs);
  console.log(`[platform-feed] mirroring Deepchart / platform trades (positions every ${cfg.positionsPollMs / 1000}s, trades every ${cfg.tradesPollMs / 1000}s)`);
}

export function stopPlatformFeed(): void {
  if (positionsTimer) clearInterval(positionsTimer);
  if (tradesTimer) clearInterval(tradesTimer);
  if (syncSoonTimer) clearTimeout(syncSoonTimer);
  positionsTimer = tradesTimer = syncSoonTimer = null;
}
