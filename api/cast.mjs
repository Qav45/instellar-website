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
// vanishes instead of leaving a stale URL behind.
//
// Reading and writing are separate secrets, and that separation is the whole
// point. The view key travels in the watch link, so it reaches everyone invited
// to watch; the publish key never leaves the host. While they were one key, any
// viewer could POST a url of their own, and the page would connect to it and hand
// over the VNC password - so a viewer could MITM the entire session, screen and
// keystrokes both, while the real host heartbeated underneath none the wiser.
// Only the SHA-256 of each is stored.
//
// The slot is claimed atomically with SET NX, and only the publish key overwrites
// or deletes it. Claiming an *empty* slot is still open to anyone unless
// CAST_TOKEN is set, because the site and the host share no other secret to
// authenticate a first publish with - so CAST_TOKEN is what stops a stranger
// squatting the slot and locking the real host out.

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
  // Checked before the method dispatch, the way keys.mjs does it, so it covers
  // DELETE too. Sitting inside the POST branch it gated publishing while leaving
  // unpublishing open to anyone holding a watch link.
  if (CAST_TOKEN && request.method !== "GET") {
    const given = request.headers.get("x-admin-token") || "";
    if (!safeEqual(given, CAST_TOKEN)) return json(401, { error: "Unauthorized" });
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
      const body = await request.json().catch(() => null);
      const target = String(body?.url || "");
      const token = String(body?.token || "");
      const publish = String(body?.publish || "");
      // ws:// stays rejected: the viewer page runs on https and a browser refuses
      // a plaintext socket from it, so such a record could only ever be a dead
      // end. A host with no tunnel now publishes nothing rather than publishing
      // a loopback address nobody else can reach.
      if (!/^wss:\/\/[^\s]+$/i.test(target)) return json(400, { error: "url must be a wss:// address" });
      // A short key is enumerable: 1234 is ten thousand guesses against this very
      // endpoint, and whoever finds it gets the tunnel URL and lands on the VNC
      // password prompt. That is the owner's call to make, so this only rejects
      // the degenerate case - but a short key means the VNC password is the only
      // thing left guarding the machine, not one of two independent secrets.
      if (token.length < 4) return json(400, { error: "token must be at least 4 chars" });
      if (publish.length < 16) return json(400, { error: "publish key must be at least 16 chars" });

      const th = await sha256(token);
      const ph = await sha256(publish);
      const next = JSON.stringify({
        url: target, name: String(body?.name || "").slice(0, 60), th, ph, at: Date.now(),
      });

      // Claim an empty slot atomically. Read-then-write let two hosts both see no
      // record, both write, and both come away believing they held the slot while
      // viewers reached only one of them.
      if (await cmd(["SET", KEY, next, "EX", String(TTL), "NX"])) {
        return json(200, { ok: true, expiresIn: TTL, claimed: true });
      }

      // Occupied, so this is either the owner's heartbeat or somebody else. Only
      // the publish key may overwrite.
      const rec = await getRecord();
      if (!rec) return json(409, { error: "Slot changed hands mid-write, retry" });
      if (!ownsSlot(rec, ph)) return json(409, { error: "Another host holds the slot" });
      await cmd(["SET", KEY, next, "EX", String(TTL)]);
      return json(200, { ok: true, expiresIn: TTL });
    }

    if (request.method === "DELETE") {
      const given = url.searchParams.get("p") || request.headers.get("x-cast-publish") || "";
      const rec = await getRecord();
      if (!rec) return json(200, { ok: true });
      // The publish key, not the view key. Authorising this with the key handed
      // to every viewer let any of them take the cast down, on a timer if they
      // liked, while the host logged nothing because its own writes still worked.
      if (!ownsSlot(rec, await sha256(given))) return json(401, { error: "Bad publish key" });
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

// A record written before the view/publish split carries no `ph`. Treat that as
// unowned rather than owned-by-anyone: the old host's next heartbeat is refused,
// it retries, and the slot lapses within the TTL and is reclaimed cleanly with
// both hashes present.
function ownsSlot(rec, ph) {
  return typeof rec.ph === "string" && safeEqual(rec.ph, ph);
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
