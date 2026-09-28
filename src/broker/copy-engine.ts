import { getPool } from "../db/pool.js";
import { config } from "../config.js";
import { getActiveSignals, type Signal } from "../signals/source.js";
import { applyAccess, getUserAccess, type AccessConfig } from "../access/access.js";
import { listCopyUsers, type CopySettings } from "./copy-settings.js";
import { toIntent, type BrokerAdapter, type CloseIntent, type OrderIntent } from "./adapter.js";
import { sizeByRisk } from "./sizing.js";
import { getBaseRisk, riskForConviction, DEFAULT_BASE_RISK } from "./risk-config.js";
import { isAllocated } from "./allocation.js";

/* The copy engine — turns live signals into per-subscriber orders.
 *
 * Broker-agnostic by construction: it decides WHAT to trade and hands an
 * OrderIntent to a BrokerAdapter. Swapping ATAS for Tradovate changes the
 * adapter, never this file.
 *
 * Order of checks is deliberate and must not be reordered:
 *
 *   1. Master switch      — one env flag disables all execution everywhere
 *   2. ACCESS             — never trade a signal the user isn't entitled to SEE
 *   3. Copy filters       — market / conviction, their trading preferences
 *   4. Already handled?   — the idempotency gate
 *   5. Limits             — per-day and concurrent caps
 *   6. Broker ready?      — a skip, not a rejection
 *   7. Place / queue
 *
 * Access before preferences matters: a subscriber must not be able to widen
 * their entitlement by enabling copying on a market they don't pay for.
 *
 * SAFETY. Real money is at stake, so the engine is built to under-trade rather
 * than over-trade. Every uncertain path skips. Duplicate suppression is enforced
 * by a UNIQUE(userId, signalId) constraint in the DATABASE, not by logic here —
 * a race, a restart or two overlapping ticks cannot produce a second order. */

const TICK_MS = 5_000;
const DAY_MS = 86_400_000;

export type CopyStatus = "PLACED" | "QUEUED" | "PENDING_CONFIRM" | "REJECTED" | "SKIPPED";

export interface CopyDecision {
  userId: string;
  signalId: string;
  status: CopyStatus;
  reason?: string;
}

/**
 * Signals this user actually COPIES: entitled (access) AND allocated (their share).
 *
 * Allocation is applied HERE, in the copy path only — never in applyAccess, which
 * the Signals/Performance views also use. The subscriber still SEES every signal
 * their access covers; they just don't trade the whole stream, so a fleet of
 * accounts doesn't place identical trades. allocationPercent = 100 → the full set.
 */
function copyableSignals(access: AccessConfig, userId: string, signals: Signal[]): Signal[] {
  // Locked signals are teasers (levels hidden); they must never be traded.
  const entitled = applyAccess(signals, access).filter((s) => !s.locked);
  return entitled.filter((s) => isAllocated(s.id, userId, access.allocationPercent));
}

/** Does this signal match the user's own copy preferences? */
function matchesCopyFilters(signal: Signal, s: CopySettings): string | null {
  if (s.markets.length > 0 && !s.markets.includes(signal.market)) return "market not in copy list";
  if (signal.conviction < s.minConviction) return `conviction ${signal.conviction} below minimum ${s.minConviction}`;
  return null;
}

interface Usage {
  today: number;
  open: number;
}

/**
 * Orders already actioned for this user: how many in the last 24h, and how many
 * are still open. SKIPPED rows are excluded from both — a signal we declined is
 * not a trade and must not consume the user's budget.
 */
