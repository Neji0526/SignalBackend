import { getPool, closePool } from "../db/pool.js";
import { applySchema } from "../db/apply-schema.js";
import { upsertDxFeedLink, getDxFeedLink, deleteDxFeedLink, markTradeVerified } from "./store.js";
import { verifyTradeReady, isTradeVerified, sweepUnverified } from "./readiness.js";
import { setTradingClient, type DxTradingClient, type DxEntryOrder } from "./trading-client.js";
import { DxFeedAdapter } from "./adapter.js";
import { resolveSymbol } from "./symbols.js";
import { AccountStatus } from "./types.js";

/* The trade-readiness gate.
 *
 * The property under test is "an unproven subscriber is never traded", and its
 * mirror, "a subscriber whose orders start vanishing stops being traded". Both
 * matter because the failure they guard against is SILENT — dxFeed accepts the
 * connection, lists the account as enabled, and then ignores OrderInsert.
 *
 * The failure paths run entirely offline. The two paths that actually place a
 * probe need the symbol table (a cached call to the Propfirm API), so they are
 * skipped with a message when it is unavailable rather than failing the run. */

let passed = 0, failed = 0, skipped = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};
const skip = (name: string, why: string): void => { skipped++; console.log(`  SKIP  ${name} — ${why}`); };

interface FakeOpts {
  connected?: boolean; known?: boolean; blocked?: string | null;
  ackFails?: boolean; rejectWith?: string;
}

class FakeClient implements DxTradingClient {
  placed = 0; flattened = 0; attempts = 0;
  constructor(private readonly o: FakeOpts = {}) {}
  isConnected(): boolean { return this.o.connected ?? true; }
  async placeEntry(_order: DxEntryOrder): Promise<{ brokerOrderId: string }> {
    this.attempts++;
    if (this.o.ackFails) throw new Error("order ack timeout");
    if (this.o.rejectWith) throw new Error(`dxFeed rejected the order: ${this.o.rejectWith}`);
    this.placed++;
    return { brokerOrderId: `FAKE-${this.placed}` };
  }
  async flatten(): Promise<void> { this.flattened++; }
  accountNumberForRef(): number | undefined { return (this.o.known ?? true) ? 14540 : undefined; }
  blockedReason(): string | null { return this.o.blocked ?? null; }
}

