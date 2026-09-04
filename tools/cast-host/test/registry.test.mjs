// Drives the real api/cast.mjs against an in-memory stand-in for Upstash.
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.KV_REST_API_URL = "https://kv.test";
process.env.KV_REST_API_TOKEN = "kv-token";

let store = new Map();
let hashes = new Map();          // hash name -> Map(field -> value), for pxbip
globalThis.fetch = async (url, init) => {
  const [op, key, val, , , nx] = JSON.parse(init.body);
  let result = null;
  if (op === "GET") result = store.get(key) ?? null;
  else if (op === "DEL") { store.delete(key); result = 1; }
  else if (op === "SET") {
    if (nx === "NX" && store.has(key)) result = null;
    else { store.set(key, val); result = "OK"; }
  } else if (op === "HGET") {
    result = (hashes.get(key) || new Map()).get(val) ?? null;
  } else if (op === "EVAL") {
    const [, script, , evalKey, owner, nextOrTarget] = JSON.parse(init.body);
    const refresh = /redis\.call\('SET'/.test(script);
    const raw = store.get(evalKey);
    if (!raw) result = refresh ? 0 : 1;
    else {
      const rec = JSON.parse(raw);
      if (rec.ph !== owner) result = -1;
      else if (refresh) {
        store.set(evalKey, nextOrTarget); result = 1;
      } else if (nextOrTarget && rec.url !== nextOrTarget) result = 0;
      else { store.delete(evalKey); result = 1; }
    }
  }
  return new Response(JSON.stringify({ result }), { status: 200 });
};

const blockIp = (ip) => {
  if (!hashes.has("pxbip")) hashes.set("pxbip", new Map());
  hashes.get("pxbip").set(ip, "1");
};
const unblockIp = (ip) => (hashes.get("pxbip") || new Map()).delete(ip);

const api = (await import(new URL("../../../api/cast.mjs", import.meta.url).href)).default;

const VIEW = "watch-link-key";
const PUBLISH = "publish-key-kept-on-the-host";

const post = (body) => api.fetch(new Request("https://s/api/cast", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const get = (t, ip) => api.fetch(new Request("https://s/api/cast?t=" + encodeURIComponent(t),
  ip ? { headers: { "x-forwarded-for": ip } } : undefined));
const del = (p, target) => api.fetch(new Request("https://s/api/cast?p=" + encodeURIComponent(p) +
  (target ? "&u=" + encodeURIComponent(target) : ""), { method: "DELETE" }));
// The remote start: the agent checks in, the page wishes, the agent clears it.
const agent = (body, headers) => api.fetch(new Request("https://s/api/cast", {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ agent: true, name: "desk", token: VIEW, publish: PUBLISH, ...body }),
}));
const put = (t, want, ip) => api.fetch(new Request("https://s/api/cast?t=" + encodeURIComponent(t) +
  "&want=" + encodeURIComponent(want), { method: "PUT", headers: ip ? { "x-forwarded-for": ip } : {} }));
const delWant = (p, headers) => api.fetch(new Request("https://s/api/cast?p=" + encodeURIComponent(p) +
  "&want=1", { method: "DELETE", headers: headers || {} }));

let failed = 0;
function okLine(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
}
async function check(name, res, wantStatus, wantUrl) {
  const body = await res.json();
  const ok = res.status === wantStatus && (wantUrl === undefined || body.url === wantUrl);
  if (!ok) failed++;
  console.log((ok ? "PASS " : "FAIL ") + name +
    "  -> " + res.status + (wantUrl !== undefined ? " url=" + body.url : "") +
    (ok ? "" : "  (wanted " + wantStatus + (wantUrl !== undefined ? " url=" + wantUrl : "") + ")"));
}

const REAL = "wss://real-host.trycloudflare.com/ws?k=abc";
const EVIL = "wss://attacker.example/ws?k=x";

await check("host claims an empty slot",
  await post({ url: REAL, name: "desk", token: VIEW, publish: PUBLISH }), 200);
await check("viewer reads it with the watch key",
  await get(VIEW), 200, REAL);
await check("the publish key is not a view key",
  await get(PUBLISH), 401);

// The whole point of the split.
await check("VIEWER CANNOT REPOINT THE ENDPOINT",
  await post({ url: EVIL, token: VIEW, publish: "attacker-invented-publish-key" }), 409);
await check("endpoint is still the real host after that attempt",
  await get(VIEW), 200, REAL);
await check("VIEWER CANNOT UNPUBLISH", await del(VIEW), 401);
await check("cast survived the unpublish attempt", await get(VIEW), 200, REAL);

// Blocking from /cool-things/ip has to reach the cast, not just the proxy.
blockIp("203.0.113.9");
await check("a blocked IP is refused even with a valid key",
  await get(VIEW, "203.0.113.9"), 403);
await check("a blocked IP cannot even probe for whether a cast exists",
  await get("wrong-key-entirely", "203.0.113.9"), 403);
await check("everyone else is unaffected",
  await get(VIEW, "198.51.100.4"), 200, REAL);
// x-forwarded-for is a list; the client is the first entry.
await check("the client IP is read from the front of x-forwarded-for",
  await get(VIEW, "203.0.113.9, 70.41.3.18"), 403);
await check("a proxy hop in the chain is not what gets matched",
  await get(VIEW, "198.51.100.4, 203.0.113.9"), 200, REAL);
unblockIp("203.0.113.9");
await check("unblocking lets them back in",
  await get(VIEW, "203.0.113.9"), 200, REAL);
// The host publishes from its own IP and must never be blocked by this.
blockIp("203.0.113.9");
await check("blocking never stops the host publishing",
  await post({ url: REAL, token: VIEW, publish: PUBLISH }), 200);
unblockIp("203.0.113.9");

// The host itself must still work.
const MOVED = "wss://real-host-2.trycloudflare.com/ws?k=def";
await check("host heartbeat moves its own endpoint",
  await post({ url: MOVED, token: VIEW, publish: PUBLISH }), 200);
await check("viewers follow the host to the new tunnel", await get(VIEW), 200, MOVED);

// A second host must not be able to take a live slot.
await check("another host is refused while the slot is held",
  await post({ url: EVIL, token: "other-view", publish: "another-hosts-publish-key" }), 409);

// Records written before the split carry no publish hash.
store.set("cast:ep", JSON.stringify({ url: REAL, th: "deadbeef", at: Date.now() }));
await check("a pre-split record is not owned by anyone",
  await post({ url: MOVED, token: VIEW, publish: PUBLISH }), 409);

// Atomic claim: two hosts racing an empty slot, only one wins.
store.clear();
const [a, b] = await Promise.all([
  post({ url: REAL, token: "view-a", publish: "publish-key-host-aaaa" }),
  post({ url: EVIL, token: "view-b", publish: "publish-key-host-bbbb" }),
]);
const winners = [a, b].filter((r) => r.status === 200).length;
const ok = winners === 1;
if (!ok) failed++;
console.log((ok ? "PASS " : "FAIL ") + "exactly one host claims a contested empty slot  -> " + winners);

// Back to a slot this host owns, then hang up.
store.clear();
await post({ url: REAL, token: VIEW, publish: PUBLISH });
await post({ url: MOVED, token: VIEW, publish: PUBLISH });
await check("an older process cannot unpublish its replacement", await del(PUBLISH, REAL), 200);
await check("the replacement remains advertised", await get(VIEW), 200, MOVED);
await check("host unpublishes its own current URL", await del(PUBLISH, MOVED), 200);
await check("and the cast reads as offline afterwards", await get(VIEW), 404);

/* --------------------------------------------------------- remote start -- */

// Nothing is casting and nobody is listening: the page must see exactly the
// 404 it always did, and a wish has nobody to go to.
{
  const body = await (await get(VIEW)).json();
  okLine("with no agent the offline body is unchanged",
         !("agent" in body) && !("want" in body), JSON.stringify(body));
}
await check("a wish with no agent listening is a 404", await put(VIEW, "start"), 404);
okLine("and says so by name", (await (await put(VIEW, "start")).json()).error === "noagent");

// The agent checks in, and keeps checking in.
{
  const first = await agent();
  const body = await first.json();
  okLine("the agent registers on an empty slot", first.status === 200 && body.ok === true,
         first.status + " " + JSON.stringify(body));
  okLine("there is no wish waiting and nothing casting",
         body.want === null && body.casting === false, JSON.stringify(body));
  const seen = JSON.parse(store.get("cast:agent")).seen;
  await new Promise((r) => setTimeout(r, 5));
  const again = await agent();
  okLine("the same agent refreshes its own registration", again.status === 200);
  okLine("and the refresh moves the seen stamp",
         JSON.parse(store.get("cast:agent")).seen > seen);
  const rec = JSON.parse(store.get("cast:agent"));
  okLine("the registration stores hashes, not keys",
         rec.th !== VIEW && rec.ph !== PUBLISH && rec.name === "desk" && /^[0-9a-f]{64}$/.test(rec.ph));
}
await check("another agent is refused while the slot is held",
  await agent({ publish: "another-hosts-publish-key" }), 409);
await check("a short view key is refused as for a publish", await agent({ token: "123" }), 400);
await check("a short publish key is refused as for a publish", await agent({ publish: "short" }), 400);
await check("a publish with agent:false is a publish, not a registration",
  await post({ agent: false, url: REAL, token: VIEW, publish: PUBLISH }), 200);
okLine("and it wrote the cast record", !!store.get("cast:ep"));
okLine("the agent is told a cast is up", (await (await agent()).json()).casting === true);
await del(PUBLISH, REAL);

// The page wishes.
await check("a wish with the wrong view key is refused", await put("wrong-key-entirely", "start"), 401);
await check("a wish with no view key is refused", await put("", "start"), 401);
await check("the publish key is not a view key here either", await put(PUBLISH, "start"), 401);
okLine("a refused wish leaves nothing behind", !store.has("cast:want"));
await check("a wish must be start or stop", await put(VIEW, "reboot"), 400);
blockIp("203.0.113.9");
await check("a blocked IP cannot wish, even with the right key", await put(VIEW, "start", "203.0.113.9"), 403);
unblockIp("203.0.113.9");
{
  const res = await put(VIEW, "start");
  const body = await res.json();
  okLine("the right view key may ask the host to start",
         res.status === 200 && body.ok === true && body.want === "start" && body.name === "desk" &&
         body.casting === false, res.status + " " + JSON.stringify(body));
  okLine("the wish is stored as written", store.get("cast:want") === "start");
}
okLine("the agent collects the wish on its next poll", (await (await agent()).json()).want === "start");

// The 404 reveals the agent only to the key that could use it.
{
  const body = await (await get(VIEW)).json();
  okLine("the right key learns the host can be woken, and that it has been asked",
         body.error === "offline" && body.agent === "desk" && body.want === "start", JSON.stringify(body));
  const stranger = await (await get("wrong-key-entirely")).json();
  okLine("A STRANGER DOES NOT LEARN A HOST IS LISTENING",
         !("agent" in stranger) && !("want" in stranger), JSON.stringify(stranger));
  const nokey = await (await get("")).json();
  okLine("nor does no key at all", !("agent" in nokey) && !("want" in nokey), JSON.stringify(nokey));
}

// The agent clears the wish, and only the agent.
store.set("cast:ep", JSON.stringify({ url: REAL, th: "x", ph: "y", at: Date.now() }));
await check("a viewer cannot clear the wish with the view key", await delWant(VIEW), 401);
okLine("the wish is still there", store.get("cast:want") === "start");
await check("the agent clears the wish with the publish key", await delWant(PUBLISH), 200);
okLine("the wish is gone", !store.has("cast:want"));
okLine("and the cast record was left alone", !!store.get("cast:ep"));
store.delete("cast:ep");
okLine("the right key sees the wish is gone", (await (await get(VIEW)).json()).want === null);
await put(VIEW, "stop");
store.delete("cast:agent");
await check("with no agent registered anyone may tidy a leftover wish", await delWant("nobody"), 200);
okLine("and it is gone", !store.has("cast:want"));

// CAST_TOKEN gates the agent like a host, and never the page: the browser does
// not have the token, and a view key that cannot move the cast needs no more.
{
  process.env.CAST_TOKEN = "admin-secret";
  const gated = (await import(new URL("../../../api/cast.mjs?gated", import.meta.url).href)).default;
  delete process.env.CAST_TOKEN;
  const via = (req) => gated.fetch(req);
  const reg = (headers) => via(new Request("https://s/api/cast", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ agent: true, name: "desk", token: VIEW, publish: PUBLISH }),
  }));
  await check("an agent without the admin token is refused", await reg({}), 401);
  await check("an agent with the admin token registers", await reg({ "x-admin-token": "admin-secret" }), 200);
  await check("THE PAGE MAY WISH WITHOUT THE ADMIN TOKEN",
    await via(new Request("https://s/api/cast?t=" + VIEW + "&want=start", { method: "PUT" })), 200);
  await check("clearing the wish is still gated",
    await via(new Request("https://s/api/cast?p=" + PUBLISH + "&want=1", { method: "DELETE" })), 401);
  await check("and open to the agent carrying the token",
    await via(new Request("https://s/api/cast?p=" + PUBLISH + "&want=1",
      { method: "DELETE", headers: { "x-admin-token": "admin-secret" } })), 200);
  store.delete("cast:agent");
}

