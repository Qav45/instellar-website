// Cloudflare Worker — server-side search + web proxy for instellar.net.
//
//   GET /api/search?q=<query>          Google Custom Search JSON API, called server-side
//   GET /api/proxy?url=<encoded url>   fetches the page on the SERVER, rewriting every
//                                      link/asset/runtime request back through here
//
// Attached to the route instellar.net/api/* (see wrangler.toml). Everything else on
// instellar.net is still served by GitHub Pages. Because this runs on the same
// domain, the browser only ever connects to instellar.net — it never resolves or
// contacts the proxied site, so a domain-level block on that site doesn't apply.
//
// NOTE: this is an OPEN proxy. Anyone who knows the URL can fetch arbitrary pages
// through it, and the traffic is attributable to instellar.net. Basic SSRF guards
// below block localhost, private ranges and cloud-metadata addresses.

// Overridable with `wrangler secret put SEARCH_API_KEY` / SEARCH_ENGINE_ID.
const KEY_FALLBACK = "AIzaSyD1_uLaghiAergBkaM5gV7NX-7fTmhf8r8";
const CX_FALLBACK = "95460305a59bc4f8a";

export default {
  async fetch(request, env) {
    const here = new URL(request.url);
    if (here.pathname === "/api/search") return search(here, env);
    if (here.pathname === "/api/proxy") return proxy(request, here);
    return new Response("Not found", { status: 404 });
  },
};

async function search(here, env) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  };
  const q = here.searchParams.get("q");
  if (!q) return new Response(JSON.stringify({ error: "missing q" }), { status: 400, headers });

  const key = (env && env.SEARCH_API_KEY) || KEY_FALLBACK;
  const cx = (env && env.SEARCH_ENGINE_ID) || CX_FALLBACK;
  const api = "https://www.googleapis.com/customsearch/v1?key=" + encodeURIComponent(key) +
    "&cx=" + encodeURIComponent(cx) + "&num=10&q=" + encodeURIComponent(q);

  try {
    const r = await fetch(api);
    // Pass Google's status + body straight through so the page can show real errors.
    return new Response(await r.text(), { status: r.status, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: "search failed: " + e.message }), { status: 502, headers });
  }
}

async function proxy(request, here) {
  const target = here.searchParams.get("url");
  if (!target) return new Response("Missing ?url", { status: 400 });

  let url;
  try { url = new URL(target); } catch (_) { return new Response("Bad url", { status: 400 }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return new Response("Only http/https", { status: 400 });
  }
  if (isBlockedHost(url.hostname)) return new Response("Host not allowed", { status: 403 });

  let upstream;
  try {
    upstream = await fetch(url.href, {
      redirect: "follow",
      headers: {
        "user-agent": request.headers.get("user-agent") || "Mozilla/5.0",
        "accept": request.headers.get("accept") || "*/*",
        "accept-language": request.headers.get("accept-language") || "en-US,en;q=0.9",
      },
    });
  } catch (e) {
    const cause = e && e.cause ? (e.cause.code || e.cause.message || e.cause) : "";
    return new Response("Upstream fetch failed: " + e.message + (cause ? " (" + cause + ")" : "") +
      " — for " + url.href, { status: 502 });
  }

  const ct = upstream.headers.get("content-type") || "";
  // Fresh headers only. Upstream's x-frame-options / CSP would break the in-page
  // iframe embed, and set-cookie would leak the target's state onto instellar.net.
  const headers = (type) => ({
    "content-type": type || "application/octet-stream",
    "access-control-allow-origin": "*",
  });

  // Absolute-ise a possibly-relative URL against the page we fetched.
  const abs = (u) => { try { return new URL(u, url.href).href; } catch (_) { return null; } };
  // Wrap an absolute URL so it loads back through this proxy, on this same origin.
  const base = here.origin + "/api/proxy?url=";
  const prox = (u) => base + encodeURIComponent(u);
  const skip = (v) => /^\s*(#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(v);
  const rewriteCssUrls = (css) => css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, v) => {
      if (skip(v)) return m; const a = abs(v); return a ? "url(" + q + prox(a) + q + ")" : m;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, v) => {
      const a = abs(v); return a ? "@import " + q + prox(a) + q : m;
    });

  if (ct.includes("text/html")) {
    let html = await upstream.text();
    // href / src / action / poster
    html = html.replace(/\b(href|src|action|poster)\s*=\s*("|')(.*?)\2/gi, (m, attr, q, v) => {
      if (skip(v)) return m; const a = abs(v); return a ? attr + "=" + q + prox(a) + q : m;
    });
    // srcset (comma-separated "url descriptor" pairs)
    html = html.replace(/\bsrcset\s*=\s*("|')(.*?)\1/gi, (m, q, list) => {
      const out = list.split(",").map((part) => {
        const bits = part.trim().split(/\s+/);
        const a = abs(bits[0]); if (!a) return part.trim();
        return prox(a) + (bits[1] ? " " + bits[1] : "");
      }).join(", ");
      return "srcset=" + q + out + q;
    });
    // inline + <style> css url()/@import
    html = rewriteCssUrls(html);
    // Inject the runtime interceptor FIRST so it patches fetch/XHR/etc. before any
    // of the page's own scripts run — this is what stops requests going straight to
    // the target domain.
    const inject = interceptor(base, url.href);
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + inject);
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => m + inject);
    else html = inject + html;
    return new Response(html, { status: upstream.status, headers: headers("text/html; charset=utf-8") });
  }

  if (ct.includes("css")) {
    const css = await upstream.text();
    return new Response(rewriteCssUrls(css), { status: upstream.status, headers: headers(ct) });
  }

  // Everything else (images, fonts, scripts, media): stream the bytes through.
  return new Response(upstream.body, { status: upstream.status, headers: headers(ct) });
}

