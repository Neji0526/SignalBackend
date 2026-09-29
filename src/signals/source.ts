import { getPool } from "../db/pool.js";
import { config } from "../config.js";
import { buildDemoSignals, demoSignalsEnabled } from "./demo.js";
import { getMarks, getMultiplier } from "./marks.js";
import { getPlatformPositions } from "../dxfeed/platform-feed.js";

/* Signal source — the core of the product. Reads the trading platform's trades
 * (READ-ONLY, from public.*) and turns each into a COUNTER signal:
 *   - direction is inverted     (trader LONG  → signal SHORT)
 *   - stop-loss / take-profit swap sides (signal SL = trader TP, signal TP = trader SL)
 *   - exit mirrors the trader's close
 *   - P&L is the opposite of the trader's realized P&L (the "shadow" P&L)
 *   - conviction = the trader's risk phase (1-4)
 *
 * Never writes to the trading tables. */

const num = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Micro → parent root, so "by market" stats roll micros into their parent. */
const PARENT: Record<string, string> = { MES: "ES", MNQ: "NQ", MGC: "GC", MCL: "CL", MYM: "YM" };
export const market = (symbol: string): string => PARENT[symbol] ?? symbol;

/** Flip a trading side to the signal (counter) side. */
const invert = (side: string): "LONG" | "SHORT" => (side === "LONG" ? "SHORT" : "LONG");

export interface Signal {
  id: string;
  symbol: string;
  market: string;
  side: "LONG" | "SHORT"; // signal (inverted) side
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  exit: number | null;
  quantity: number;
  conviction: number; // trader risk phase 1-4
  status: "active" | "closed";
  openedAt: number;
  closedAt: number | null;
  pnl: number | null; // signal realized P&L (closed only) = -trader realized
  unrealizedPnl: number | null; // signal open P&L (active only) = -trader unrealized
  win: boolean | null;
  locked?: boolean; // over the user's daily limit — price levels hidden (upsell)
  /** Where the trader's trade was placed: the Vault web platform, or directly on
   *  a dxFeed platform (Deepchart / ATAS / Quantower) — see dxfeed/platform-feed.ts. */
  source?: "vault" | "deepchart";
}

/**
 * Active signals — the exact mirror of the TradingApp admin "Positions → Active"
 * tab, inverted.
 *
 * This query is deliberately identical in shape to `adminListOpenPositions` in the
 * TradingBackend, because the signal feed must be that page's opposite row-for-row:
 *   - reads PositionLot (ONE ROW PER ENTRY TRADE), not the netted Position line —
 *     the admin CRM lists every entry separately, so netting here would collapse
 *     two trades into one signal and lose the per-trade entry price + open time
 *   - SL/TP come from the newest resting OCO exit legs (STOP = trader's stop,
 *     LIMIT = trader's target), matched per (account, symbol)
 *   - conviction = the trade's phase when it opened, falling back to the account's
 *     current risk phase
 *
 * P&L is marked to the LIVE quote (see marks.ts) rather than read from the stored
 * `unrealizedPnl` column, which is a stale snapshot — the admin page marks to
 * market too, and a signal quoting a stale P&L would contradict it.
 */
