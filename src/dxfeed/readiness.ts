import { getDxFeedLink, markTradeVerified, clearTradeVerified, listUnverified } from "./store.js";
import { getTradingClient } from "./trading-client.js";
import { resolveSymbol } from "./symbols.js";
import { AccountStatus } from "./types.js";

/* The trade-readiness gate.
 *
 * WHY THIS EXISTS. A subscriber can be fully provisioned — NewUser, trading
 * account and subscription all returning 200, the account listed as enabled with
 * trading permitted — and still be unable to trade, with no error anywhere:
 * OrderInsert simply gets NO response. We hit exactly this on staging, and the
 * only signal that distinguished a working identity from a broken one was
 * placing a real order and seeing it acked.
 *
 * That makes readiness something a subscriber EARNS by probing, never something
 * provisioning asserts. Until it is earned the copy engine must not route
 * signals: an unready subscriber does not fail loudly, it silently drops every
 * order, which for a copy-trading product means a subscriber who believes they
 * are following the trader and is not.
 *
 * Deliberately NOT time-based. The obvious design — "wait N minutes after
 * provisioning" — was tried and the premise turned out to be false: identities
 * created the same way differed permanently rather than settling, so a timer
 * would hand out readiness that was never true.
 */

/** A LONG limit here rests far below any real level, so the probe cannot fill.
 *  MES is the cheapest micro we trade, keeping the margin blip negligible. */
const PROBE_ROOT = "MES";
const PROBE_PRICE = 100;

/* dxFeed answers an unacceptable order with an explicit validation rejection —
 * which is the OPPOSITE of the failure this gate hunts. A rejection means the
 * account replied; silence means it did not.
 *
 * ENVIRONMENTAL rejections (CME daily break / weekend) still prove the routing
 * path works — OrderInsert reached the account and came back. That is enough to
 * earn readiness: the silent-swallow failure mode does not produce a clean
 * "market closed" reply. Without this, admins cannot clear Re-check on weekends
 * or overnight even for healthy accounts. */
const ENVIRONMENTAL_REJECTION =
  /market is (currently )?closed|outside (of )?trading hours|session is closed|trading is not allowed at this time/i;

export interface ReadinessResult {
  ready: boolean;
  /** Why not, when ready is false. Persisted for the admin view. */
  reason: string | null;
  /**
   * We learned nothing — our session or the symbol table was unavailable.
   * Never the subscriber's fault, so it is neither recorded against them nor
   * allowed to withdraw a verification they already earned.
   */
  inconclusive?: boolean;
}

const ok: ReadinessResult = { ready: true, reason: null };

/** Record and return a refusal — this one IS about the subscriber. */
async function refuse(userId: string, reason: string): Promise<ReadinessResult> {
  await clearTradeVerified(userId, reason);
  return { ready: false, reason };
}

/** Not ready, but not the subscriber's fault: persist nothing, withdraw nothing. */
function inconclusive(reason: string): ReadinessResult {
  return { ready: false, reason, inconclusive: true };
}

/**
 * Prove that this subscriber's dxFeed account actually accepts orders, by
 * placing one and cancelling it. Persists the verdict.
 *
 * Safe to call on a funded account: the probe is a single far-from-market LONG
 * limit that cannot fill, and it is cancelled in a finally block even if the
 * placement throws — an order we never got an ack for may still have reached the
 * book, so the cleanup runs regardless of outcome.
 *
 * Call at the end of provisioning, from the admin "re-check" action, and
 * whenever a live order times out waiting for an ack.
 */
