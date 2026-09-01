// Server-side web proxy (Vercel function, Web Handler form).
//
//   /api/p/<sid>/<scheme>/<host>/<path...>?<query>
//
// The PATH-PREFIX scheme is the whole point: because the target's path is carried
// in our path, a relative URL inside the proxied page ("./lib.js", "../a/b.css")
// resolves correctly in the browser with no rewriting at all. That is what makes
// ES modules, dynamic import(), workers and relative fetch() work — none of which
// can be fixed by rewriting HTML, because the browser resolves them itself.
//
// <sid> is a short opaque id keying the server-side cookie jar. The page is framed
// WITHOUT allow-same-origin, so it has no cookie store of its own; carrying the sid
// in the path means every relative sub-request inherits it for free. Anyone holding
// the URL holds the session — treat the sid as a capability.
//
// This is the Web Handler form (`export default { fetch }`) rather than the legacy
// (req, res) one, deliberately: it hands us an untouched request body stream (so
// POSTs forward intact regardless of Vercel's body-parser helpers) and lets us
// return `new Response(upstream.body)` to stream, which is what lifts the ~4.5MB
// serverless response cap.
//
// NOTE: this is an OPEN proxy. The SSRF guard blocks loopback, private ranges and
// cloud metadata, but there is no auth.

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { Readable } from "node:stream";

const TIMEOUT_MS = 20000;
const MAX_REWRITE = 8 * 1024 * 1024;   // bodies larger than this stream through unrewritten
const MAX_SIDS = 300;
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Cookie storage. The frame is sandboxed to an opaque origin so it has no cookie
// store of its own, which means the jar has to live server-side, keyed by the sid
// carried in the path.
//
// A plain in-memory Map is not enough: a cold instance starts with an empty jar,
// so a session established on one instance is silently missing on the next and
// logged-in sites bounce you back to the login page. Measured, that was ~2 in 5
// requests. So the jar goes to an HTTP-callable KV when one is configured, with
// the Map kept in front of it as a short-lived read cache.
//
// Turn it on with either naming convention: KV_REST_API_* (what Vercel's KV
// integration injects) or UPSTASH_REDIS_REST_* (what the Upstash console hands
// you). With both unset everything still works exactly as before, just warm-only.
const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "")
  .replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const KV_ON = !!(KV_URL && KV_TOKEN);
const JAR_TTL = 3600;      // seconds a session survives in KV
const L1_TTL = 2000;       // ms — long enough to cover one page's burst of
                           // subresources, short enough that a cookie set by a
                           // POST is picked up by the request right after it.

const L1 = new Map();      // sid -> { at, jar }

// Access control. Without it this is an OPEN proxy — anyone who learns the URL can
// push traffic through the project. Keys are managed from /cool-things/ip.
//
// The gate ARMS ITSELF: while the key registry is empty the proxy stays open, and
// the moment the first key exists it will only serve a session id that is also a
// live key. That ordering matters — it means you cannot lock yourself out by
// enabling a gate before you have a way through it.
//
// The access key IS the session id, so there is no separate handshake and each
// person gets their own persistent cookie jar. Revoking a key drops both the
// registry entry and the jar.
const KEYS_KEY = "pxkeys";

export default { fetch: handle };