async function mkSubscriber(pool: ReturnType<typeof getPool>, tag: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO "signal"."User" ("email","passwordHash","name","role","status")
     VALUES ($1,'x','Readiness Test','SUBSCRIBER','ACTIVE') RETURNING "id"`,
    [`readiness-${tag}-${Date.now()}@example.com`],
  );
  const userId = rows[0].id as string;
  await upsertDxFeedLink({
    userId, dxUserId: `dx-${tag}`, dxAccountId: `acct-${tag}-${Date.now()}`,
    dxSubscriptionId: "sub-1", accountStatus: AccountStatus.ENABLED,
    subscriptionStatus: 1, agreementSigned: true, agreementLink: null, platform: 0,
  });
  return userId;
}

async function main(): Promise<void> {
  await applySchema();
  const pool = getPool();
  const adapter = new DxFeedAdapter();
  const created: string[] = [];
  const sub = async (tag: string): Promise<string> => {
    const id = await mkSubscriber(pool, tag);
    created.push(id);
    return id;
  };

  try {
    console.log("\nreadiness gate\n");

    // --- the core property: unproven means untraded -------------------------
    {
      const userId = await sub("a");
      setTradingClient(new FakeClient());
      check("a fresh subscriber is NOT ready, however healthy everything looks",
        (await adapter.isReady(userId)) === false);
      check("and is not recorded as verified", (await isTradeVerified(userId)) === false);
    }

    // --- refusals that need no probe ----------------------------------------
    {
      const userId = await sub("b");
      setTradingClient(new FakeClient({ known: false }));
      const r = await verifyTradeReady(userId);
      check("an account missing from the session snapshot is refused", r.ready === false);
      check("with a reason naming the snapshot", /snapshot/i.test(r.reason ?? ""), r.reason ?? "");
    }
    {
      const userId = await sub("c");
      setTradingClient(new FakeClient({ blocked: "account is read-only" }));
      const r = await verifyTradeReady(userId);
      check("a blocked account is refused", r.ready === false);
      check("with the session's own reason", r.reason === "account is read-only", r.reason ?? "");
      const link = await getDxFeedLink(userId);
      check("the reason is persisted for the admin view", link?.tradeProbeError === "account is read-only");
    }

    // --- our own session being down must not punish the subscriber ----------
    {
      const userId = await sub("d");
      await markTradeVerified(userId);
      setTradingClient(new FakeClient({ connected: false }));
      const r = await verifyTradeReady(userId);
      check("a down session reports not-ready", r.ready === false);
      check("but does NOT withdraw an already-earned verification",
        (await isTradeVerified(userId)) === true);
    }

    // --- provisioning must never be able to confer readiness ----------------
    {
      const userId = await sub("e");
      await markTradeVerified(userId);
      const link = await getDxFeedLink(userId);
      await upsertDxFeedLink({ ...link!, accountStatus: AccountStatus.ENABLED });
      check("a re-provision does not clobber the earned verification",
        (await isTradeVerified(userId)) === true);
    }

    // --- paths that place a real probe --------------------------------------
    const symbolsUp = (await resolveSymbol("MES").catch(() => null)) != null;

    if (!symbolsUp) {
      skip("a probe that is acked marks the subscriber ready", "symbol table unavailable");
      skip("a probe that is ignored refuses and records why", "symbol table unavailable");
      skip("a live ack timeout withdraws readiness", "symbol table unavailable");
      skip("the sweep promotes an unverified subscriber", "symbol table unavailable");
    } else {
      {
        const userId = await sub("f");
        const client = new FakeClient();
        setTradingClient(client);
        const r = await verifyTradeReady(userId);
        check("a probe that is acked marks the subscriber ready", r.ready === true, r.reason ?? "");
        check("the probe order was cancelled afterwards", client.flattened === 1);
        check("and the subscriber is now tradeable", (await adapter.isReady(userId)) === true);
      }
      {
        const userId = await sub("g");
        const client = new FakeClient({ ackFails: true });
        setTradingClient(client);
        const r = await verifyTradeReady(userId);
        check("a probe that is ignored refuses", r.ready === false);
        check("with a reason naming the missing ack", /not acknowledged/i.test(r.reason ?? ""), r.reason ?? "");
        check("the probe order is cancelled even when it was never acked", client.flattened === 1);
        check("and the subscriber stays untradeable", (await adapter.isReady(userId)) === false);
      }
      {
        // The regression case: verified, then live orders start vanishing.
        const userId = await sub("h");
        setTradingClient(new FakeClient());
        await verifyTradeReady(userId);
        check("verified before the regression", (await isTradeVerified(userId)) === true);

        setTradingClient(new FakeClient({ ackFails: true }));
        const res = await adapter.placeOrder({
          userId, symbol: "MES", side: "LONG", quantity: 1,
          referencePrice: 100, stopLoss: null, takeProfit: null,
        } as Parameters<typeof adapter.placeOrder>[0]);
        check("the live order is reported failed", res.ok === false);
        check("a live ack timeout withdraws readiness", (await isTradeVerified(userId)) === false);
        check("so the engine stops routing there", (await adapter.isReady(userId)) === false);
      }
      // A rejection is the OPPOSITE of silence — the account answered. An
      // environmental "market closed" reply still proves routing works, so we
      // earn readiness (otherwise Re-check can never pass on weekends).
      {
        const userId = await sub("j");
        setTradingClient(new FakeClient({ rejectWith: "Market is currently closed" }));
        const r = await verifyTradeReady(userId);
        check("a closed-market rejection still earns readiness", r.ready === true, r.reason ?? "");
        check("it is not inconclusive", r.inconclusive !== true);
        check("tradeVerifiedAt is set", (await isTradeVerified(userId)) === true);
        check("nothing is recorded as a probe error",
          (await getDxFeedLink(userId))?.tradeProbeError == null);
      }
      {
        // An earned verification must survive a later closed-market re-check too.
        const userId = await sub("j2");
        await markTradeVerified(userId);
        setTradingClient(new FakeClient({ rejectWith: "Market is currently closed" }));
        const r = await verifyTradeReady(userId);
        check("re-check while closed keeps them ready", r.ready === true);
        check("and an earned verification survives a closed market",
          (await isTradeVerified(userId)) === true);
      }
      {
        // An account-specific rejection IS about them, and must stick.
        const userId = await sub("k");
        setTradingClient(new FakeClient({ rejectWith: "Insufficient margin" }));
        const r = await verifyTradeReady(userId);
        check("an account-specific rejection refuses", r.ready === false && !r.inconclusive);
        check("and is recorded", /Insufficient margin/.test(
          (await getDxFeedLink(userId))?.tradeProbeError ?? ""));
      }
      {
        const userId = await sub("i");
        setTradingClient(new FakeClient());
        const before = await isTradeVerified(userId);
        const result = await sweepUnverified(50);
        check("the sweep probes unverified subscribers", before === false && result.probed > 0);
        check("the sweep promotes an unverified subscriber", (await isTradeVerified(userId)) === true);
      }
      {
        // Closed market still earns readiness — sweep can promote overnight.
        await sub("l"); await sub("m"); await sub("n");
        const client = new FakeClient({ rejectWith: "Market is currently closed" });
        setTradingClient(client);
        const result = await sweepUnverified(50);
        check("the sweep promotes on closed-market acks", result.nowReady >= 1, `nowReady ${result.nowReady}`);
        check("and probes more than one when each earns ready", result.probed >= 1, `probed ${result.probed}`);
      }
    }

    console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
  } finally {
    setTradingClient(null);
    for (const id of created) {
      await deleteDxFeedLink(id);
      await pool.query(`DELETE FROM "signal"."User" WHERE "id" = $1`, [id]);
    }
    await closePool();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("\nreadiness test failed:", err, "\n"); process.exit(1); });