// Inline script injected into every proxied HTML page. It runs before the site's own
// scripts and reroutes runtime requests (fetch, XHR, sendBeacon, dynamically set
// src/href, newly inserted nodes) back through this proxy, so the browser never
// connects to the target domain directly. WebSocket is blocked (can't be proxied
// here) rather than allowed to leak a direct connection.
function interceptor(proxyBase, origin) {
  const PROXY = JSON.stringify(proxyBase);      // "https://instellar.net/api/proxy?url="
  const ORIGIN = JSON.stringify(origin);        // real URL of this page
  return "<script>(function(){" +
    "var PROXY=" + PROXY + ",ORIGIN=" + ORIGIN + ";" +
    "function isP(u){return u.indexOf(PROXY)===0||u.indexOf('/api/proxy?url=')>-1;}" +
    "function P(u){if(u==null)return u;u=String(u);" +
      "if(!u||u[0]==='#'||/^(data:|blob:|javascript:|mailto:|tel:|about:)/i.test(u))return u;" +
      "if(isP(u))return u;var a;try{a=new URL(u,ORIGIN).href;}catch(e){return u;}" +
      "if(!/^https?:/i.test(a))return u;return PROXY+encodeURIComponent(a);}" +
    "function U(v){try{var i=v.indexOf('url=');if(v.indexOf('/api/proxy?url=')>-1&&i>-1)return decodeURIComponent(v.slice(i+4));}catch(e){}return v;}" +
    "var _f=window.fetch;if(_f)window.fetch=function(i,o){try{if(typeof i==='string')i=P(i);else if(i&&i.url)i=new Request(P(i.url),i);}catch(e){}return _f.call(this,i,o);};" +
    "var _o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=P(u);}catch(e){}return _o.apply(this,arguments);};" +
    "if(navigator.sendBeacon){var _b=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){try{u=P(u);}catch(e){}return _b(u,d);};}" +
    "var _sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){try{if(/^(src|href|action|poster)$/i.test(n))v=P(v);}catch(e){}return _sa.call(this,n,v);};" +
    "function hook(pr,p){try{var d=Object.getOwnPropertyDescriptor(pr,p);if(!d||!d.set)return;" +
      "Object.defineProperty(pr,p,{configurable:true,enumerable:d.enumerable," +
      "get:function(){return U(d.get.call(this));},set:function(v){try{v=P(v);}catch(e){}d.set.call(this,v);}});}catch(e){}}" +
    "hook(HTMLImageElement.prototype,'src');hook(HTMLScriptElement.prototype,'src');hook(HTMLLinkElement.prototype,'href');" +
    "hook(HTMLIFrameElement.prototype,'src');hook(HTMLMediaElement.prototype,'src');hook(HTMLSourceElement.prototype,'src');" +
    "try{new MutationObserver(function(ms){ms.forEach(function(m){(m.addedNodes||[]).forEach(function(n){if(n.nodeType!==1)return;" +
      "['src','href','poster'].forEach(function(a){if(n.hasAttribute&&n.hasAttribute(a)){var v=n.getAttribute(a),x=P(v);if(x!==v)_sa.call(n,a,x);}});});});})" +
      ".observe(document.documentElement,{childList:true,subtree:true});}catch(e){}" +
    "try{window.WebSocket=function(){throw new Error('blocked by proxy');};}catch(e){}" +
    "})();</scr" + "ipt>";
}

// Block localhost, private/link-local ranges and cloud metadata so the proxy can't
// be pointed at internal infrastructure.
function isBlockedHost(host) {
  host = (host || "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "[::1]") return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;           // link-local / metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}