async function handle(request) {
  const here = new URL(request.url);
  const parsed = parsePath(here);
  if (!parsed) {
    const rescued = escapeRedirect(here, request);
    if (rescued) return rescued;
    return text(404, "Not found");
  }

  // No session id yet: mint one and bounce, so every relative sub-request the
  // page goes on to make inherits it through the path. With the gate on there is
  // nothing to mint — the caller has to bring a key.
  if (!parsed.sid) {
    if (KV_ON && await gateArmed()) return denied();
    return new Response(null, {
      status: 302,
      headers: { location: proxyPath(parsed.target, newSid()), "cache-control": "no-store" },
    });
  }

  let target;
  try { target = new URL(parsed.target); } catch (_) { return text(400, "Bad url"); }
  if (target.protocol !== "http:" && target.protocol !== "https:") return text(400, "Only http/https");
  if (isBlockedHost(target.hostname)) return text(403, "Host not allowed");

  const sid = parsed.sid;
  const withBody = request.method !== "GET" && request.method !== "HEAD";

  const jar = await loadJar(sid);

  // Authorise once per jar: the first request for a session costs one extra KV
  // read to confirm the key is live, then the verdict rides along in the jar we
  // were already loading, so later requests cost nothing.
  if (KV_ON && !jar.__k) {
    const keys = await readKeys();
    if (keys && Object.keys(keys).length) {          // gate is armed
      if (!keys[sid]) return denied();
      jar.__k = sid;
      await saveJar(sid, jar);
      await touchKey(sid, clientIp(request), keys);
    }
  }

  let upstream;
  try {
    upstream = await upstreamRequest(target, {
      method: request.method,
      headers: upstreamHeaders(request, target, jar),
      body: withBody ? request.body : null,
    });
  } catch (e) {
    return text(502, "Upstream fetch failed: " + e.message + "\n\nfor " + target.href);
  }

  if (storeCookies(jar, target.hostname, upstream.headers["set-cookie"])) {
    await saveJar(sid, jar);
  }

  // Handle redirects ourselves rather than following them server-side. Bouncing
  // the browser keeps its idea of "the current URL" in step with the target's,
  // which is what makes relative URLs on the landed page resolve correctly — the
  // old proxy followed redirects but kept resolving against the PRE-redirect URL,
  // which is why assets 404'd on any site that redirects.
  const location = upstream.headers["location"];
  if (upstream.status >= 300 && upstream.status < 400 && location) {
    upstream.stream.resume();                    // drain; we aren't sending this body on
    let dest;
    try { dest = new URL(location, target.href); } catch (_) { dest = null; }
    // Re-run the guard: without this a public host can 302 us at 169.254.169.254.
    if (!dest || !/^https?:$/.test(dest.protocol) || isBlockedHost(dest.hostname)) {
      return text(502, "Blocked redirect target");
    }
    const h = responseHeaders(upstream.headers);
    h.set("location", proxyPath(dest.href, sid));
    h.set("cache-control", "no-store");
    return new Response(null, { status: upstream.status, headers: h });
  }

  const ct = upstream.headers["content-type"] || "";
  const headers = responseHeaders(upstream.headers);
  const isHtml = /\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(ct);
  const isCss = /\btext\/css\b/i.test(ct);
  const len = Number(upstream.headers["content-length"] || 0);

  if ((isHtml || isCss) && len <= MAX_REWRITE) {
    const raw = await readAll(upstream.stream, MAX_REWRITE);
    if (raw) {
      const buf = inflate(raw, upstream.headers["content-encoding"]);
      const body = decodeBody(buf, ct);
      // Rewriting changes the length, so none of these can survive.
      headers.delete("content-length");
      headers.delete("content-range");
      headers.delete("accept-ranges");
      headers.delete("content-encoding");
      if (isHtml) {
        headers.set("content-type", "text/html; charset=utf-8");
        return new Response(rewriteDocument(body, target, sid), { status: upstream.status, headers });
      }
      headers.set("content-type", "text/css; charset=utf-8");
      return new Response(rewriteCss(body, target.href, sid), { status: upstream.status, headers });
    }
  }

  // Everything else streams straight through, so a big bundle or a video is never
  // buffered into the function's memory. Range/206 passes through untouched.
  headers.set("content-type", ct || "application/octet-stream");
  if (request.method === "HEAD") { upstream.stream.resume(); return new Response(null, { status: upstream.status, headers }); }
  return new Response(Readable.toWeb(upstream.stream), { status: upstream.status, headers });
}

/* ----------------------------------------------------------- upstream i/o -- */

// node:http(s) rather than fetch(), for one specific reason: undici derives
// Sec-Fetch-Mode from the fetch `mode` option and ignores the header you set, and
// `navigate` is not a constructible mode — so fetch() can only ever announce
// "Sec-Fetch-Mode: cors" on what is plainly a top-level page load. That mismatch
// is exactly the kind of thing bot detection looks for. Going one level down
// gives us byte-level control of the request line and headers.
const TRACE_HEADERS = [
  "x-vercel-id", "x-invocation-id", "x-vercel-deployment-url", "x-vercel-forwarded-for",
  "x-vercel-proxy-signature", "x-vercel-proxy-signature-ts", "x-vercel-sc-host",
  "x-vercel-sc-basepath", "x-vercel-sc-headers", "x-vercel-internal-ingress-bucket",
  "traceparent", "tracestate", "baggage", "x-amzn-trace-id",
  "via", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
];

function upstreamRequest(target, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const mod = target.protocol === "http:" ? http : https;
    let req;
    try {
      req = mod.request(target.href, { method, headers }, (res) => {
        resolve({ status: res.statusCode, headers: res.headers, stream: res });
      });
    } catch (e) { reject(e); return; }

    // Vercel's runtime instruments outbound http and puts its own tracing headers
    // back on after we built ours, which tells every target site in plain text
    // that it is talking to a serverless function. Take them off again here,
    // before anything is flushed to the socket.
    for (const k of TRACE_HEADERS) { try { req.removeHeader(k); } catch (_) {} }

    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("upstream timed out after " + TIMEOUT_MS + "ms")));
    req.on("error", reject);

    if (body) Readable.fromWeb(body).pipe(req);
    else req.end();
  });
}

