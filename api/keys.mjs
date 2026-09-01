// Visitor admin API for the proxy, driven by /cool-things/ip.
//
//   GET    /api/keys                     list every visitor with device + activity
//   POST   /api/keys?block=<vid>         block a visitor (and their last IP)
//   POST   /api/keys?unblock=<vid>       unblock a visitor (and free that IP)
//   DELETE /api/keys?id=<vid>            forget a visitor entirely
//
// ADMIN_TOKEN is optional. Set it and every call must carry it as x-admin-token
// (or ?t=); leave it unset and the page is open to whoever finds the URL.
//
// Storage matches the proxy: a Redis hash `pxv` of vid -> visitor record, plus a
// hash `pxbip` of blocked IPs.

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "")
  .replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const V_HASH = "pxv";
const IP_HASH = "pxbip";

export default { fetch: handle };

async function handle(request) {
  const url = new URL(request.url);

  if (!KV_URL || !KV_TOKEN) {
    return json(503, { error: "No KV configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN." });
  }
  if (ADMIN_TOKEN) {
    const given = request.headers.get("x-admin-token") || url.searchParams.get("t") || "";
    if (!safeEqual(given, ADMIN_TOKEN)) return json(401, { error: "Unauthorized" });
  }

  try {
    if (request.method === "GET") {
      return json(200, { visitors: await listVisitors() });
    }

    if (request.method === "POST") {
      const block = url.searchParams.get("block");
      const unblock = url.searchParams.get("unblock");
      const vid = block || unblock;
      if (!vid) return json(400, { error: "Pass ?block=<id> or ?unblock=<id>" });

      const entry = await getVisitor(vid);
      if (!entry) return json(404, { error: "No such visitor" });

      entry.blocked = !!block;
      await setVisitor(vid, entry);
      // Carry the block to the IP so a fresh id from the same network is caught.
      if (entry.ip) {
        if (block) await cmd(["HSET", IP_HASH, entry.ip, "1"]);
        else await cmd(["HDEL", IP_HASH, entry.ip]);
      }
      return json(200, { visitors: await listVisitors() });
    }

    if (request.method === "DELETE") {
      const vid = url.searchParams.get("id") || "";
      const entry = await getVisitor(vid);
      if (!entry) return json(404, { error: "No such visitor" });
      await cmd(["HDEL", V_HASH, vid]);
      try { await fetch(KV_URL + "/del/" + encodeURIComponent("jar:" + vid),
        { method: "POST", headers: { authorization: "Bearer " + KV_TOKEN } }); } catch (_) {}
      return json(200, { visitors: await listVisitors() });
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

async function getVisitor(vid) {
  if (!vid) return null;
  const raw = await cmd(["HGET", V_HASH, vid]);
  return raw ? JSON.parse(raw) : null;
}

function setVisitor(vid, entry) {
  return cmd(["HSET", V_HASH, vid, JSON.stringify(entry)]);
}

// HGETALL returns [field, value, field, value, …].
async function listVisitors() {
  const flat = (await cmd(["HGETALL", V_HASH])) || [];
  const out = {};
  for (let i = 0; i < flat.length; i += 2) {
    try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch (_) {}
  }
  return out;
}

/* ----------------------------------------------------------------- util -- */

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