async function usageFor(userId: string): Promise<Usage> {
  const { rows } = await getPool().query(
    // Both metrics count ENTRIES, not CLOSES. A CLOSE is the exit of a copied
    // signal, not a new one, so it must not consume the daily budget — and it is
    // certainly not an open position.
    //
    // `open` = concurrent OPEN positions. An entry stops being open the moment a
    // CLOSE exists for it (the signal ended and we're flattening), so those are
    // excluded. Without this the count only ever rises — every placed entry stays
    // PLACED forever — and an account permanently jams once it hits maxConcurrent.
    `SELECT
       count(*) FILTER (
         WHERE e."kind" = 'ENTRY'
           AND e."createdAt" >= now() - interval '24 hours'
           AND e."status" <> 'SKIPPED'
       ) AS today,
       count(*) FILTER (
         WHERE e."kind" = 'ENTRY'
           AND e."status" IN ('PLACED','QUEUED','PENDING_CONFIRM')
           AND NOT EXISTS (
             SELECT 1 FROM "signal"."CopyOrder" c
             WHERE c."userId" = e."userId" AND c."signalId" = e."signalId" AND c."kind" = 'CLOSE'
           )
       ) AS open
     FROM "signal"."CopyOrder" e WHERE e."userId" = $1`,
    [userId],
  );
  return { today: Number(rows[0]?.today ?? 0), open: Number(rows[0]?.open ?? 0) };
}

/**
 * Claim this (user, signal) pair, relying on the UNIQUE constraint.
 *
 * Inserting FIRST and letting the database reject a duplicate is what makes the
 * engine safe under concurrency: two ticks racing on the same signal cannot both
 * win, because the second insert violates the constraint. Checking-then-inserting
 * would leave a window between the two statements where both could pass.
 *
 * Returns the row id when claimed, or null when another tick already has it.
 */
async function claim(intent: OrderIntent, adapter: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `INSERT INTO "signal"."CopyOrder"
       ("userId","signalId","kind","symbol","side","quantity","status","adapter",
        "stopLoss","takeProfit","limitPrice","conviction","createdAt","updatedAt")
     VALUES ($1,$2,'ENTRY',$3,$4,$5,'PENDING_CONFIRM',$6,$7,$8,$9,$10,now(),now())
     ON CONFLICT ("userId","signalId","kind") DO NOTHING
     RETURNING "id"`,
    [
      intent.userId, intent.signalId, intent.symbol, intent.side, intent.quantity,
      adapter, intent.stopLoss, intent.takeProfit,
      // 0/NaN would be a nonsense limit — send null so the terminal falls back to
      // a market entry rather than resting an order at a price that can never fill.
      intent.referencePrice > 0 ? intent.referencePrice : null,
      intent.conviction,
    ],
  );
  return (rows[0]?.id as string | undefined) ?? null;
}

/**
 * Queue CLOSE orders for entries whose upstream signal is no longer open.
 *
 * Without this, copying only mirrors ENTRIES: when the trader exits, a subscriber
 * is left holding a position the signal provider has already abandoned. Their
 * stop/target would eventually take them out, but at a price the signal never
 * intended — and for a counter-signal product the whole thesis ends when the
 * trader is flat.
 *
 * Only entries we actually placed or queued are closed. Rejected, skipped and
 * expired ones never reached a broker, so there is nothing to flatten.
 *
 * A CLOSE means "this signal is over", NOT "you are holding something". Since
 * entries are worked as LIMIT orders, three states are possible by the time the
 * signal ends, and the terminal resolves whichever applies:
 *
 *   filled          -> flatten the position
 *   never filled    -> CANCEL the still-resting entry, so it cannot fill into a
 *                      trade that has already finished
 *   partially filled-> cancel the remainder AND flatten what did fill
 *
 * Keeping that decision at the far end is deliberate: only whoever holds the
 * position knows the fill state. On PULL that's the terminal; on PUSH it's the
 * broker's own cancel-and-flatten. Splitting this into separate CLOSE and CANCEL
 * instructions here would mean guessing that state from a distance and racing it.
 *
 * Idempotency comes from UNIQUE(userId, signalId, kind): exactly one CLOSE per
 * entry can ever exist, however many ticks race here.
 *
 * On a PUSH adapter the row is only the first half — sendPendingCloses() then
 * delivers it. The row is still written first so a crash between the two leaves
 * a durable "this must be closed" record that the next tick picks up.
 */
