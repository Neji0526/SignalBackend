import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { config, dxfeedReady } from "../config.js";
import { register, login, verifyToken, getUserById, setUserPassword, type TokenPayload } from "../auth/service.js";
import { getSignals, getSignalsRange, getMirrorSignals } from "../signals/source.js";
import { getLink, connect as connectBroker, disconnect as disconnectBroker } from "../broker/links.js";
import { brokerCryptoReady } from "../broker/crypto.js";
import { getCopySettings, updateCopySettings, sanitizeCopySettings } from "../broker/copy-settings.js";
import { getBaseRisk, setBaseRisk } from "../broker/risk-config.js";
import { handleDxFeedWebhook } from "../dxfeed/webhook.js";
import { listReadiness, getDxFeedLink } from "../dxfeed/store.js";
import { verifyTradeReady } from "../dxfeed/readiness.js";
import { provisionSubscriber } from "../dxfeed/provision.js";
import { collect, acknowledge, recentOrders } from "../broker/queue.js";
import { getPerformance } from "../signals/performance.js";
import {
  applyAccess,
  getUserAccess,
  listUsersWithAccess,
  updateUserAccess,
  setUserStatus,
  sanitizeAccess,
  DEFAULT_ACCESS,
} from "../access/access.js";

/* Combined REST + WebSocket server for the signal app. Auth is fully separate
   from the trading platform (own JWT). Live signals are pushed over /ws by
   polling the shared DB and broadcasting on change (upgradeable to a direct
   TradingBackend WS relay / Postgres LISTEN-NOTIFY later). */

