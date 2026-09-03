// Drives the real api/cast.mjs against an in-memory stand-in for Upstash.
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
const del = (p) => api.fetch(new Request("https://s/api/cast?p=" + encodeURIComponent(p), { method: "DELETE" }));

let failed = 0;
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
await check("host unpublishes with its own key", await del(PUBLISH), 200);
await check("and the cast reads as offline afterwards", await get(VIEW), 404);

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);
