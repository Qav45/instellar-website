// Endpoint registry, transcript feed and speech queue for the room, driven by
// /room.
//
//   POST   /api/room   {url, name, token, publish}   host publishes (the heartbeat)
//   POST   /api/room   {publish, tx:[...]}           host adds transcript lines
//   GET    /api/room?t=<token>                       viewer asks where the camera is
//   GET    /api/room?t=<token>&since=<id>            viewer pulls new transcript
//   PUT    /api/room?t=<token>   {text}              viewer queues something to say
//   DELETE /api/room?p=<publish>                     host going away
//
// This is /api/cast with a different payload, and deliberately so - the reasons
// that shaped that file all apply again here. Vercel functions cannot hold a
// socket open, so the video does NOT pass through: the page speaks WHEP straight
// to the host's tunnel and all this remembers is where the tunnel currently is.
//
// The two-key split is the same and matters for the same reason. The view key
// travels in the watch link so it reaches everyone invited; the publish key never
// leaves the host. Were they one key, any viewer could POST a url of their own
// and every other viewer's page would connect to it - handing a stranger the
// room's camera and, worse here than on /cast, its microphone. Only SHA-256 of
// each is stored.
//
// What is new is that traffic runs both ways. Transcripts flow up from the host
// and are read by viewers; spoken messages flow down from viewers and are
// collected by the host. Both live in capped Redis lists with a TTL, because a
// room nobody is watching should cost nothing and leave nothing behind.
//
// The speech queue is drained by the heartbeat rather than by its own endpoint.
// The host is already talking to this file every 30 seconds, so handing back the
// pending lines in that reply costs no extra round trip, and a message can only
// be collected by the key that owns the room - the same rule the cast wish uses.

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "")
  .replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const ROOM_TOKEN = process.env.ROOM_TOKEN || process.env.CAST_TOKEN || "";
const KEY = "room:ep";
const TTL = 90;               // seconds; the host heartbeats every 30
const TX = "room:tx";         // transcript lines, newest first
const TX_SEQ = "room:txseq";  // monotonic id so a viewer can ask for "since"
const TX_MAX = 300;           // lines kept; roughly half an hour of talking
const TX_TTL = 21600;         // six hours, so an empty room forgets by itself
const SAY = "room:say";       // queued speech, oldest first
const SAY_MAX = 20;           // a backlog longer than this is someone playing up
const SAY_TTL = 600;          // nobody collected it in ten minutes, it is stale
const SAY_LIMIT = 300;        // characters per message
// The same blocked-IP hash the proxy reads and /cool-things/ip writes, shared for
// the reason cast.mjs shares it: one block switch should cover everything, and
// two lists would drift the moment either was used.
const IP_HASH = "pxbip";

const REFRESH = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local rec = cjson.decode(raw)
if rec.ph ~= ARGV[1] then return -1 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1`;
const REMOVE = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 1 end
local rec = cjson.decode(raw)
if rec.ph ~= ARGV[1] then return -1 end
if ARGV[2] ~= '' and rec.url ~= ARGV[2] then return 0 end
return redis.call('DEL', KEYS[1])`;
// Draining is a read and a delete, and they have to be one step. Read-then-delete
// dropped anything a viewer queued in between, so a message could be silently
// swallowed by a heartbeat that never spoke it.
const DRAIN = `
local n = redis.call('LLEN', KEYS[1])
if n == 0 then return {} end
local out = redis.call('LRANGE', KEYS[1], 0, n - 1)
redis.call('LTRIM', KEYS[1], n, -1)
return out`;

export default { fetch: handle };