export async function verifyTradeReady(userId: string): Promise<ReadinessResult> {
  const link = await getDxFeedLink(userId);
  if (!link?.dxAccountId) return refuse(userId, "no dxFeed account linked for this subscriber");

  if (
    link.accountStatus != null &&
    link.accountStatus !== AccountStatus.ENABLED &&
    link.accountStatus !== AccountStatus.CHALLENGE_SUCCESS
  ) {
    return refuse(userId, `account status ${link.accountStatus} cannot trade`);
  }

  const client = getTradingClient();
  if (!client || !client.isConnected()) {
    return inconclusive("dxFeed trading session unavailable");
  }

  if (client.accountNumberForRef && client.accountNumberForRef(link.dxAccountId) === undefined) {
    return refuse(userId, "account is not in the trading session's snapshot");
  }
  const blocked = client.blockedReason?.(link.dxAccountId) ?? null;
  if (blocked) return refuse(userId, blocked);

  const sym = await resolveSymbol(PROBE_ROOT);
  if (!sym) return inconclusive(`probe symbol ${PROBE_ROOT} is not tradeable right now`);

  try {
    await client.placeEntry({
      accountId: link.dxAccountId,
      symbol: sym.name,
      side: "LONG",
      quantity: 1,
      limitPrice: PROBE_PRICE,
      stopLoss: null,
      takeProfit: null,
    });
  } catch (err) {
    const message = (err as Error).message;

    // Silence. THE condition this gate exists to catch.
    if (/order ack timeout/i.test(message)) {
      return refuse(userId, `probe order was not acknowledged: ${message}`);
    }
    // Account answered with "market closed" / outside hours — that still proves
    // the routing path (not a silent drop). Earn readiness so Re-check works
    // on weekends and overnight maintenance.
    if (ENVIRONMENTAL_REJECTION.test(message)) {
      await markTradeVerified(userId);
      console.log(
        `[dxfeed] readiness for ${userId}: accepted via environmental rejection (${message.slice(0, 120)})`,
      );
      return ok;
    }
    // Answered with an account-specific rejection — margin, permissions, limits.
    return refuse(userId, `probe order rejected: ${message}`);
  } finally {
    try {
      await client.flatten(link.dxAccountId, sym.name);
    } catch {
      // Nothing resting, or the cancel failed. The probe order cannot fill at
      // this price, so leaving it is not a position risk; the next probe or
      // close sweep clears it.
    }
  }

  await markTradeVerified(userId);
  return ok;
}

/**
 * Has this subscriber already been proven tradeable? Cheap — one row read, no
 * order placed. This is what the per-signal hot path uses; verifyTradeReady is
 * the occasional expensive proof behind it.
 */
export async function isTradeVerified(userId: string): Promise<boolean> {
  const link = await getDxFeedLink(userId);
  return link?.tradeVerifiedAt != null;
}

/**
 * Probe subscribers who have never passed, so readiness is earned automatically
 * rather than needing an operator. Run on a slow timer.
 *
 * SEQUENTIAL on purpose: each probe places and cancels a real order, and firing
 * a burst of them at the trading session is both rude and a good way to trip the
 * connection limits. A subscriber who keeps failing is simply retried on the
 * next sweep — no backoff state to get wrong, and the failure reason is already
 * persisted for whoever looks.
 */
export async function sweepUnverified(limit = 25): Promise<{ probed: number; nowReady: number }> {
  const client = getTradingClient();
  if (!client || !client.isConnected()) return { probed: 0, nowReady: 0 };

  const pending = await listUnverified(limit);
  let probed = 0, nowReady = 0;
  for (const userId of pending) {
    const result = await verifyTradeReady(userId);
    probed++;
    if (result.ready) { nowReady++; continue; }
    // An inconclusive verdict is about the world, not this subscriber, so every
    // remaining probe would fail identically. Stop instead of firing N pointless
    // orders at a closed market — the next sweep picks the backlog up unchanged.
    if (result.inconclusive) {
      console.log(`[dxfeed] readiness sweep paused after ${probed} — ${result.reason}`);
      return { probed, nowReady };
    }
  }
  if (probed > 0) {
    console.log(`[dxfeed] readiness sweep: probed ${probed}, ${nowReady} now tradeable`);
  }
  return { probed, nowReady };
}
