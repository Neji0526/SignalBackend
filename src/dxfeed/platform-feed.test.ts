/* Platform feed parsing tests — pure, no network or DB.
 * Run: npx tsx src/dxfeed/platform-feed.test.ts
 */

import { inferTradeSide, symbolRoot } from "./platform-feed.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nplatform feed parsing\n");

// Real Bulk/TradesList shapes (quantity unsigned, no side field).
check("long winner", inferTradeSide({ quantity: 1, entryPrice: 7732, exitPrice: 7733, grossPl: 50 }) === "LONG");
check("long loser", inferTradeSide({ quantity: 3, entryPrice: 7758, exitPrice: 7757.5, grossPl: -75 }) === "LONG");
check("short winner", inferTradeSide({ quantity: 2, entryPrice: 7758, exitPrice: 7750, grossPl: 800 }) === "SHORT");
check("short loser", inferTradeSide({ quantity: 1, entryPrice: 7758, exitPrice: 7760, convertedGrossPl: -100 }) === "SHORT");
check("scratch uses quantity sign (short)", inferTradeSide({ quantity: -1, entryPrice: 100, exitPrice: 100, grossPl: 0 }) === "SHORT");
check("scratch defaults long", inferTradeSide({ quantity: 1, entryPrice: 100, exitPrice: 100, grossPl: 0 }) === "LONG");

check("root from contract.name", symbolRoot({ name: "MNQ", symbol: "/MNQZ26:XCME" }) === "MNQ");
check("root from display name", symbolRoot(null, "ES 12-2026") === "ES");
check("root from dashed name", symbolRoot(null, "ES-202612-CME") === "ES");
check("root from exchange symbol", symbolRoot({ symbol: "/GCZ26:XCOMEX" }) === "GC");

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