export async function getActiveSignals(): Promise<Signal[]> {
  const { rows } = await getPool().query(
    `SELECT l."id", l."symbol", l."side", l."quantity", l."entryPrice", l."openedAt", l."accountId",
            l."phaseAtOpen", a."riskPhase",
            (SELECT o."requestedPrice" FROM "public"."Order" o
              WHERE o."accountId" = l."accountId" AND o."symbol" = l."symbol"
                AND o."status" = 'PENDING' AND o."ocoGroupId" IS NOT NULL AND o."type" = 'STOP'
              ORDER BY o."updatedAt" DESC LIMIT 1) AS "traderStop",
            (SELECT o."requestedPrice" FROM "public"."Order" o
              WHERE o."accountId" = l."accountId" AND o."symbol" = l."symbol"
                AND o."status" = 'PENDING' AND o."ocoGroupId" IS NOT NULL AND o."type" = 'LIMIT'
              ORDER BY o."updatedAt" DESC LIMIT 1) AS "traderTarget"
     FROM "public"."PositionLot" l
     JOIN "public"."Account" a ON a."id" = l."accountId"
     ORDER BY l."openedAt" DESC`,
  );
  const platform = getPlatformPositions();
  if (rows.length === 0 && platform.length === 0) return [];

  const marks = await getMarks([...rows.map((r) => r.symbol as string), ...platform.map((p) => p.symbol)]);

  const vault = rows.map((r): Signal => {
    const entry = num(r.entryPrice);
    const qty = num(r.quantity);
    const side = invert(r.side);
    // Signal P&L is the opposite of the trader's, so the signal's own direction
    // gives it directly: (mark − entry) × qty × signalDirection × multiplier.
    const dir = side === "LONG" ? 1 : -1;
    const mark = marks.get(r.symbol);
    // No mark → P&L is UNKNOWN, not zero. `Position.unrealizedPnl` is never written
    // by the trading backend (it marks in memory and pushes over WS), so falling back
    // to it produced a confident-looking "+$0" that never moved. null renders as "—",
    // which is honest and makes a broken TRADING_API_URL visible instead of silent.
    const unrealizedPnl =
      mark != null && mark > 0
        ? Math.round((mark - entry) * qty * dir * getMultiplier(r.symbol) * 100) / 100
        : null;

    return {
      id: `lot:${r.id}`,
      symbol: r.symbol,
      market: market(r.symbol),
      side,
      entry,
      // Inverted: the signal's stop sits where the trader takes profit, and vice versa.
      stopLoss: r.traderTarget != null ? num(r.traderTarget) : null,
      takeProfit: r.traderStop != null ? num(r.traderStop) : null,
      exit: null,
      quantity: qty,
      conviction: (r.phaseAtOpen != null ? num(r.phaseAtOpen) : num(r.riskPhase)) || 1,
      status: "active" as const,
      openedAt: new Date(r.openedAt).getTime(),
      closedAt: null,
      pnl: null,
      unrealizedPnl,
      win: null,
      source: "vault",
    };
  });

  // Positions opened directly on Deepchart / other dxFeed platforms, inverted the
  // same way. Marked to the same live quote as Vault rows; if there is none, the
  // opposite of the trader's own open P&L reported by dxFeed.
  const deepchart = platform.map((p): Signal => {
    const side = invert(p.side);
    const dir = side === "LONG" ? 1 : -1;
    const mark = marks.get(p.symbol);
    const unrealizedPnl =
      mark != null && mark > 0 && p.entry > 0
        ? Math.round((mark - p.entry) * p.quantity * dir * getMultiplier(p.symbol) * 100) / 100
        : p.traderOpenPl != null
          ? Math.round(-p.traderOpenPl * 100) / 100
          : null;
    return {
      id: `dx:${p.id}`,
      symbol: p.symbol,
      market: market(p.symbol),
      side,
      entry: p.entry,
      stopLoss: p.traderTarget,
      takeProfit: p.traderStop,
      exit: null,
      quantity: p.quantity,
      conviction: p.conviction || 1,
      status: "active",
      openedAt: p.openedAt,
      closedAt: null,
      pnl: null,
      unrealizedPnl,
      win: null,
      source: "deepchart",
    };
  });

  if (deepchart.length === 0) return vault;
  return [...vault, ...deepchart].sort((a, b) => b.openedAt - a.openedAt);
}

/* Closed trades from both places a trader can trade: the platform's own
 * ClosedPosition table and the Deepchart / dxFeed trades synced into
 * signal.PlatformTrade. Same column shape, so both map through toClosedSignal. */
const CLOSED_UNION = `
  SELECT "id","symbol","side"::text AS "side","quantity","entryPrice","exitPrice","realizedPnl","openedAt","closedAt","phaseAtOpen",
         'vault' AS "source"
  FROM "public"."ClosedPosition"
  UNION ALL
  SELECT 'dx:' || "accountId" || ':' || "tradeId","symbol","side","quantity","entryPrice","exitPrice","realizedPnl","openedAt","closedAt","phaseAtOpen"::smallint,
         'deepchart' AS "source"
  FROM "signal"."PlatformTrade"`;