function cors(req: IncomingMessage, res: ServerResponse) {
  // CORS_ORIGIN may be "*" (any), a single origin, or a comma-separated allowlist
  // (e.g. the Vercel production domain + preview URLs). We reflect the request's
  // Origin when it's allowed so the browser accepts the response.
  const origin = req.headers.origin;
  const allow = config.corsOrigin.trim();
  let allowOrigin = "*";
  if (allow !== "*") {
    const list = allow.split(",").map((s) => s.trim()).filter(Boolean);
    allowOrigin = origin && list.includes(origin) ? origin : (list[0] ?? "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  // PUT/PATCH are needed by the admin access editor; without them its preflight fails.
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data || "{}") as T); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

function requireUser(req: IncomingMessage): TokenPayload | null {
  return verifyToken(bearer(req) ?? "");
}

/** Parse a ms-timestamp query param. `0` is meaningful (all time), so test presence. */
function msParam(url: URL, p: string): number | undefined {
  const raw = url.searchParams.get(p);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Verify the caller is an ADMIN (role checked against the DB, not just the token). */
async function requireAdmin(req: IncomingMessage): Promise<TokenPayload | null> {
  const payload = requireUser(req);
  if (!payload) return null;
  const user = await getUserById(payload.sub);
  return user && user.role === "ADMIN" ? payload : null;
}

export function createSignalServer() {
  const http = createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((err) => {
      console.error("[server] handler error:", (err as Error).message);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    });
  });

  // --- WebSocket: broadcast the live signal set on change, filtered per user ---
  // Each connection carries the subscriber's id (?token=…). The base signal set is
  // computed once per tick; each client receives it through THEIR access config, so
  // a NQ-only user never sees ES over the socket. Unauthenticated sockets get the
  // default (all) view but the REST endpoints remain the authoritative, gated path.
  const wss = new WebSocketServer({ server: http, path: "/ws" });
  const uidOf = (ws: WebSocket): string | null => (ws as WebSocket & { _uid?: string | null })._uid ?? null;
  const sendFiltered = async (ws: WebSocket, signals: Awaited<ReturnType<typeof getSignals>>) => {
    const uid = uidOf(ws);
    const access = uid ? await getUserAccess(uid) : DEFAULT_ACCESS;
    ws.send(JSON.stringify({ type: "signals", data: applyAccess(signals, access) }));
  };
  let lastHash = "";
  let ticking = false;
  const broadcast = async () => {
    if (wss.clients.size === 0 || ticking) return;
    ticking = true; // a slow upstream mark must not let ticks pile up on each other
    try {
      // Must match what the Signals page fetched over REST (`all=1`). Pushing the
      // 24h set here would silently replace the all-time list on the first frame
      // and make the Closed count jump seconds after load.
      const signals = await getMirrorSignals();
      // P&L is part of the identity of a live signal: the admin Positions page marks
      // open trades to market ~1s, and the mirror has to move with it. Leaving
      // unrealizedPnl out of the hash meant an open signal's P&L froze until its
      // bracket or status changed.
      const hash = JSON.stringify(
        signals.map((s) => [s.id, s.status, s.exit, s.stopLoss, s.takeProfit, s.unrealizedPnl, s.pnl]),
      );
      if (hash === lastHash) return;
      lastHash = hash;
      for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) await sendFiltered(c, signals);
    } catch (err) {
      console.warn("[ws] broadcast failed:", (err as Error).message);
    } finally {
      ticking = false;
    }
  };
  // ~1s to track the admin Positions page's own mark-to-market cadence. The hash
  // check keeps an idle feed silent, and `ticking` guards against overlap.
  const timer = setInterval(() => void broadcast(), 1000);
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const payload = verifyToken(url.searchParams.get("token") ?? "");
    (ws as WebSocket & { _uid?: string | null })._uid = payload?.sub ?? null;
    void getMirrorSignals().then((signals) => sendFiltered(ws, signals)).catch(() => {});
  });
  http.on("close", () => clearInterval(timer));

  return http;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/health") return json(res, 200, { status: "ok", service: "signal-backend" });

  // --- auth ---
  if (path === "/api/auth/register" && req.method === "POST") {
    const body = await readJson<{ email?: string; password?: string; name?: string }>(req);
    const result = await register(body?.email ?? "", body?.password ?? "", body?.name);
    if ("error" in result) return json(res, 400, result);
    return json(res, 200, result);
  }
  if (path === "/api/auth/login" && req.method === "POST") {
    const body = await readJson<{ email?: string; password?: string }>(req);
    const result = await login(body?.email ?? "", body?.password ?? "");
    if ("error" in result) return json(res, 401, result);
    return json(res, 200, result);
  }
  if (path === "/api/auth/me" && req.method === "GET") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    const user = await getUserById(payload.sub);
    if (!user) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, { user });
  }

  // --- signals (auth required, gated by the caller's access) ---
  if (path === "/api/signals" && req.method === "GET") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    // An explicit since/until window (the chart's calendar) wins over the rolling
    // `hours` window used by the Signals page.
    const since = msParam(url, "since");
    const until = msParam(url, "until");
    // `all=1` = the admin-Positions mirror: every closed signal (capped), not a
    // rolling window. Without it the Signals page and the admin page disagree.
    const all = url.searchParams.get("all") === "1";
    const hours = Number(url.searchParams.get("hours")) || config.signalWindowHours;
    const [signals, access] = await Promise.all([
      since != null || until != null
        ? getSignalsRange(since ?? 0, until)
        : all
          ? getMirrorSignals()
          : getSignals(hours),
      getUserAccess(payload.sub),
    ]);
    return json(res, 200, applyAccess(signals, access));
  }
  if (path === "/api/performance" && req.method === "GET") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    const market = url.searchParams.get("market") || undefined;
    // `since=0` is meaningful (all time), so parse by presence — not truthiness.
    const ms = (p: string) => {
      const raw = url.searchParams.get(p);
      if (raw == null || raw === "") return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const access = await getUserAccess(payload.sub);
    return json(res, 200, await getPerformance({ sinceMs: ms("since"), untilMs: ms("until"), market, access }));
  }

  // --- admin (ADMIN role required) ---
  if (path === "/api/admin/users" && req.method === "GET") {
    if (!(await requireAdmin(req))) return json(res, 403, { error: "forbidden" });
    return json(res, 200, await listUsersWithAccess());
  }
  if (path.startsWith("/api/admin/users/") && (req.method === "PUT" || req.method === "PATCH")) {
    if (!(await requireAdmin(req))) return json(res, 403, { error: "forbidden" });
    const id = decodeURIComponent(path.slice("/api/admin/users/".length).split("/")[0] ?? "");
    if (!id) return json(res, 400, { error: "missing user id" });
    const body = await readJson<{ access?: unknown; status?: string; password?: string }>(req);
    if (body?.access !== undefined) await updateUserAccess(id, sanitizeAccess(body.access));
    if (body?.status === "ACTIVE" || body?.status === "SUSPENDED") await setUserStatus(id, body.status);
    if (body?.password) {
      const result = await setUserPassword(id, body.password);
      if ("error" in result) return json(res, 400, result);
    }
    return json(res, 200, { ok: true });
  }

  // Global DEFAULT base risk per trade that drives copy position sizing. Risk on a
  // signal = base × its conviction (1..4); per-account overrides live in copy settings.
  if (path === "/api/admin/risk-config" && req.method === "GET") {
    if (!(await requireAdmin(req))) return json(res, 403, { error: "forbidden" });
    return json(res, 200, { baseRisk: await getBaseRisk() });
  }
  if (path === "/api/admin/risk-config" && (req.method === "PUT" || req.method === "POST")) {
    if (!(await requireAdmin(req))) return json(res, 403, { error: "forbidden" });
    const body = await readJson<unknown>(req);
    return json(res, 200, { baseRisk: await setBaseRisk(body) }); // sanitized inside
  }

  /* dxFeed trade readiness.
   *
   * A subscriber can be fully provisioned and still have their orders silently
   * ignored, so the copy engine only routes to accounts proven by a probe. That
   * makes "who is not tradeable, and why" an operational question someone has to
   * be able to answer — hence this view, and a manual re-check for when the
   * cause has been fixed and waiting for the 5-minute sweep is not good enough. */
  if (path === "/api/admin/dxfeed/readiness" && req.method === "GET") {
    if (!(await requireAdmin(req))) return json(res, 403, { error: "forbidden" });
    // The adapter is reported so the UI can stay hidden entirely on the ATAS
    // pull deployment, where "not provisioned at dxFeed" is true of everyone and
    // means nothing.
    const adapter = (process.env.EXECUTION_ADAPTER ?? "atas").toLowerCase() === "dxfeed" ? "dxfeed" : "atas";
    return json(res, 200, { adapter, rows: await listReadiness() });
  }
  /* Create this subscriber's dxFeed identity (user -> trading account ->
   * subscription). An ADMIN ACTION on purpose: it creates a real trading account
   * at the prop firm, which is not something a self-serve registration should
   * trigger. Idempotent — provisionSubscriber() resumes a partial run and is a
   * no-op on an already-provisioned subscriber. */
  if (path.startsWith("/api/admin/dxfeed/provision/") && req.method === "POST") {
    if (!(await requireAdmin(req))) return json(res, 403, { error: "forbidden" });
    if (!dxfeedReady) return json(res, 503, { error: "dxFeed is not configured (DXFEED_API_KEY is unset)." });
    const id = decodeURIComponent(path.slice("/api/admin/dxfeed/provision/".length).split("/")[0] ?? "");
    if (!id) return json(res, 400, { error: "missing user id" });
    try {
      return json(res, 200, await provisionSubscriber(id));
    } catch (e) {
      // Surface dxFeed's own message — "which subscriber and why" is the whole
      // value here, and a bare 500 would send someone to the server logs.
      return json(res, 502, { error: (e as Error).message });
    }
  }

  if (path.startsWith("/api/admin/dxfeed/readiness/") && req.method === "POST") {
    if (!(await requireAdmin(req))) return json(res, 403, { error: "forbidden" });
    const id = decodeURIComponent(path.slice("/api/admin/dxfeed/readiness/".length).split("/")[0] ?? "");
    if (!id) return json(res, 400, { error: "missing user id" });
    // Places a real order (far from market so it cannot fill, and cancelled
    // straight after), so this is a deliberate admin action — never something a
    // page load or a GET could trigger.
    const result = await verifyTradeReady(id);
    return json(res, 200, result);
  }

  // --- broker link (Tradovate), one account per subscriber ---
  if (path === "/api/broker" && req.method === "GET") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, await getLink(payload.sub));
  }
  if (path === "/api/broker/connect" && req.method === "POST") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    // Without an encryption key we would have to store the password in plaintext.
    // Refuse instead — a broker password is not something to "temporarily" expose.
    if (!brokerCryptoReady()) return json(res, 503, { error: "Broker connections are disabled: BROKER_ENC_KEY is not configured." });
    const body = await readJson<{ username?: string; password?: string; cid?: string; sec?: string; env?: string }>(req);
    const username = body?.username?.trim() ?? "";
    const password = body?.password ?? "";
    const cid = body?.cid?.trim() ?? "";
    const sec = body?.sec?.trim() ?? "";
    if (!username || !password || !cid || !sec) {
      return json(res, 400, { error: "username, password, cid and sec are all required" });
    }
    // Anything other than an explicit "live" is treated as demo.
    const env = body?.env === "live" ? "live" : "demo";
    try {
      return json(res, 200, await connectBroker(payload.sub, { username, password, cid, sec, env }));
    } catch (err) {
      // Surface Tradovate's own wording (bad credentials, rate limit) — a generic
      // failure here is impossible for the user to act on.
      return json(res, 400, { error: (err as Error).message });
    }
  }
  if (path === "/api/broker/disconnect" && req.method === "POST") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    await disconnectBroker(payload.sub);
    return json(res, 200, { ok: true });
  }

  // --- dxFeed webhook (dxFeed → us; authenticated by the x-api-key header) ---
  if (path === "/api/dxfeed/webhook" && req.method === "POST") {
    const key = req.headers["x-api-key"];
    const body = await readJson<unknown>(req);
    const r = await handleDxFeedWebhook(Array.isArray(key) ? key[0] : key, body);
    return json(res, r.status, { ok: r.status === 200, note: r.note });
  }

  // --- auto-copy settings ---
  /* Why a plain-language reason and not the raw probe error: this is read by the
   * SUBSCRIBER, who cannot act on "AccountReferenceId not in session snapshot".
   * What they need to know is whether their signals are being traded, and who
   * fixes it if not — every branch here is something support can act on. */
  async function tradeReadinessFor(userId: string): Promise<{ tradeReady: boolean | null; tradeBlockedReason: string | null }> {
    if ((process.env.EXECUTION_ADAPTER ?? "atas").toLowerCase() !== "dxfeed") {
      return { tradeReady: null, tradeBlockedReason: null };
    }
    const link = await getDxFeedLink(userId);
    if (link?.tradeVerifiedAt != null) return { tradeReady: true, tradeBlockedReason: null };
    return {
      tradeReady: false,
      tradeBlockedReason: !link?.dxAccountId
        ? "Your trading account hasn't been set up yet. We'll email you as soon as it is."
        : "Your account is still being checked — we place a test order before copying anything to it. This usually clears within a few minutes of the market being open.",
    };
  }

  if (path === "/api/copy/settings" && req.method === "GET") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    const s = await getCopySettings(payload.sub);
    // Show the EFFECTIVE base in the settings UI: an account that hasn't set its own
    // base inherits the global default, so surface that concrete number rather than a
    // blank. The engine reads the raw (possibly null) value straight from the DB.
    if (s.baseRisk == null) s.baseRisk = await getBaseRisk();
    const adapter = (process.env.EXECUTION_ADAPTER ?? "atas").toLowerCase() === "dxfeed" ? "dxfeed" : "atas";
    /* Terminal-setup credentials (backend URL, ATAS paste fields) are ADMIN-only
     * and only meaningful on the ATAS pull deployment. Subscribers on dxFeed
     * never need them; exposing the production API origin to every subscriber
     * is unnecessary surface area. */
    const dbUser = await getUserById(payload.sub);
    const showTerminalSetup = adapter === "atas" && dbUser?.role === "ADMIN";
    return json(res, 200, {
      ...s,
      ...(await tradeReadinessFor(payload.sub)),
      executionAdapter: adapter,
      showTerminalSetup,
    });
  }
  if (path === "/api/copy/settings" && (req.method === "PUT" || req.method === "POST")) {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    const body = await readJson<unknown>(req);
    const clean = sanitizeCopySettings(body);
    // Turning copying ON is meaningless while the server-wide switch is off —
    // say so rather than letting the user believe trades will be placed.
    if (clean.mode !== "off" && !config.copyExecutionEnabled) {
      return json(res, 503, { error: "Automated copying is disabled on this server (COPY_EXECUTION is not set)." });
    }
    await updateCopySettings(payload.sub, clean);
    const adapter = (process.env.EXECUTION_ADAPTER ?? "atas").toLowerCase() === "dxfeed" ? "dxfeed" : "atas";
    const dbUser = await getUserById(payload.sub);
    const showTerminalSetup = adapter === "atas" && dbUser?.role === "ADMIN";
    if (clean.baseRisk == null) clean.baseRisk = await getBaseRisk();
    return json(res, 200, {
      ...clean,
      ...(await tradeReadinessFor(payload.sub)),
      executionAdapter: adapter,
      showTerminalSetup,
    });
  }
  if (path === "/api/copy/orders" && req.method === "GET") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, await recentOrders(payload.sub));
  }

  // --- pull queue: called by the subscriber's own terminal strategy ---
  // COLLECT is destructive (it claims the orders), so it is POST, not GET — a
  // retried GET or an over-eager HTTP cache must never consume the queue.
  if (path === "/api/copy/collect" && req.method === "POST") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, { orders: await collect(payload.sub) });
  }
  if (path.startsWith("/api/copy/ack/") && req.method === "POST") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    const id = decodeURIComponent(path.slice("/api/copy/ack/".length).split("/")[0] ?? "");
    if (!id) return json(res, 400, { error: "missing order id" });
    const body = await readJson<{ ok?: boolean; brokerOrderId?: string; error?: string; skipped?: boolean; dryRun?: boolean }>(req);
    const done = await acknowledge(payload.sub, id, {
      ok: body?.ok === true,
      brokerOrderId: body?.brokerOrderId ?? null,
      error: body?.error,
      skipped: body?.skipped === true,
      dryRun: body?.dryRun === true,
    });
    // 409, not 404: the id may well exist but isn't in a state we can accept an
    // ack for (never collected, or already acknowledged).
    if (!done) return json(res, 409, { error: "order is not awaiting acknowledgement" });
    return json(res, 200, { ok: true });
  }

  // Chart candles — proxied from the TradingBackend's operator-key history endpoint.
  if (path === "/api/chart/history" && req.method === "GET") {
    if (!requireUser(req)) return json(res, 401, { error: "unauthorized" });
    const symbol = url.searchParams.get("symbol") ?? "";
    const resolution = url.searchParams.get("resolution") ?? "300";
    const count = url.searchParams.get("count") ?? "300";
    try {
      const headers: Record<string, string> = {};
      if (config.serviceToken) headers["x-service-token"] = config.serviceToken;
      const upstream = await fetch(
        `${config.tradingApiUrl}/api/market/history?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&count=${count}`,
        { headers },
      );
      const data = await upstream.json().catch(() => []);
      return json(res, upstream.ok ? 200 : 502, data);
    } catch {
      return json(res, 502, { error: "chart history unavailable (is the trading backend running?)" });
    }
  }

  json(res, 404, { error: "not found" });
}
