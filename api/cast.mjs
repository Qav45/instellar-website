// Endpoint registry for the screen cast, driven by /cast.
//
//   POST   /api/cast   {url, name, token, publish} host publishes (also the heartbeat)
//   GET    /api/cast?t=<token>              viewer asks where the host is
//   DELETE /api/cast?p=<publish>             host going away
//
// And the remote start, so the owner can wake the host from the page:
//
//   POST   /api/cast   {agent: true, name, token, publish}  the host's agent is listening
//   PUT    /api/cast?t=<token>&want=start|stop  viewer asks the agent to start or stop
//   DELETE /api/cast?p=<publish>&want=1         agent has acted on the wish
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
//
// The remote start is two more keys. `cast:agent` is the agent on the host
// saying it is listening, refreshed by every poll and gone two minutes after the
// last one; it carries the same two hashes as the cast record, so the view key
// that reads the cast is the one that may ask for it, and the publish key that
// owns the cast is the one that may answer. `cast:want` is the wish itself,
// "start" or "stop", written by the page and deleted by the agent once acted on.
// Neither moves the cast anywhere: the agent still has to publish through the
// same claim as any host, so the worst a stolen view key can do here is switch
// the owner's own screen on and off.

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "")
  .replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const CAST_TOKEN = process.env.CAST_TOKEN || "";
const KEY = "cast:ep";
const TTL = 90;               // seconds; the host heartbeats every 30
const AGENT = "cast:agent";
const AGENT_TTL = 120;        // seconds; the agent polls every 10
const WANT = "cast:want";
const WANT_TTL = 600;         // a wish nobody collects in ten minutes is stale
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
// The same blocked-IP hash the proxy reads and /cool-things/ip writes, so one
// block switch covers both. Deliberately shared rather than a second list:
// somebody you have shut out of the proxy is not somebody you want watching
// your screen, and two lists would drift the moment you used one of them.
const IP_HASH = "pxbip";

export default { fetch: handle };