async function readAll(stream, cap) {
  const chunks = [];
  let size = 0;
  for await (const c of stream) {
    size += c.length;
    if (size > cap) { stream.destroy(); return null; }   // too big to rewrite
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// We ask for `identity`, but a server is free to ignore that and compress anyway.
function inflate(buf, encoding) {
  try {
    if (/\bgzip\b/i.test(encoding || "")) return zlib.gunzipSync(buf);
    if (/\bdeflate\b/i.test(encoding || "")) return zlib.inflateSync(buf);
    if (/\bbr\b/i.test(encoding || "")) return zlib.brotliDecompressSync(buf);
  } catch (_) {}
  return buf;
}

/* ------------------------------------------------------------------ paths -- */

const RAW_MARKER = "/__pxraw";

// "/api/p/<sid>/https/example.com/a/b?q=1" -> { sid, target }
// A segment of exactly "http"/"https" where the sid would be means there is no sid.
//
// Two shapes have to work. Normally the request still carries the real path and we
// read it straight off. But Vercel's zero-config routing only matches ONE segment
// for a bracket file, so vercel.json rewrites /api/p/:path* to this function and
// hands the path over in `__p` — in which case the pathname here is just /api/px.
function parsePath(here) {
  let segs;

  if (here.pathname.startsWith("/api/p/")) {
    segs = here.pathname.split("/").slice(3);       // drop ["", "api", "p"]
  } else {
    const handed = here.searchParams.get("__pxp") ?? here.searchParams.get("__p");
    if (handed == null) return null;
    segs = handed.split("/").filter(Boolean);
  }

  // The rewrite hands us __p on the query REGARDLESS of whether it also kept the
  // original path, so it has to come off either way or it rides along into the
  // target's own query string. Stripped textually rather than through
  // URLSearchParams so every other parameter survives byte-for-byte — signed
  // URLs and + vs %20 do not tolerate being re-serialised.
  const search = stripHandover(here.search);

  let i = 0;
  let sid = null;
  if (segs[i] !== "http" && segs[i] !== "https") { sid = segs[i] || null; i++; }

  const scheme = segs[i]; i++;
  const host = segs[i]; i++;
  if ((scheme !== "http" && scheme !== "https") || !host) return null;
  if (!/^(?:[a-z0-9][a-z0-9.\-]*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i.test(host)) return null;

  const rest = segs.slice(i).join("/");

  // Escape hatch for targets the path grammar can't carry (see proxyPath).
  if (("/" + rest).endsWith(RAW_MARKER)) {
    const raw = new URLSearchParams(search).get("__pxu");
    if (raw) { try { return { sid, target: new URL(raw).href }; } catch (_) { return null; } }
  }

  // The path keeps its percent-encoding, and `search` is passed through rather than
  // re-serialised where possible, so signed URLs and +/%20 survive intact.
  return { sid, target: scheme + "://" + host + "/" + rest + search };
}

// Absolute target url -> our same-origin path. Deliberately relative (no host):
// nothing depends on the Host header, so it can't be spoofed into pointing
// rewritten URLs at someone else's domain — a bug in the old proxy.
function proxyPath(absUrl, sid) {
  let t;
  try { t = new URL(absUrl); } catch (_) { return absUrl; }
  if (t.protocol !== "http:" && t.protocol !== "https:") return absUrl;

  const head = "/api/p/" + (sid ? sid + "/" : "") + t.protocol.slice(0, -1) + "/" + t.host;

  // Vercel's CDN 308-collapses consecutive slashes before our code ever runs, and
  // a decode/re-encode round-trip destroys these four reserved escapes. Carry such
  // URLs in a query param instead. Relative resolution FROM one of these is broken,
  // which is fine: in practice they are leaf assets, never documents.
  if (t.pathname.includes("//") || /%(2f|3f|23|25)/i.test(t.pathname)) {
    return head + RAW_MARKER + "?__pxu=" + encodeURIComponent(t.origin + t.pathname + t.search);
  }
  return head + t.pathname + t.search;
}

// Vercel appends the rewrite's capture group to the query automatically, so the
// handover parameter is always there and must always come off. Its group is named
// __pxp precisely so it cannot collide with a real parameter — an earlier version
// used ":path", whose auto-appended "path=" then rode into the target URL and grew
// by one layer on every redirect until the browser gave up with a redirect loop.
const HANDOVER = ["__pxp", "__pxesc", "__p"];

// `window.location` is the one thing the injected interceptor cannot hook — it is
// [Unforgeable], so `location.href = "/c/abc"` inside a proxied page resolves
// against OUR origin and lands on a 404 with a blank frame. ChatGPT does exactly
// that when you send a message (its bundle has 11 `location.href =` and 9
// `location.assign`), which is why sending appeared to blank the page.
//
// It can't be prevented, but it can be caught: such a request still carries a
// Referer pointing at the proxied page, which tells us both the session and the
// host it meant. Bounce it back into the proxy. Requests with no proxy referer
// are genuine 404s and are left alone.
function escapeRedirect(here, request) {
  const ref = request.headers.get("referer");
  if (!ref) return null;

  let back;
  try { back = parsePath(new URL(ref)); } catch (_) { return null; }
  if (!back || !back.sid) return null;

  let origin;
  try { origin = new URL(back.target).origin; } catch (_) { return null; }

  // Behind the catch-all rewrite the real path is usually still on the URL; fall
  // back to the handed-over copy when it isn't.
  let path = here.pathname;
  if (path === "/api/px" || path === "/api/p") {
    const handed = here.searchParams.get("__pxesc");
    path = "/" + String(handed || "").replace(/^\/+/, "");
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: proxyPath(origin + path + stripHandover(here.search), back.sid),
      "cache-control": "no-store",
    },
  });
}

function stripHandover(raw) {
  if (!raw || raw.length < 2) return "";
  const kept = raw.slice(1).split("&").filter(
    (p) => !HANDOVER.some((k) => p === k || p.startsWith(k + "=")));
  return kept.length ? "?" + kept.join("&") : "";
}

function newSid() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
}

