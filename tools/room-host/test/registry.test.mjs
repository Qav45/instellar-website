// Drives the real api/room.mjs against an in-memory stand-in for Upstash.
// Same shape as tools/cast-host/test/registry.test.mjs, with the list commands
// the transcript and the speech queue need added to the fake.

process.env.KV_REST_API_URL = "https://kv.test";
process.env.KV_REST_API_TOKEN = "kv-token";

let store = new Map();           // string keys
let lists = new Map();           // key -> array, index 0 is the head
let hashes = new Map();          // hash name -> Map(field -> value), for pxbip

const list = (k) => {
  if (!lists.has(k)) lists.set(k, []);
  return lists.get(k);
};

globalThis.fetch = async (url, init) => {
  const args = JSON.parse(init.body);
  const [op, key] = args;
  let result = null;

  if (op === "GET") result = store.get(key) ?? null;
  else if (op === "DEL") { store.delete(key); lists.delete(key); result = 1; }
  else if (op === "SET") {
    const val = args[2], nx = args[5];
    if (nx === "NX" && store.has(key)) result = null;
    else { store.set(key, val); result = "OK"; }
  } else if (op === "HGET") {
    result = (hashes.get(key) || new Map()).get(args[2]) ?? null;
  } else if (op === "INCR") {
    const n = Number(store.get(key) || 0) + 1;
    store.set(key, String(n));
    result = n;
  } else if (op === "EXPIRE") {
    result = 1;                  // TTLs are not what these tests are about
  } else if (op === "LPUSH") {
    list(key).unshift(args[2]);
    result = list(key).length;
  } else if (op === "RPUSH") {
    list(key).push(args[2]);
    result = list(key).length;
  } else if (op === "LLEN") {
    result = list(key).length;
  } else if (op === "LRANGE") {
    const start = Number(args[2]), stop = Number(args[3]);
    const arr = list(key);
    result = arr.slice(start, stop < 0 ? undefined : stop + 1);
  } else if (op === "LTRIM") {
    const start = Number(args[2]), stop = Number(args[3]);
    const arr = list(key);
    lists.set(key, stop === -1 ? arr.slice(start) : arr.slice(start, stop + 1));
    result = "OK";
  } else if (op === "EVAL") {
    const script = args[1];
    const evalKey = args[3];
    if (/LLEN/.test(script)) {
      // DRAIN: hand back everything queued and empty the list in one step.
      const arr = list(evalKey);
      result = arr.slice();
      lists.set(evalKey, []);
    } else {
      const owner = args[4], nextOrTarget = args[5];
      const refresh = /redis\.call\('SET'/.test(script);
      const raw = store.get(evalKey);
      if (!raw) result = refresh ? 0 : 1;
      else {
        const rec = JSON.parse(raw);
        if (rec.ph !== owner) result = -1;
        else if (refresh) { store.set(evalKey, nextOrTarget); result = 1; }
        else if (nextOrTarget && rec.url !== nextOrTarget) result = 0;
        else { store.delete(evalKey); result = 1; }
      }
    }
  }
  return new Response(JSON.stringify({ result }), { status: 200 });
};

const blockIp = (ip) => {
  if (!hashes.has("pxbip")) hashes.set("pxbip", new Map());
  hashes.get("pxbip").set(ip, "1");
};
const unblockIp = (ip) => (hashes.get("pxbip") || new Map()).delete(ip);

const api = (await import(new URL("../../../api/room.mjs", import.meta.url).href)).default;

const VIEW = "watch-link-key";
const PUBLISH = "publish-key-kept-on-the-host";

const post = (body) => api.fetch(new Request("https://s/api/room", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const get = (t, ip, since) => api.fetch(new Request("https://s/api/room?t=" + encodeURIComponent(t) +
  (since !== undefined ? "&since=" + since : ""),
  ip ? { headers: { "x-forwarded-for": ip } } : undefined));
const put = (t, text, ip) => api.fetch(new Request("https://s/api/room?t=" + encodeURIComponent(t), {
  method: "PUT",
  headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
  body: JSON.stringify({ text }),
}));
const del = (p, target) => api.fetch(new Request("https://s/api/room?p=" + encodeURIComponent(p) +
  (target ? "&u=" + encodeURIComponent(target) : ""), { method: "DELETE" }));

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

const REAL = "https://real-host.trycloudflare.com/room/whep";
const EVIL = "https://attacker.example/whep";

/* ------------------------------------------------------ the endpoint -- */

await check("host claims an empty slot",
  await post({ url: REAL, name: "front room", token: VIEW, publish: PUBLISH }), 200);
await check("viewer reads it with the watch key", await get(VIEW), 200, REAL);
await check("the publish key is not a view key", await get(PUBLISH), 401);

// The whole point of the split: this is the camera and microphone of a room.
await check("VIEWER CANNOT REPOINT THE CAMERA",
  await post({ url: EVIL, token: VIEW, publish: "attacker-invented-publish-key" }), 409);
await check("endpoint is still the real host after that attempt", await get(VIEW), 200, REAL);
await check("VIEWER CANNOT UNPUBLISH", await del(VIEW), 401);
await check("room survived the unpublish attempt", await get(VIEW), 200, REAL);

// ws:// and http:// are dead ends from an https page, so they are refused.
await check("a plaintext endpoint is refused",
  await post({ url: "http://host.local/whep", token: VIEW, publish: PUBLISH }), 400);
await check("a short publish key is refused",
  await post({ url: REAL, token: VIEW, publish: "short" }), 400);

/* ------------------------------------------------------- the transcript -- */

await check("host adds transcript lines",
  await post({ publish: PUBLISH, tx: [{ text: "is anyone there" }, { text: "yes hello" }] }), 200);

let body = await (await get(VIEW)).json();
okLine("viewer reads the transcript oldest first",
  body.tx.length === 2 && body.tx[0].text === "is anyone there" && body.tx[1].text === "yes hello",
  JSON.stringify(body.tx.map((l) => l.text)));
okLine("the transcript carries a sequence to resume from", body.seq === 2, "seq=" + body.seq);

await post({ publish: PUBLISH, tx: [{ text: "third line" }] });
body = await (await get(VIEW, undefined, 2)).json();
okLine("since= returns only what is new",
  body.tx.length === 1 && body.tx[0].text === "third line",
  JSON.stringify(body.tx.map((l) => l.text)));

// The cursor must never run ahead of what was actually handed over, or the line
// it skipped is gone for good.
okLine("the cursor only advances as far as the lines delivered",
  body.seq === body.tx[body.tx.length - 1].id, "seq=" + body.seq);
okLine("and asking again from there returns nothing",
  (await (await get(VIEW, undefined, body.seq)).json()).tx.length === 0);

await check("A VIEWER CANNOT FORGE TRANSCRIPT LINES",
  await post({ publish: "attacker-invented-publish-key", tx: [{ text: "planted" }] }), 401);
body = await (await get(VIEW)).json();
okLine("nothing was planted", !body.tx.some((l) => l.text === "planted"));

/* ------------------------------------------------------------ speaking -- */

await check("viewer queues something to say", await put(VIEW, "dinner is ready"), 200);
await check("an empty message is refused", await put(VIEW, "   "), 400);
await check("the publish key is not a speaking key", await put(PUBLISH, "hello"), 401);

let hb = await (await post({ url: REAL, token: VIEW, publish: PUBLISH })).json();
okLine("the heartbeat collects what to say",
  hb.say.length === 1 && hb.say[0].text === "dinner is ready", JSON.stringify(hb.say));
hb = await (await post({ url: REAL, token: VIEW, publish: PUBLISH })).json();
okLine("a collected message is not said twice", hb.say.length === 0, JSON.stringify(hb.say));

// Messages are read aloud in a room with people in it, so the queue is capped.
for (let i = 0; i < 30; i++) await put(VIEW, "spam " + i);
hb = await (await post({ url: REAL, token: VIEW, publish: PUBLISH })).json();
okLine("the speech queue is capped", hb.say.length === 20, "collected " + hb.say.length);
okLine("the cap keeps the newest, not the oldest",
  hb.say[hb.say.length - 1].text === "spam 29", hb.say[hb.say.length - 1].text);

// A message left over from a room that has gone must not be spoken into the next.
await put(VIEW, "left behind");
await del(PUBLISH);
await post({ url: REAL, token: VIEW, publish: PUBLISH });
hb = await (await post({ url: REAL, token: VIEW, publish: PUBLISH })).json();
okLine("a message outlives neither the room nor its host", hb.say.length === 0, JSON.stringify(hb.say));

/* ------------------------------------------------------------ blocking -- */

blockIp("203.0.113.9");
await check("a blocked IP is refused even with a valid key", await get(VIEW, "203.0.113.9"), 403);
await check("a blocked IP cannot probe for whether the room is live",
  await get("wrong-key-entirely", "203.0.113.9"), 403);
await check("A BLOCKED IP CANNOT MAKE THE ROOM TALK", await put(VIEW, "let me in", "203.0.113.9"), 403);
await check("everyone else is unaffected", await get(VIEW, "198.51.100.4"), 200, REAL);
await check("the client IP is read from the front of x-forwarded-for",
  await get(VIEW, "203.0.113.9, 70.41.3.18"), 403);
await check("a proxy hop in the chain is not what gets matched",
  await get(VIEW, "198.51.100.4, 203.0.113.9"), 200, REAL);
await check("blocking never stops the host publishing",
  await post({ url: REAL, token: VIEW, publish: PUBLISH }), 200);
unblockIp("203.0.113.9");

/* -------------------------------------------------------------- offline -- */

await del(PUBLISH);
await check("with no host there is no room", await get(VIEW), 404);
await check("and nothing to say to it", await put(VIEW, "anyone home"), 404);

// Two hosts racing an empty slot: only one wins.
store.clear(); lists.clear();
const [a, b] = await Promise.all([
  post({ url: REAL, token: "view-a", publish: "publish-key-host-aaaa" }),
  post({ url: EVIL, token: "view-b", publish: "publish-key-host-bbbb" }),
]);
okLine("only one of two racing hosts claims the slot",
  [a.status, b.status].sort().join(",") === "200,409", a.status + "," + b.status);

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);