// The host-side heartbeat must recover inside the TTL after transient site
// failures, without letting retrying fetches overlap one another.
{
  const VNC_PORT = 59031, BRIDGE_PORT = 60831;
  const vnc = net.createServer((sock) => {
    sock.write("RFB 003.008\n");
    sock.on("error", () => {});
  });
  await new Promise((r) => vnc.listen(VNC_PORT, "127.0.0.1", r));

  let posts = 0, active = 0, maxActive = 0;
  const registry = http.createServer((req, res) => {
    if (req.method === "DELETE") { res.end("{}"); return; }
    active++;
    maxActive = Math.max(maxActive, active);
    req.resume();
    req.on("end", () => setTimeout(() => {
      posts++;
      active--;
      // Startup loses its first two publishes, then the running heartbeat loses
      // two more. Both phases must recover rather than stopping or expiring.
      const status = [1, 2, 4, 5].includes(posts) ? 500 : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? "{}" : '{"error":"temporary"}');
    }, 80));
  });
  await new Promise((r) => registry.listen(0, "127.0.0.1", r));

  const host = spawn(process.execPath, [
    fileURLToPath(new URL("../cast-host.mjs", import.meta.url)),
    "--url", "wss://fixed.example", "--site", "http://127.0.0.1:" + registry.address().port,
    "--port", String(BRIDGE_PORT), "--vnc", "127.0.0.1:" + VNC_PORT, "--share", "nope",
  ], {
    windowsHide: true,
    env: { ...process.env, CAST_PUBLISH_MS: "200", CAST_PUBLISH_RETRY_MS: "50" },
  });
  let hostOut = "";
  host.stdout.on("data", (c) => (hostOut += c));
  host.stderr.on("data", (c) => (hostOut += c));
  await new Promise((resolve) => {
    const until = setInterval(() => {
      if (posts >= 6 || host.exitCode !== null) { clearInterval(until); resolve(); }
    }, 25);
    setTimeout(() => { clearInterval(until); resolve(); }, 3000);
  });
  okLine("startup and heartbeat each retry two transient publish failures",
         posts >= 6 && host.exitCode === null, posts + " POSTs; " + hostOut.slice(-120));
  okLine("heartbeat retries never overlap", maxActive === 1, "max active=" + maxActive);

  host.kill();
  await Promise.race([
    new Promise((r) => host.on("exit", r)),
    new Promise((r) => setTimeout(r, 1000)),
  ]);
  registry.close();
  vnc.close();
}

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);