const SKIP_URL = /^\s*(#|data:|blob:|javascript:|mailto:|tel:|sms:|about:|\{|\$\{)/i;

// The one URL mapper everything uses: resolve against the page, then re-point at
// this proxy. Returns the input untouched when it isn't a mappable http(s) URL.
function mapUrl(v, page, sid) {
  if (v == null) return v;
  const s = String(v).trim();
  if (!s || SKIP_URL.test(s)) return v;
  if (s.startsWith("/api/p/")) return v;
  let abs;
  try { abs = new URL(s, page).href; } catch (_) { return v; }
  if (!/^https?:/i.test(abs)) return v;
  return proxyPath(abs, sid);
}

/* ---------------------------------------------------------------- headers -- */

// Never passed upstream. The x-vercel-* / x-invocation-id ones matter most: the
// old proxy forwarded them, which told every target site in plain text that it
// was talking to a Vercel serverless function.
const STRIP_REQ = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
  "expect", "content-length", "proxy-authorization", "proxy-connection",
  "cookie", "referer", "origin", "accept-encoding",
  "x-invocation-id", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-port", "x-real-ip", "true-client-ip", "forwarded", "via", "cdn-loop",
]);

function upstreamHeaders(request, target, jar) {
  const src = request.headers;
  const h = Object.create(null);

  for (const [k, v] of src) {
    const key = k.toLowerCase();
    if (STRIP_REQ.has(key)) continue;
    if (key.startsWith("x-vercel-") || key.startsWith("cf-") || key.startsWith("x-now-")) continue;
    h[key] = v;
  }

  h["user-agent"] = src.get("user-agent") || DEFAULT_UA;
  h["accept-language"] = src.get("accept-language") || "en-US,en;q=0.9";
  if (!h["accept"]) h["accept"] = "*/*";

  // Ask for uncompressed bytes so content-length and content-range stay truthful,
  // which is what Range/206 seeking depends on.
  h["accept-encoding"] = "identity";

  // Referer: the browser sends us OUR url, so translate it back to the real one
  // the target expects to see. A subresource request with no referer at all is a
  // strong bot signal, and the old proxy sent none, ever.
  let refHost = "";
  const ref = src.get("referer");
  if (ref) {
    try {
      const back = parsePath(new URL(ref));
      if (back) { h["referer"] = back.target; refHost = new URL(back.target).host; }
    } catch (_) {}
  }
  if (src.get("origin")) h["origin"] = target.origin;

  // Shape Sec-Fetch-* like a real browser request. The old proxy announced
  // "Sec-Fetch-Mode: cors" on top-level page loads, which no browser ever does.
  const mode = src.get("sec-fetch-mode");
  const isNav = !mode || mode === "navigate";
  if (isNav) {
    h["sec-fetch-dest"] = "document";
    h["sec-fetch-mode"] = "navigate";
    h["sec-fetch-site"] = "none";
    h["sec-fetch-user"] = "?1";
    h["upgrade-insecure-requests"] = "1";
    if (!src.get("accept")) {
      h["accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9," +
        "image/avif,image/webp,image/apng,*/*;q=0.8";
    }
  } else {
    h["sec-fetch-site"] = refHost && refHost === target.host ? "same-origin" : "cross-site";
  }

  const cookie = cookieHeader(jar, target.hostname);
  if (cookie) h["cookie"] = cookie;

  return h;
}

// Response headers we refuse to pass on. The framing/CSP ones would stop the page
// being embedded at all; `link` is here because it carries rel=preconnect and
// rel=preload, which would make the browser open connections straight to the
// target host and blow the one-host guarantee.
const STRIP_RES = new Set([
  "content-security-policy", "content-security-policy-report-only",
  "x-frame-options", "cross-origin-opener-policy", "cross-origin-embedder-policy",
  "cross-origin-resource-policy", "permissions-policy", "feature-policy",
  "strict-transport-security", "clear-site-data", "report-to", "reporting-endpoints",
  "nel", "expect-ct", "link", "alt-svc",
  "set-cookie", "transfer-encoding", "connection", "keep-alive", "location",
]);
// content-encoding is deliberately NOT stripped: we don't decompress pass-through
// bodies, so the header is accurate and the browser needs it. The rewrite path
// decompresses and deletes it there.

function responseHeaders(from) {
  const h = new Headers();
  for (const k of Object.keys(from)) {
    if (STRIP_RES.has(k.toLowerCase())) continue;
    const v = from[k];
    h.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  h.set("access-control-allow-origin", "*");
  return h;
}

/* ---------------------------------------------------------------- cookies -- */

async function kv(path, init) {
  const r = await fetch(KV_URL + path, {
    ...init,
    headers: { authorization: "Bearer " + KV_TOKEN, ...((init && init.headers) || {}) },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error("kv " + r.status);
  return r.json();
}

async function loadJar(sid) {
  const hit = L1.get(sid);
  if (hit && Date.now() - hit.at < L1_TTL) return hit.jar;

  let jar = (hit && hit.jar) || {};
  if (KV_ON) {
    try {
      const out = await kv("/get/" + encodeURIComponent("jar:" + sid));
      jar = out && out.result ? JSON.parse(out.result) : {};
    } catch (_) { /* KV down: carry on with whatever we already had */ }
  }
  if (L1.size >= MAX_SIDS) L1.delete(L1.keys().next().value);
  L1.set(sid, { at: Date.now(), jar });
  return jar;
}

async function saveJar(sid, jar) {
  L1.set(sid, { at: Date.now(), jar });
  if (!KV_ON) return;
  try {
    await kv("/set/" + encodeURIComponent("jar:" + sid) + "?EX=" + JAR_TTL, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(jar),
    });
  } catch (_) { /* best effort; the L1 copy still serves this instance */ }
}

// The key registry is a single KV entry, { id: {created, uses, lastIp, lastAt} }.
// One document rather than a key each: there are only ever a handful, and it keeps
// this to one GET and one SET.
async function readKeys() {
  try {
    const out = await kv("/get/" + KEYS_KEY);
    return out && out.result ? JSON.parse(out.result) : {};
  } catch (_) { return null; }        // null = couldn't tell, treat as "no"
}

// Armed once at least one key exists. Until then the proxy stays open, so the
// first thing you do can be to create a key rather than to regain access.
async function gateArmed() {
  const keys = await readKeys();
  return !!(keys && Object.keys(keys).length);
}

async function touchKey(id, ip, known) {
  const keys = known || (await readKeys());
  if (!keys || !keys[id]) return;
  keys[id].uses = (keys[id].uses || 0) + 1;
  keys[id].lastIp = ip || keys[id].lastIp || "";
  keys[id].lastAt = new Date().toISOString();
  try {
    await kv("/set/" + KEYS_KEY, {
      method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(keys),
    });
  } catch (_) {}
}

function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for") || "";
  return xff.split(",")[0].trim();
}

function denied() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Unavailable</title>' +
    '<div style="font:15px/1.6 arial,sans-serif;color:#5f6368;padding:48px;text-align:center">' +
    "This service isn’t available.</div>",
    { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

// Returns true when something actually changed, so we only pay for a KV write
// on responses that really carried a Set-Cookie.
function storeCookies(jar, host, setCookie) {
  const raw = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  if (!raw.length) return false;
  let changed = false;

  for (const line of raw) {
    const str = String(line);
    const first = str.split(";")[0];
    const eq = first.indexOf("=");
    if (eq < 1) continue;

    // Honour Domain= so a cookie set on ".example.com" reaches www.example.com,
    // but never let a site set one for a domain it doesn't own.
    let scope = host;
    const dm = /;\s*domain\s*=\s*\.?([^;\s]+)/i.exec(str);
    if (dm) {
      const d = dm[1].toLowerCase().replace(/^\./, "");
      if (host === d || host.endsWith("." + d)) scope = d;
    }
    if (!jar[scope]) jar[scope] = {};
    const bag = jar[scope];

    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    const expired = /;\s*max-age\s*=\s*(0|-\d+)\b/i.test(str);
    if (expired) { if (name in bag) { delete bag[name]; changed = true; } }
    else if (bag[name] !== value) { bag[name] = value; changed = true; }
  }
  return changed;
}

function cookieHeader(jar, host) {
  const out = [];
  for (const scope of Object.keys(jar)) {
    if (scope.startsWith("__")) continue;          // our own markers, not a host
    if (host !== scope && !host.endsWith("." + scope)) continue;
    for (const n of Object.keys(jar[scope])) out.push(n + "=" + jar[scope][n]);
  }
  return out.join("; ");
}

/* -------------------------------------------------------------- rewriting -- */

// upstream.text() assumes UTF-8; a windows-1252 page decoded that way comes out as
// mojibake. Honour the declared charset, sniffing <meta charset> when the header
// doesn't say.
function decodeBody(buf, contentType) {
  let cs = (/charset=["']?([\w-]+)/i.exec(contentType) || [])[1];
  if (!cs) {
    const head = buf.subarray(0, Math.min(2048, buf.length)).toString("latin1");
    cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  try { return new TextDecoder(cs || "utf-8").decode(buf); }
  catch (_) { return new TextDecoder("utf-8").decode(buf); }
}

// Split the document into markup / <script> / <style> / comment regions and only
// rewrite the markup. The old proxy ran its attribute and url() regexes over the
// WHOLE file including script bodies, silently corrupting inline JS — and a
// mangled init script is exactly what "the buttons don't do anything" looks like.
function rewriteDocument(html, target, sid) {
  // <base href> is document-wide and may appear after the links it affects, so
  // resolve it in a pre-pass. It is rewritten (not deleted) further down, so the
  // browser's own relative resolution stays consistent with ours.
  let page = target.href;
  const baseTag = /<base\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  if (baseTag) {
    try { page = new URL(baseTag[2] || baseTag[3] || baseTag[4] || "", target.href).href; } catch (_) {}
  }

  const lower = html.toLowerCase();
  let out = "", i = 0, mark = 0;

  while (i < html.length) {
    const lt = lower.indexOf("<", i);
    if (lt < 0) break;

    if (lower.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end < 0 ? html.length : end + 3;
      out += rewriteMarkup(html.slice(mark, lt), page, sid) + html.slice(lt, stop);
      mark = i = stop;
      continue;
    }

    const m = /^<(script|style|textarea|title|xmp|noembed|noframes)\b/.exec(lower.slice(lt, lt + 12));
    if (!m) { i = lt + 1; continue; }

    const gt = html.indexOf(">", lt);
    if (gt < 0) break;
    const close = lower.indexOf("</" + m[1], gt + 1);
    const bodyEnd = close < 0 ? html.length : close;

    out += rewriteMarkup(html.slice(mark, lt), page, sid);
    out += rewriteMarkup(html.slice(lt, gt + 1), page, sid);   // the open tag: src=, integrity=
    const body = html.slice(gt + 1, bodyEnd);
    out += m[1] === "style" ? rewriteCss(body, page, sid) : body;
    mark = i = bodyEnd;
  }
  out += rewriteMarkup(html.slice(mark), page, sid);

  // Inject AFTER <meta charset> if there is one — inserting before it pushes the
  // declaration past the browser's 1024-byte sniff window and flips the encoding.
  const inject = importMap(target, sid) + interceptor(page, sid);
  const charset = /<meta[^>]+charset[^>]*>/i.exec(out);
  if (charset) return out.replace(charset[0], charset[0] + inject);
  if (/<head[^>]*>/i.test(out)) return out.replace(/<head[^>]*>/i, (t) => t + inject);
  if (/<html[^>]*>/i.test(out)) return out.replace(/<html[^>]*>/i, (t) => t + inject);
  return inject + out;
}

const URL_ATTR = /\b(href|src|action|formaction|poster|cite|manifest|background|data-src|data-href|data-url|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>=`]+)/gi;
const SRCSET_ATTR = /\b(srcset|imagesrcset|data-srcset)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>=`]+)/gi;
const STYLE_ATTR = /\bstyle\s*=\s*("[^"]*"|'[^']*')/gi;
const META_REFRESH = /(<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh["']?[^>]*\bcontent\s*=\s*)("[^"]*"|'[^']*')/gi;

function unquote(v) {
  const q = v[0];
  return (q === '"' || q === "'") ? { q, s: v.slice(1, -1) } : { q: '"', s: v };
}

function rewriteMarkup(chunk, page, sid) {
  if (!chunk) return chunk;

  // preconnect/dns-prefetch make the browser open a TCP+TLS connection straight to
  // the target host. That is a live breach of the one-host guarantee, so the tags
  // go entirely. A <meta> CSP would also block our injected script.
  chunk = chunk.replace(/<link\b[^>]*\brel\s*=\s*["']?\s*(?:preconnect|dns-prefetch)\b[^>]*>/gi, "");
  chunk = chunk.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*content-security-policy\b[^>]*>/gi, "");
  chunk = chunk.replace(/<meta\b[^>]*\bname\s*=\s*["']?\s*referrer\b[^>]*>/gi, "");

  // We rewrite bodies, so an SRI hash can never match and the browser would refuse
  // the asset outright. crossorigin forces CORS mode on now-same-origin requests.
  chunk = chunk.replace(/\s(integrity|crossorigin|nonce)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>=`]+)/gi, "");
  chunk = chunk.replace(/\s(integrity|crossorigin)(?=[\s>])/gi, "");

  chunk = chunk.replace(URL_ATTR, (m, attr, raw) => {
    const { q, s } = unquote(raw);
    const mapped = mapUrl(s, page, sid);
    return mapped === s ? m : attr + "=" + q + mapped + q;
  });

  chunk = chunk.replace(SRCSET_ATTR, (m, attr, raw) => {
    const { q, s } = unquote(raw);
    const out = splitSrcset(s).map((part) => {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) return "";
      return mapUrl(bits[0], page, sid) + (bits[1] ? " " + bits[1] : "");
    }).filter(Boolean).join(", ");
    return attr + "=" + q + out + q;
  });

  chunk = chunk.replace(STYLE_ATTR, (m, raw) => {
    const { q, s } = unquote(raw);
    return "style=" + q + rewriteCss(s, page, sid) + q;
  });

  chunk = chunk.replace(META_REFRESH, (m, head, raw) => {
    const { q, s } = unquote(raw);
    return head + q + s.replace(/(\burl\s*=\s*)(\S+)/i, (mm, k, v) => k + mapUrl(v, page, sid)) + q;
  });

  return chunk;
}

// Candidates are comma-separated, but a data: URL can contain commas of its own,
// so a plain split() mangles them.
function splitSrcset(s) {
  const out = [];
  let depth = 0, start = 0, inData = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (s.startsWith("data:", i) && !inData) inData = true;
    else if (inData && /\s/.test(c)) inData = false;
    else if (c === "," && depth === 0 && !inData) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

function rewriteCss(css, page, sid) {
  if (!css) return css;
  return css
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, v) => {
      const mapped = mapUrl(v, page, sid);
      return mapped === v ? m : "url(" + q + mapped + q + ")";
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, v) => "@import " + q + mapUrl(v, page, sid) + q);
}

/* ------------------------------------------------------------ interceptor -- */

// Injected before the page's own scripts. Three jobs:
//  1. Reroute URLs the server can't see — anything built at runtime, plus every
//     ROOT-relative "/foo", which would otherwise resolve against THIS host.
//  2. Rescue root-relative URLs built from location.* (the origin re-map below),
//     which is the single highest-value trick here.
//  3. Paper over the sandbox. The frame runs without allow-same-origin, so it has
//     an opaque origin where localStorage and document.cookie THROW on access.
//     Plenty of sites touch those during startup and die, taking every event
//     handler they were about to attach with them.
// The one hole the path-prefix scheme leaves open: a ROOT-relative ES module
// specifier. ChatGPT's boot script is literally
//   <script type="module">import "/cdn/assets/manifest-x.js"</script>
// which resolves against OUR origin and 404s, so the app never starts. It can't
// be patched at runtime — the browser resolves import specifiers itself, so
// hooking fetch does nothing — and rewriting script bodies is what corrupted
// inline JS in the old build. An import map fixes it declaratively: a key ending
// in "/" is a prefix mapping, so "/" catches every root-relative specifier and
// re-points it at the proxy. Must come before any module script.
function importMap(target, sid) {
  const prefix = "/api/p/" + sid + "/" + target.protocol.slice(0, -1) + "/" + target.host + "/";
  const json = JSON.stringify({ imports: { "/": prefix, [target.origin + "/"]: prefix } })
    .replace(/</g, "\\u003c");
  return '<script type="importmap">' + json + "</scr" + "ipt>";
}

function interceptor(pageUrl, sid) {
  const cfg = JSON.stringify({ page: pageUrl, root: "/api/p/" + sid + "/" });

  const body = "(function(){var C=" + cfg + ";" +
    "var O=new URL(C.page),SELF=location.origin;" +
    "var SKIP=/^(#|data:|blob:|javascript:|mailto:|tel:|sms:|about:)/i;" +

    "function P(u){if(u==null)return u;var s=String(u);if(!s||SKIP.test(s))return u;" +
      "if(s.lastIndexOf('/api/p/',0)===0)return u;" +
      "try{var a=new URL(s,C.page);" +
      // Built from location.origin/href by page code: the path is meant for the
      // target, not for us. This is what rescues `new URL('/api/x', location.origin)`.
      "if(a.origin===SELF&&a.pathname.lastIndexOf('/api/p/',0)!==0){a=new URL(a.pathname+a.search+a.hash,O.origin);}" +
      "if(a.protocol!=='http:'&&a.protocol!=='https:')return u;" +
      "return C.root+a.protocol.slice(0,-1)+'/'+a.host+a.pathname+a.search+a.hash;}catch(e){return u;}}" +

    // Turn one of our urls back into the real one, so page code that reads an
    // attribute back sees what it originally set.
    "function U(v){try{var s=String(v);var i=s.indexOf('/api/p/');if(i<0)return v;" +
      "var p=s.slice(i).split('/');return p[4]+'://'+p[5]+'/'+p.slice(6).join('/');}catch(e){return v;}}" +

    // --- sandbox shims first: page scripts must never hit a throwing accessor ---
    "(function(){function mem(){var m={};return{getItem:function(k){return k in m?m[k]:null;}," +
      "setItem:function(k,v){m[k]=String(v);},removeItem:function(k){delete m[k];}," +
      "clear:function(){m={};},key:function(i){return Object.keys(m)[i]||null;}," +
      "get length(){return Object.keys(m).length;}};}" +
      "['localStorage','sessionStorage'].forEach(function(k){try{window[k].getItem('__p');}catch(e){" +
        "try{Object.defineProperty(window,k,{configurable:true,value:mem()});}catch(e2){}}});" +
      "try{document.cookie;}catch(e){try{var jar='';" +
        "Object.defineProperty(Document.prototype,'cookie',{configurable:true," +
        "get:function(){return jar;}," +
        "set:function(v){var p=String(v).split(';')[0];if(p.indexOf('=')>0)jar=jar?jar+'; '+p:p;}});}catch(e2){}}" +
      "try{if(!('indexedDB' in window)||!window.indexedDB)Object.defineProperty(window,'indexedDB',{configurable:true,value:null});}catch(e){}" +
    "})();" +

    "var _f=window.fetch;if(_f)window.fetch=function(i,o){try{" +
      "if(typeof i==='string'||i instanceof URL)i=P(i);else if(i&&i.url)i=new Request(P(i.url),i);" +
    "}catch(e){}return _f.call(this,i,o);};" +

    "var _x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){" +
      "try{arguments[1]=P(u);}catch(e){}return _x.apply(this,arguments);};" +

    "if(navigator.sendBeacon){var _b=navigator.sendBeacon.bind(navigator);" +
      "navigator.sendBeacon=function(u,d){try{u=P(u);}catch(e){}return _b(u,d);};}" +

    "var _sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){" +
      "try{if(/^(src|href|action|formaction|poster)$/i.test(n))v=P(v);}catch(e){}" +
      "return _sa.call(this,n,v);};" +

    "function hook(pr,p){try{var d=Object.getOwnPropertyDescriptor(pr,p);if(!d||!d.set)return;" +
      "Object.defineProperty(pr,p,{configurable:true,enumerable:d.enumerable," +
      "get:function(){return U(d.get.call(this));}," +
      "set:function(v){try{v=P(v);}catch(e){}d.set.call(this,v);}});}catch(e){}}" +
    "hook(HTMLImageElement.prototype,'src');hook(HTMLScriptElement.prototype,'src');" +
    "hook(HTMLLinkElement.prototype,'href');hook(HTMLIFrameElement.prototype,'src');" +
    "hook(HTMLMediaElement.prototype,'src');hook(HTMLSourceElement.prototype,'src');" +
    "hook(HTMLFormElement.prototype,'action');hook(HTMLAnchorElement.prototype,'href');" +
    "hook(HTMLObjectElement.prototype,'data');" +

    // A relative url already resolves correctly under the path prefix; an absolute
    // one would jump the browser clean out of the proxy path.
    "['pushState','replaceState'].forEach(function(k){var _h=history[k];if(!_h)return;" +
      "history[k]=function(a,b,u){try{if(u!=null)u=P(u);}catch(e){}return _h.call(this,a,b,u);};});" +
    "var _op=window.open;if(_op)window.open=function(u,n,f){try{if(u)u=P(u);}catch(e){}return _op.call(window,u,n,f);};" +

    "try{var _W=window.Worker;if(_W)window.Worker=function(u,o){return new _W(P(u),o);};}catch(e){}" +
    "try{var _S=window.SharedWorker;if(_S)window.SharedWorker=function(u,o){return new _S(P(u),o);};}catch(e){}" +
    "try{var _E=window.EventSource;if(_E)window.EventSource=function(u,o){return new _E(P(u),o);};}catch(e){}" +

    // A service worker registered here would sit at the proxy's scope and start
    // intercepting every OTHER proxied site. Never let one install.
    "try{if(navigator.serviceWorker){navigator.serviceWorker.register=function(){" +
      "return Promise.resolve({scope:location.href,update:function(){}," +
      "unregister:function(){return Promise.resolve(true);}});};}}catch(e){}" +

    // The old build replaced WebSocket with a function that threw. Throwing from a
    // constructor kills the calling script outright; an inert socket lets the site
    // take its own connection-failed path and carry on.
    "try{var WS=function(u){this.readyState=3;this.url=String(u||'');this.bufferedAmount=0;" +
      "this.onopen=this.onerror=this.onclose=this.onmessage=null;var self=this;" +
      "setTimeout(function(){try{self.onerror&&self.onerror({type:'error',target:self});" +
      "self.onclose&&self.onclose({type:'close',code:1006,wasClean:false,target:self});}catch(e){}},0);};" +
      "WS.prototype.send=function(){};WS.prototype.close=function(){};" +
      "WS.prototype.addEventListener=function(){};WS.prototype.removeEventListener=function(){};" +
      "WS.prototype.dispatchEvent=function(){return false;};" +
      "WS.CONNECTING=0;WS.OPEN=1;WS.CLOSING=2;WS.CLOSED=3;" +
      "WS.prototype.CONNECTING=0;WS.prototype.OPEN=1;WS.prototype.CLOSING=2;WS.prototype.CLOSED=3;" +
      "window.WebSocket=WS;}catch(e){}" +

    // Anything the page injects later: ads, lazy images, router-rendered links.
    "try{new MutationObserver(function(ms){ms.forEach(function(r){" +
      "(r.addedNodes||[]).forEach(function(n){if(n.nodeType!==1)return;" +
        "['src','href','action','poster'].forEach(function(a){" +
          "if(n.hasAttribute&&n.hasAttribute(a)){var v=n.getAttribute(a),x=P(v);" +
          "if(x!==v)_sa.call(n,a,x);}});});});})" +
      ".observe(document.documentElement,{childList:true,subtree:true});}catch(e){}" +
    "})();";

  return "<script>" + body + "</scr" + "ipt>";
}

/* -------------------------------------------------------------- ssrf/util -- */

function text(status, body) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

// Keep the proxy pointed at the public internet: no loopback, no private ranges,
// no cloud metadata. Numeric hosts are normalised first, because 127.0.0.1 can be
// spelled 2130706433 or 0177.0.0.1 and still resolve.
function isBlockedHost(host) {
  host = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
      host.endsWith(".localhost")) return true;

  if (host.includes(":")) {                                  // IPv6
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;         // unique local
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;         // link local
    const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(host);            // ::ffff:127.0.0.1
    return v4 ? isBlockedHost(v4[1]) : false;
  }

  const octets = numericHost(host);
  if (!octets) return false;                                 // a name — DNS decides
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;                   // link local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;         // CGNAT
  if (a >= 224) return true;                                 // multicast / reserved
  return false;
}

// Accept the odd-but-legal spellings of an IPv4 address: dotted decimal, octal,
// hex, and the bare 32-bit integer form.
function numericHost(host) {
  const parts = host.split(".");
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0x[0-9a-f]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^\d+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  if (nums.length === 4) return nums.every((n) => n <= 255) ? nums : null;
  if (nums.length === 1) {
    const n = nums[0];
    if (n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  return null;
}