/** Closed signals within a window — inverted, with signal-side P&L.
 *  `untilMs` is inclusive; omit it for "up to now". */
export async function getClosedSignals(sinceMs: number, untilMs?: number): Promise<Signal[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM (${CLOSED_UNION}) c
     WHERE "closedAt" >= $1 AND ($2::timestamptz IS NULL OR "closedAt" <= $2)
     ORDER BY "closedAt" DESC`,
    [new Date(sinceMs), untilMs != null ? new Date(untilMs) : null],
  );
  return rows.map(toClosedSignal);
}

/** Map a ClosedPosition row to its inverted (counter) signal. */
function toClosedSignal(r: Record<string, unknown>): Signal {
  const signalPnl = -num(r.realizedPnl); // counter side
  return {
    id: `cls:${r.id}`,
    symbol: r.symbol as string,
    market: market(r.symbol as string),
    side: invert(r.side as string),
    entry: num(r.entryPrice),
    stopLoss: null, // historical bracket levels aren't retained on the closed row
    takeProfit: null,
    exit: num(r.exitPrice),
    quantity: num(r.quantity),
    conviction: r.phaseAtOpen != null ? num(r.phaseAtOpen) : 1,
    status: "closed",
    openedAt: new Date(r.openedAt as string).getTime(),
    closedAt: new Date(r.closedAt as string).getTime(),
    pnl: Math.round(signalPnl * 100) / 100,
    unrealizedPnl: null,
    win: Math.abs(signalPnl) < 0.005 ? null : signalPnl > 0,
    source: r.source === "deepchart" ? "deepchart" : "vault",
  };
}

/**
 * Active + closed signals within an explicit window. `untilMs` is inclusive;
 * omit it for "up to now". Open signals are included when they were opened inside
 * the window, so a past range shows what was running at the time.
 */
export async function getSignalsRange(sinceMs: number, untilMs?: number): Promise<Signal[]> {
  const [activeAll, closed] = await Promise.all([getActiveSignals(), getClosedSignals(sinceMs, untilMs)]);
  const active = activeAll.filter((s) => s.openedAt >= sinceMs && (untilMs == null || s.openedAt <= untilMs));
  // Design-demo fallback: when there are no live trades in the window, synthesize a
  // plausible set so the page/chart aren't empty. Real data always wins — this only
  // fires on a truly empty live set.
  if (active.length === 0 && closed.length === 0 && demoSignalsEnabled) {
    return buildDemoSignals(sinceMs, untilMs);
  }
  // Active first, then closed newest-first.
  return [...active, ...closed];
}

/** Active + recent-closed signals for the Signals page (last N hours). */
export async function getSignals(windowHours = config.signalWindowHours): Promise<Signal[]> {
  return getSignalsRange(Date.now() - windowHours * 3_600_000);
}

/**
 * Active + the most recent `limit` closed signals, ALL TIME.
 *
 * This is the mirror of the admin Positions page, which lists every closed
 * position (capped at 500) rather than a rolling window — the Signals page uses
 * this so its Active/Closed counts line up with the admin's row-for-row. A 24h
 * window here made the two pages disagree whenever trading paused for a day.
 */
export async function getMirrorSignals(limit = 500): Promise<Signal[]> {
  const [active, closed] = await Promise.all([getActiveSignals(), getRecentClosedSignals(limit)]);
  if (active.length === 0 && closed.length === 0 && demoSignalsEnabled) {
    return buildDemoSignals(Date.now() - 30 * 86_400_000);
  }
  return [...active, ...closed];
}

/** The newest `limit` closed signals regardless of age — mirrors adminListClosedPositions. */
export async function getRecentClosedSignals(limit = 500): Promise<Signal[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM (${CLOSED_UNION}) c
     ORDER BY "closedAt" DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map(toClosedSignal);
}