export async function queueCloses(openSignalIds: Set<string>, adapter: BrokerAdapter): Promise<CopyDecision[]> {
  const { rows } = await getPool().query(
    `SELECT "id","userId","signalId","symbol","side","quantity","conviction"
     FROM "signal"."CopyOrder" e
     WHERE e."kind" = 'ENTRY'
       -- PLACED/QUEUED = a real position exists.
       -- DRY_RUN = log-only mode, where a position WOULD exist — included so a dry
       -- run exercises the FULL lifecycle. Excluding it meant close bugs could only
       -- ever be discovered live.
       AND e."status" IN ('PLACED','QUEUED','DRY_RUN')
       AND NOT EXISTS (
         SELECT 1 FROM "signal"."CopyOrder" c
         WHERE c."userId" = e."userId" AND c."signalId" = e."signalId" AND c."kind" = 'CLOSE'
       )`,
  );

  const out: CopyDecision[] = [];
  for (const r of rows) {
    const signalId = r.signalId as string;
    if (openSignalIds.has(signalId)) continue; // still open upstream — leave it be

    // The CLOSE carries the ENTRY's own side. The terminal FLATTENS that position;
    // it must never send an opposite order blindly, which on an already-flat
    // account would open a brand-new reversed position.
    const { rows: ins } = await getPool().query(
      `INSERT INTO "signal"."CopyOrder"
         ("userId","signalId","kind","symbol","side","quantity","status","adapter","conviction","createdAt","updatedAt")
       VALUES ($1,$2,'CLOSE',$3,$4,$5,'QUEUED',$6,$7,now(),now())
       ON CONFLICT ("userId","signalId","kind") DO NOTHING
       RETURNING "id"`,
      [r.userId, signalId, r.symbol, r.side, Number(r.quantity), adapter.name, r.conviction],
    );
    if (ins[0]) out.push({ userId: r.userId as string, signalId, status: "QUEUED", reason: "close mirrored" });
  }

  // PULL stops here — the terminal collects the QUEUED row. PUSH has to send it.
  if (adapter.closeOrder) out.push(...(await sendPendingCloses(adapter)));
  return out;
}

/**
 * Deliver every close this adapter still owes (PUSH adapters only).
 *
 * A CLOSE row in QUEUED means "recorded but not yet sent", so this sweeps the
 * backlog rather than just the closes queued on this tick — that is what makes a
 * send failure, a dropped socket, or a restart mid-sweep recoverable: the row
 * stays QUEUED and the next tick retries it. Retrying is safe because flattening
 * an already-flat account is a no-op, so a duplicate send cannot open anything.
 *
 * The failure direction is inverted from entries on purpose. Everywhere else the
 * engine under-trades when uncertain; here, giving up leaves a live position the
 * trader has already exited, so an uncertain close is retried indefinitely rather
 * than retired. A close that keeps failing stays visible as QUEUED (never PLACED)
 * with the broker's own error in `reason`.
 */
async function sendPendingCloses(adapter: BrokerAdapter): Promise<CopyDecision[]> {
  const { rows } = await getPool().query(
    `SELECT "id","userId","signalId","symbol","side","quantity"
     FROM "signal"."CopyOrder"
     WHERE "kind" = 'CLOSE' AND "status" = 'QUEUED' AND "adapter" = $1
     ORDER BY "createdAt"`,
    [adapter.name],
  );

  const out: CopyDecision[] = [];
  const failures: string[] = [];

  for (const r of rows) {
    const userId = r.userId as string;
    const signalId = r.signalId as string;
    const close: CloseIntent = {
      signalId,
      userId,
      symbol: r.symbol as string,
      side: r.side as "LONG" | "SHORT",
      quantity: Number(r.quantity),
    };

    let error: string;
    try {
      const res = await adapter.closeOrder!(close);
      if (res.ok) {
        await finalize(r.id as string, "PLACED", res.brokerOrderId ?? null);
        out.push({ userId, signalId, status: "PLACED", reason: "close sent" });
        continue;
      }
      error = res.error ?? "broker rejected the close";
    } catch (err) {
      // One user's broken account must not strand every other subscriber's exit.
      error = (err as Error).message;
    }

    // Status stays QUEUED — this is a retry, not a resolution.
    await noteRetry(r.id as string, error);
    out.push({ userId, signalId, status: "QUEUED", reason: `close retrying: ${error}` });
    failures.push(error);
  }

  if (failures.length > 0) {
    console.warn(`[copy] ${failures.length} close(s) still unsent, will retry — ${failures[0]}`);
  }
  return out;
}