async function handle(request) {
  const url = new URL(request.url);

  if (!KV_URL || !KV_TOKEN) {
    return json(503, { error: "No KV configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN." });
  }
  // Checked before the method dispatch, the way keys.mjs does it, so it covers
  // DELETE too. Sitting inside the POST branch it gated publishing while leaving
  // unpublishing open to anyone holding a watch link.
  // PUT is the viewer's wish to start or stop, and the browser never holds the
  // admin token; the view key is its whole credential, checked below. It cannot
  // move the cast, so this gate has nothing to protect there.
  if (CAST_TOKEN && request.method !== "GET" && request.method !== "PUT") {
    const given = request.headers.get("x-admin-token") || "";
    if (!safeEqual(given, CAST_TOKEN)) return json(401, { error: "Unauthorized" });
  }

  try {
    if (request.method === "GET") {
      // Checked before the key, so a blocked viewer cannot even probe for whether
      // a cast is running. Only on GET: POST and DELETE are the host talking
      // about itself, and blocking the owner's own IP would be a strange way to
      // lock yourself out of your own machine.
      if (await ipBlocked(clientIp(request))) {
        return json(403, { error: "blocked", detail: "The owner has blocked this device." });
      }
      const given = url.searchParams.get("t") || request.headers.get("x-cast-token") || "";
      const rec = await getRecord();
      if (!rec) {
        const body = { error: "offline", detail: "No host is casting right now." };
        // Tell the right key that the host can be woken, and what it is called.
        // Only the right key: this body is what a wrong or missing key gets too,
        // and a stranger probing it must not learn that a machine is listening.
        const agent = await getAgent();
        if (agent && safeEqual(await sha256(given), agent.th)) {
          body.agent = agent.name || "";
          body.want = (await cmd(["GET", WANT])) || null;
        }
        return json(404, body);
      }
      if (!safeEqual(await sha256(given), rec.th)) return json(401, { error: "Bad token" });
      return json(200, { url: rec.url, name: rec.name || "", at: rec.at });
    }

    if (request.method === "PUT") {
      // The viewer's side of the remote start. Blocked before the key, as on GET,
      // and for the same reason: a blocked device does not get to probe.
      if (await ipBlocked(clientIp(request))) {
        return json(403, { error: "blocked", detail: "The owner has blocked this device." });
      }
      const given = url.searchParams.get("t") || request.headers.get("x-cast-token") || "";
      const want = url.searchParams.get("want") || "";
      const agent = await getAgent();
      if (!agent) return json(404, { error: "noagent", detail: "The host is not listening." });
      if (!safeEqual(await sha256(given), agent.th)) return json(401, { error: "Bad token" });
      if (want !== "start" && want !== "stop") return json(400, { error: "want must be start or stop" });
      await cmd(["SET", WANT, want, "EX", String(WANT_TTL)]);
      return json(200, { ok: true, want, name: agent.name || "", casting: !!(await getRecord()) });
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      const target = String(body?.url || "");
      const token = String(body?.token || "");
      const publish = String(body?.publish || "");
      if (body?.agent === true) {
        // The agent checking in, which is also how it collects the wish. Same
        // key rules as a publish, because these are the same two keys.
        if (token.length < 4) return json(400, { error: "token must be at least 4 chars" });
        if (publish.length < 16) return json(400, { error: "publish key must be at least 16 chars" });
        const ph = await sha256(publish);
        const held = await getAgent();
        // Not the atomic claim the cast record gets, and it does not need one: a
        // registration is repeated every ten seconds, so a lost race is a 409 on
        // the next poll rather than a viewer sent to the wrong machine. Only the
        // cast record can send anyone anywhere, and that keeps its own claim.
        if (held && !safeEqual(held.ph, ph)) return json(409, { error: "Another agent holds the slot" });
        await cmd(["SET", AGENT, JSON.stringify({
          th: await sha256(token), ph, name: String(body?.name || "").slice(0, 60), seen: Date.now(),
        }), "EX", String(AGENT_TTL)]);
        const want = await cmd(["GET", WANT]);
        return json(200, { ok: true, want: want || null, casting: !!(await getRecord()) });
      }
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
      // Compare the owner and refresh in one Redis operation. A record expiring
      // between GET and SET used to let an old heartbeat overwrite a new claim.
      const refreshed = await cmd(["EVAL", REFRESH, "1", KEY, ph, next, String(TTL)]);
      if (refreshed === 0) return json(409, { error: "Slot changed hands mid-write, retry" });
      if (refreshed !== 1) return json(409, { error: "Another host holds the slot" });
      return json(200, { ok: true, expiresIn: TTL });
    }

    if (request.method === "DELETE") {
      const given = url.searchParams.get("p") || request.headers.get("x-cast-publish") || "";
      const target = url.searchParams.get("u") || "";
      if (url.searchParams.get("want")) {
        // The agent has acted on the wish. Only the agent that registered may
        // clear it, so a viewer cannot cancel the owner's own request, and with
        // no agent registered there is nobody to be, so anyone may tidy up. The
        // cast record is not touched: that is the other DELETE.
        const held = await getAgent();
        if (held && !safeEqual(await sha256(given), held.ph)) return json(401, { error: "Bad publish key" });
        await cmd(["DEL", WANT]);
        return json(200, { ok: true });
      }
      // The publish key, not the view key. Authorising this with the key handed
      // to every viewer let any of them take the cast down, on a timer if they
      // liked, while the host logged nothing because its own writes still worked.
      // The publish key identifies the machine and survives restarts. The URL
      // identifies this particular process: an older copy shutting down after a
      // replacement has published must not erase the replacement's record. The
      // comparison and delete are atomic so a replacement cannot land between
      // them either.
      const removed = await cmd(["EVAL", REMOVE, "1", KEY, await sha256(given), target]);
      if (removed === -1) return json(401, { error: "Bad publish key" });
      if (removed === 0) return json(200, { ok: true, stale: true });
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

// Same shape as the proxy's, including that a KV hiccup fails OPEN. A blocklist
// that locks everyone out - the owner included - the moment Upstash is slow is
// worse than one that lets a blocked viewer through for a few seconds, and the
// access key is still in front of them either way.
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

async function getAgent() {
  const raw = await cmd(["GET", AGENT]);
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
