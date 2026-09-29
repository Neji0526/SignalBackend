/* Live smoke test for the platform trade feed (READ-ONLY — never places an order).
 * Pulls the open-position snapshot and one day of closed trades from the Propfirm
 * API and prints what would become signals.
 * Run: npx tsx src/dxfeed/platform-feed.smoke.ts
 */

import { propfirm } from "./propfirm.js";
import { getPlatformPositions, inferTradeSide, startPlatformFeed, stopPlatformFeed, symbolRoot } from "./platform-feed.js";

async function main(): Promise<void> {
  startPlatformFeed();
  await new Promise((r) => setTimeout(r, 6_000));
  const open = getPlatformPositions();
  console.log(`\nopen platform positions: ${open.length}`);
  for (const p of open) {
    console.log(`  ${p.symbol} ${p.side} x${p.quantity} @ ${p.entry}  stop=${p.traderStop ?? "—"} target=${p.traderTarget ?? "—"}  openPl=${p.traderOpenPl ?? "—"}`);
  }
  stopPlatformFeed();

  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86_400_000);
  const page = await propfirm.bulkTradesList(start, end);
  const rows = Object.entries(page.data).flatMap(([acct, trades]) => trades.map((t) => ({ acct, t })));
  console.log(`\nclosed platform trades (7d): ${rows.length}`);
  for (const { acct, t } of rows.slice(0, 10)) {
    console.log(`  ${acct.slice(0, 8)} ${symbolRoot(t.contract, t.symbolName)} trader ${inferTradeSide(t)} x${t.quantity} ${t.entryPrice} → ${t.exitPrice}  pl=${t.convertedGrossPl ?? t.grossPl}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