async function handle(request) {
  const url = new URL(request.url);

  if (!KV_URL || !KV_TOKEN) {
    return json(503, { error: "No KV configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN." });
  }
  // Before the method dispatch, as in cast.mjs, so it covers DELETE too. PUT is
  // the viewer speaking and the browser never holds the admin token; its view key
  // is its whole credential and is checked below.
  if (ROOM_TOKEN && request.method !== "GET" && request.method !== "PUT") {
    const given = request.headers.get("x-admin-token") || "";
    if (!safeEqual(given, ROOM_TOKEN)) return json(401, { error: "Unauthorized" });
  }

  try {
    if (request.method === "GET") return await onGet(request, url);
    if (request.method === "PUT") return await onPut(request, url);
    if (request.method === "POST") return await onPost(request);
    if (request.method === "DELETE") return await onDelete(url);
  } catch (e) {
    return json(502, { error: String(e.message || e) });
  }

  return json(405, { error: "Method not allowed" });
}

/* --------------------------------------------------------------- viewer -- */

async function onGet(request, url) {
  // Checked before the key so a blocked device cannot even probe for whether the
  // room is live. GET only: POST and DELETE are the host talking about itself,
  // and blocking your own machine would be a strange way to lock yourself out.
  if (await ipBlocked(clientIp(request))) {
    return json(403, { error: "blocked", detail: "The owner has blocked this device." });
  }
  const given = url.searchParams.get("t") || request.headers.get("x-room-token") || "";
  const rec = await getRecord();
  if (!rec) return json(404, { error: "offline", detail: "The room camera is not running." });
  if (!safeEqual(await sha256(given), rec.th)) return json(401, { error: "Bad token" });

  const body = { url: rec.url, name: rec.name || "", at: rec.at };
  // The transcript rides along with the endpoint rather than living at its own
  // path, so the page polls one thing on one timer instead of racing two.
  const since = Number(url.searchParams.get("since") || 0) || 0;
  body.tx = await transcript(since);
  // The cursor comes from the lines actually handed over, not from a second read
  // of the counter. Read separately, a line landing between the two calls would
  // advance the viewer's cursor past text it was never sent, and that line would
  // then never appear - a silent hole in the transcript rather than a late line.
  body.seq = body.tx.length ? body.tx[body.tx.length - 1].id : since;
  return json(200, body);
}

async function onPut(request, url) {
  if (await ipBlocked(clientIp(request))) {
    return json(403, { error: "blocked", detail: "The owner has blocked this device." });
  }
  const given = url.searchParams.get("t") || request.headers.get("x-room-token") || "";
  const rec = await getRecord();
  if (!rec) return json(404, { error: "offline", detail: "The room camera is not running." });
  if (!safeEqual(await sha256(given), rec.th)) return json(401, { error: "Bad token" });

  const body = await request.json().catch(() => null);
  const text = String(body?.text || "").trim().slice(0, SAY_LIMIT);
  if (!text) return json(400, { error: "text is required" });

  // Capped rather than unbounded. The host reads this queue and says every line
  // out loud in a room with people in it, so an open-ended list is a way to make
  // that machine talk for an hour; the trim keeps the worst case to one screenful.
  const len = await cmd(["RPUSH", SAY, JSON.stringify({ text, at: Date.now() })]);
  if (len > SAY_MAX) await cmd(["LTRIM", SAY, String(-SAY_MAX), "-1"]);
  await cmd(["EXPIRE", SAY, String(SAY_TTL)]);
  return json(200, { ok: true, queued: Math.min(len, SAY_MAX) });
}

/* ----------------------------------------------------------------- host -- */