/** Record why a close hasn't gone out yet, WITHOUT retiring it. */
async function noteRetry(id: string, reason: string): Promise<void> {
  await getPool().query(
    `UPDATE "signal"."CopyOrder" SET "reason" = $2, "updatedAt" = now() WHERE "id" = $1`,
    [id, reason.slice(0, 500)],
  );
}

async function finalize(
  id: string,
  status: CopyStatus,
  brokerOrderId?: string | null,
  reason?: string,
): Promise<void> {
  await getPool().query(
    `UPDATE "signal"."CopyOrder"
     SET "status" = $2, "brokerOrderId" = $3, "reason" = $4, "updatedAt" = now()
     WHERE "id" = $1`,
    [id, status, brokerOrderId ?? null, reason ?? null],
  );
}

/** Record a signal we deliberately declined, so the UI can explain the gap. */
async function recordSkip(intent: OrderIntent, adapter: string, reason: string): Promise<void> {
  await getPool().query(
    `INSERT INTO "signal"."CopyOrder"
       ("userId","signalId","symbol","side","quantity","status","adapter","reason","conviction","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'SKIPPED',$6,$7,$8,now(),now())
     ON CONFLICT ("userId","signalId") DO NOTHING`,
    [intent.userId, intent.signalId, intent.symbol, intent.side, intent.quantity, adapter, reason, intent.conviction],
  );
}

/**
 * Evaluate every open signal for one subscriber.
 * Exported so tests can drive a single user deterministically.
 */
export async function processUser(
  userId: string,
  settings: CopySettings,
  signals: Signal[],
  adapter: BrokerAdapter,
  baseRiskDefault: number = DEFAULT_BASE_RISK,
): Promise<CopyDecision[]> {
  const out: CopyDecision[] = [];
  if (settings.mode === "off") return out;

  const access = await getUserAccess(userId);
  const visible = copyableSignals(access, userId, signals);
  // Oldest first: if the daily cap bites, the user gets the signals that fired
  // first rather than an arbitrary subset.
  const candidates = visible.slice().sort((a, b) => a.openedAt - b.openedAt);

  // The admin's per-day copy cap ALWAYS wins over the subscriber's own Max-per-day —
  // the subscriber can lower their limit but never raise past what the admin set.
  const maxPerDay =
    access.maxCopiesPerDay == null
      ? settings.maxPerDay
      : Math.min(settings.maxPerDay, access.maxCopiesPerDay);

  let usage = await usageFor(userId);

  for (const signal of candidates) {
    const mismatch = matchesCopyFilters(signal, settings);
    if (mismatch) {
      // Not recorded: a market the user never intended to trade isn't a "skip"
      // worth surfacing, and recording it would consume the idempotency slot.
      out.push({ userId, signalId: signal.id, status: "SKIPPED", reason: mismatch });
      continue;
    }

    // Size the trade to this conviction's target dollar risk — this account's base
    // risk × the signal's conviction (1..4), falling back to the global default base
    // when the subscriber hasn't set their own. Usually placed in micro contracts, so
    // the symbol/quantity here can differ from the mini the trader used. Unsizeable
    // (no stop to measure risk against) SKIPS, and deliberately does NOT record a row:
    // the trader's protective bracket can land a tick or two after entry, and a
    // recorded skip would block that signal forever through the
    // UNIQUE(userId,signalId,kind) guard.
    const base = settings.baseRisk ?? baseRiskDefault;
    const sized = sizeByRisk(signal, riskForConviction(base, signal.conviction));
    if (!sized) {
      out.push({ userId, signalId: signal.id, status: "SKIPPED", reason: "no stop — cannot size by risk" });
      continue;
    }

    const intent = toIntent(signal, userId, sized);

    // Check caps BEFORE claiming, so a full budget doesn't burn the slot — the
    // signal stays eligible if a position closes later in the session.
    if (usage.today >= maxPerDay) {
      const reason =
        access.maxCopiesPerDay != null && maxPerDay === access.maxCopiesPerDay
          ? `daily copy limit reached (admin cap ${access.maxCopiesPerDay})`
          : "daily copy limit reached";
      out.push({ userId, signalId: signal.id, status: "SKIPPED", reason });
      continue;
    }
    if (usage.open >= settings.maxConcurrent) {
      out.push({ userId, signalId: signal.id, status: "SKIPPED", reason: "max concurrent positions reached" });
      continue;
    }

    const id = await claim(intent, adapter.name);
    if (!id) continue; // already handled — the DB refused the duplicate

    // From here the slot is consumed either way, so every path must finalize.
    if (!(await adapter.isReady(userId))) {
      await finalize(id, "SKIPPED", null, "broker not connected");
      out.push({ userId, signalId: signal.id, status: "SKIPPED", reason: "broker not connected" });
      continue;
    }

    // 'confirm' stops here: prepared, awaiting the user's approval.
    if (settings.mode === "confirm") {
      usage = { today: usage.today + 1, open: usage.open + 1 };
      out.push({ userId, signalId: signal.id, status: "PENDING_CONFIRM" });
      continue;
    }

    try {
      const res = await adapter.placeOrder(intent);
      if (res.ok) {
        const status: CopyStatus = res.queued ? "QUEUED" : "PLACED";
        await finalize(id, status, res.brokerOrderId ?? null);
        usage = { today: usage.today + 1, open: usage.open + 1 };
        out.push({ userId, signalId: signal.id, status });
      } else {
        await finalize(id, "REJECTED", null, res.error ?? "broker rejected the order");
        out.push({ userId, signalId: signal.id, status: "REJECTED", reason: res.error });
      }
    } catch (err) {
      // An adapter that throws must not kill the tick for other users/signals.
      const msg = (err as Error).message;
      await finalize(id, "REJECTED", null, msg);
      out.push({ userId, signalId: signal.id, status: "REJECTED", reason: msg });
    }
  }

  return out;
}

