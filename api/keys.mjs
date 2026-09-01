// Access-key admin API for the proxy, driven by /cool-things/ip.
//
//   GET    /api/keys              list keys with usage
//   POST   /api/keys              generate a new key   { note?: string }
//   DELETE /api/keys?id=<id>      revoke a key
//
// Every call must carry the admin token as `x-admin-token` (or ?t= for the
// initial page load). The token lives in the ADMIN_TOKEN environment variable and
// never appears in the repo.
//
// Keys are held in one KV document, { id: {created, note, uses, lastIp, lastAt} }.
// A key doubles as the proxy's session id, so revoking one also drops that
// session's cookie jar. Access then stops within about two seconds — the length
// of the proxy's in-memory read cache — and instantly on any other instance.

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "")
  .replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const KEYS_KEY = "pxkeys";

export default { fetch: handle };

async function handle(request) {
  const url = new URL(request.url);

  if (!KV_URL || !KV_TOKEN) {
    return json(503, { error: "No KV configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN." });
  }
  // ADMIN_TOKEN is optional. Unset, this page is open to anyone who finds the URL
  // — which is what was asked for, and it does mean a stranger who finds
  // /cool-things/ip could mint themselves a key. Set the variable later and it
  // starts being enforced with no code change.
  if (ADMIN_TOKEN) {
    const given = request.headers.get("x-admin-token") || url.searchParams.get("t") || "";
    if (!safeEqual(given, ADMIN_TOKEN)) return json(401, { error: "Unauthorized" });
  }

  try {
    if (request.method === "GET") {
      return json(200, { keys: await readKeys() });
    }

    if (request.method === "POST") {
      let note = "";
      try { note = String(((await request.json()) || {}).note || "").slice(0, 60); } catch (_) {}
      const keys = await readKeys();
      const id = newId();
      keys[id] = { created: new Date().toISOString(), note, uses: 0, lastIp: "", lastAt: "" };
      await writeKeys(keys);
      return json(200, { id, keys });
    }

    if (request.method === "DELETE") {
      const id = url.searchParams.get("id") || "";
      const keys = await readKeys();
      if (!keys[id]) return json(404, { error: "No such key" });
      delete keys[id];
      await writeKeys(keys);
      // The key is the session id, so this also ends any session using it.
      try { await kv("/del/" + encodeURIComponent("jar:" + id), { method: "POST" }); } catch (_) {}
      return json(200, { keys });
    }
  } catch (e) {
    return json(502, { error: String(e.message || e) });
  }

  return json(405, { error: "Method not allowed" });
}

/* ------------------------------------------------------------------- kv -- */

async function kv(path, init) {
  const r = await fetch(KV_URL + path, {
    ...init,
    headers: { authorization: "Bearer " + KV_TOKEN, ...((init && init.headers) || {}) },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error("kv " + r.status);
  return r.json();
}

async function readKeys() {
  const out = await kv("/get/" + KEYS_KEY);
  return out && out.result ? JSON.parse(out.result) : {};
}

function writeKeys(keys) {
  return kv("/set/" + KEYS_KEY, {
    method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(keys),
  });
}

/* ----------------------------------------------------------------- util -- */

function newId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish compare so a wrong token can't be recovered by timing.
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