async function onPost(request) {
  const body = await request.json().catch(() => null);
  const publish = String(body?.publish || "");
  if (publish.length < 16) return json(400, { error: "publish key must be at least 16 chars" });

  // Transcript lines. Separated from the heartbeat because they arrive whenever
  // somebody speaks, not on the endpoint's timer.
  if (Array.isArray(body?.tx)) {
    const rec = await getRecord();
    if (!rec) return json(404, { error: "offline" });
    if (!safeEqual(rec.ph, await sha256(publish))) return json(401, { error: "Bad publish key" });
    const lines = body.tx
      .map((l) => String(l?.text || "").trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 20);
    if (!lines.length) return json(200, { ok: true, added: 0 });
    for (const text of lines) {
      const id = await cmd(["INCR", TX_SEQ]);
      await cmd(["LPUSH", TX, JSON.stringify({ id, text, at: Date.now() })]);
    }
    await cmd(["LTRIM", TX, "0", String(TX_MAX - 1)]);
    await cmd(["EXPIRE", TX, String(TX_TTL)]);
    await cmd(["EXPIRE", TX_SEQ, String(TX_TTL)]);
    return json(200, { ok: true, added: lines.length });
  }

  // The heartbeat, which is also how the host collects what to say.
  const target = String(body?.url || "");
  const token = String(body?.token || "");
  // https:// here where cast.mjs wants wss://, because WHEP is a POST of an SDP
  // offer over plain HTTPS and the media then arrives out of band over WebRTC.
  // Plaintext stays rejected for the same reason it is there: the page runs on
  // https and a browser refuses the request, so such a record is a dead end.
  if (!/^https:\/\/[^\s]+$/i.test(target)) return json(400, { error: "url must be an https:// address" });
  if (token.length < 4) return json(400, { error: "token must be at least 4 chars" });

  const th = await sha256(token);
  const ph = await sha256(publish);
  const next = JSON.stringify({
    url: target, name: String(body?.name || "").slice(0, 60), th, ph, at: Date.now(),
  });

  // Claim an empty slot atomically, so two hosts cannot both read "no record",
  // both write, and both believe they hold it while viewers reach only one.
  let claimed = false;
  if (await cmd(["SET", KEY, next, "EX", String(TTL), "NX"])) {
    claimed = true;
  } else {
    // Occupied: either the owner's heartbeat or somebody else. Comparing and
    // refreshing in one operation stops a record that expires mid-check from
    // letting an old heartbeat overwrite a fresh claim.
    const refreshed = await cmd(["EVAL", REFRESH, "1", KEY, ph, next, String(TTL)]);
    if (refreshed === 0) return json(409, { error: "Slot changed hands mid-write, retry" });
    if (refreshed !== 1) return json(409, { error: "Another host holds the slot" });
  }

  const say = (await cmd(["EVAL", DRAIN, "1", SAY])) || [];
  return json(200, {
    ok: true,
    expiresIn: TTL,
    claimed,
    say: say.map((s) => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean),
  });
}

async function onDelete(url) {
  const given = url.searchParams.get("p") || "";
  const target = url.searchParams.get("u") || "";
  // The publish key, not the view key. Authorising this with the key every viewer
  // holds would let any of them take the room down. The URL identifies this
  // particular process, so an older copy shutting down cannot erase the record a
  // replacement has already published.
  const removed = await cmd(["EVAL", REMOVE, "1", KEY, await sha256(given), target]);
  if (removed === -1) return json(401, { error: "Bad publish key" });
  if (removed === 0) return json(200, { ok: true, stale: true });
  // The room is gone, so anything queued for it is meaningless. Left behind, it
  // would be spoken into an empty room by whichever host claimed the slot next.
  await cmd(["DEL", SAY]);
  return json(200, { ok: true });
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

// Newest first out of Redis; handed back oldest first because that is the order
// it gets appended to a transcript pane.
async function transcript(since) {
  const raw = (await cmd(["LRANGE", TX, "0", String(TX_MAX - 1)])) || [];
  const out = [];
  for (const s of raw) {
    let line = null;
    try { line = JSON.parse(s); } catch (_) { continue; }
    if (!line || line.id <= since) break;
    out.push(line);
  }
  return out.reverse();
}

// Fails OPEN like the proxy's and cast's, and for the same reason: a blocklist
// that shuts everyone out the moment Upstash is slow is worse than one that lets
// a blocked viewer through for a few seconds, with the access key still in front.
async function ipBlocked(ip) {
  if (!ip) return false;
  try { return !!(await cmd(["HGET", IP_HASH, ip])); } catch (_) { return false; }
}

function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for") || "";
  return xff.split(",")[0].trim();
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