/** One pass over every copy-enabled subscriber. Exported for tests. */
export async function runOnce(adapter: BrokerAdapter): Promise<CopyDecision[]> {
  if (!config.copyExecutionEnabled) return [];
  // The global DEFAULT base risk is loaded once per tick (not per user); each user
  // may still override it with their own account base (settings.baseRisk).
  const [users, signals, baseRiskDefault] = await Promise.all([
    listCopyUsers(),
    getActiveSignals(),
    getBaseRisk(),
  ]);

  // Demo signals must never reach a broker. They're synthesized for design work
  // and would place real orders against prices that were never quoted.
  const real = signals.filter((s) => !s.id.startsWith("demo-"));
  const out: CopyDecision[] = [];

  // CLOSES FIRST, and unconditionally — this must run even when there are no open
  // signals and no copy-enabled users left, because "no open signals" is exactly
  // the state in which everything previously entered needs closing. Returning
  // early on an empty list (as this did) is what would strand a subscriber in a
  // position after the trader went flat.
  try {
    out.push(...(await queueCloses(new Set(real.map((s) => s.id)), adapter)));
  } catch (err) {
    console.warn("[copy] close sweep failed:", (err as Error).message);
  }

  if (users.length === 0 || real.length === 0) return out;

  for (const { userId, settings } of users) {
    try {
      out.push(...(await processUser(userId, settings, real, adapter, baseRiskDefault)));
    } catch (err) {
      console.warn(`[copy] user ${userId} failed:`, (err as Error).message);
    }
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function startCopyEngine(adapter: BrokerAdapter): void {
  if (timer) return;
  if (!config.copyExecutionEnabled) {
    console.log("[copy] execution disabled (set AUTO_COPY_ENABLED=1 and COPY_EXECUTION=1 to enable) — engine not started");
    return;
  }
  console.log(`[copy] engine started (adapter: ${adapter.name}, every ${TICK_MS / 1000}s)`);
  timer = setInterval(() => {
    if (ticking) return; // never let ticks overlap — that's how doubles happen
    ticking = true;
    void runOnce(adapter)
      .then((decisions) => {
        const acted = decisions.filter((d) => d.status !== "SKIPPED");
        if (acted.length > 0) console.log(`[copy] ${acted.length} order(s) actioned`);
      })
      .catch((err) => console.warn("[copy] tick failed:", (err as Error).message))
      .finally(() => { ticking = false; });
  }, TICK_MS);
}

export function stopCopyEngine(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export { DAY_MS };
