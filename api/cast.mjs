// Endpoint registry for the screen cast, driven by /cast.
//
//   POST   /api/cast   {url, name, token}   host publishes where it is (also the heartbeat)
//   GET    /api/cast?t=<token>              viewer asks where the host is
//   DELETE /api/cast?t=<token>              host going away
//
// Vercel functions cannot hold a WebSocket open, so the VNC stream does NOT pass
// through here — the viewer connects straight to the host's tunnel. All this does
// is remember the tunnel URL, which rotates every time the host restarts.
//
// The record lives at `cast:ep` with a short TTL, so a host that dies simply
// vanishes instead of leaving a stale URL behind. Auth is the token the host
// generated: only its SHA-256 is stored, and both publishing and reading have to
// match it. First writer claims the slot until the TTL lapses. Set CAST_TOKEN in
// the environment to additionally gate publishing.

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "")
  .replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const CAST_TOKEN = process.env.CAST_TOKEN || "";
const KEY = "cast:ep";
const TTL = 90;               // seconds; the host heartbeats every 30

export default { fetch: handle };

async function handle(request) {
  const url = new URL(request.url);

  if (!KV_URL || !KV_TOKEN) {
    return json(503, { error: "No KV configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN." });
  }

  try {
    if (request.method === "GET") {
      const given = url.searchParams.get("t") || request.headers.get("x-cast-token") || "";
      const rec = await getRecord();
      if (!rec) return json(404, { error: "offline", detail: "No host is casting right now." });
      if (!safeEqual(await sha256(given), rec.th)) return json(401, { error: "Bad token" });
      return json(200, { url: rec.url, name: rec.name || "", at: rec.at });
    }

    if (request.method === "POST") {
      if (CAST_TOKEN) {
        const given = request.headers.get("x-admin-token") || "";
        if (!safeEqual(given, CAST_TOKEN)) return json(401, { error: "Unauthorized" });
      }
      const body = await request.json().catch(() => null);
      const target = String(body?.url || "");
      const token = String(body?.token || "");
      if (!/^wss:\/\/[^\s]+$/i.test(target)) return json(400, { error: "url must be a wss:// address" });
      if (token.length < 16) return json(400, { error: "token must be at least 16 chars" });

      const th = await sha256(token);
      const rec = await getRecord();
      // Whoever holds the slot keeps it until their heartbeat lapses.
      if (rec && !safeEqual(rec.th, th)) return json(409, { error: "Another host holds the slot" });

      const next = { url: target, name: String(body?.name || "").slice(0, 60), th, at: Date.now() };
      await cmd(["SET", KEY, JSON.stringify(next), "EX", String(TTL)]);
      return json(200, { ok: true, expiresIn: TTL });
    }

    if (request.method === "DELETE") {
      const given = url.searchParams.get("t") || request.headers.get("x-cast-token") || "";
      const rec = await getRecord();
      if (!rec) return json(200, { ok: true });
      if (!safeEqual(await sha256(given), rec.th)) return json(401, { error: "Bad token" });
      await cmd(["DEL", KEY]);
      return json(200, { ok: true });
    }
  } catch (e) {
    return json(502, { error: String(e.message || e) });
  }

  return json(405, { error: "Method not allowed" });
}

/* ------------------------------------------------------------------- kv -- */

async function cmd(args) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { authorization: "Bearer " + KV_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error("kv " + r.status);
  return (await r.json()).result;
}

async function getRecord() {
  const raw = await cmd(["GET", KEY]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/* ----------------------------------------------------------------- util -- */

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
