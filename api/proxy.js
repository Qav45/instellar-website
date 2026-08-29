// Server-side web proxy (Vercel serverless function).
//
// GET /api/proxy?url=<encoded absolute url>
// Fetches the target page on the SERVER and streams it back, rewriting links,
// assets and CSS so every sub-request also routes back through this proxy. The
// browser therefore only ever talks to this Vercel domain — the target host is
// never contacted directly by the client.
//
// This is deployed alongside the static site (import this repo into Vercel).
// GitHub Pages ignores it; only Vercel runs it.
//
// NOTE: this is an OPEN proxy — anyone who knows the URL can use it to fetch
// arbitrary pages through your Vercel project (subject to its usage limits).
// Keep the deployment URL to yourself. Basic SSRF guards below block localhost,
// private ranges and cloud-metadata addresses.

module.exports = async (req, res) => {
  const target = req.query && req.query.url;
  if (!target) { res.status(400).send("Missing ?url"); return; }

  let url;
  try { url = new URL(target); } catch (_) { res.status(400).send("Bad url"); return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    res.status(400).send("Only http/https"); return;
  }
  if (isBlockedHost(url.hostname)) { res.status(403).send("Host not allowed"); return; }

  let upstream;
  try {
    upstream = await fetch(url.href, {
      redirect: "follow",
      headers: {
        "user-agent": req.headers["user-agent"] || "Mozilla/5.0",
        "accept": req.headers["accept"] || "*/*",
        "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
      },
    });
  } catch (e) {
    const cause = e && e.cause ? (e.cause.code || e.cause.message || e.cause) : "";
    res.status(502).send("Upstream fetch failed: " + e.message + (cause ? " (" + cause + ")" : "") +
      " — for " + url.href); return;
  }

  const ct = upstream.headers.get("content-type") || "";
  // Let the proxied page be framed / loaded freely.
  res.setHeader("access-control-allow-origin", "*");

  // Absolute-ise a possibly-relative URL against the page we fetched.
  const abs = (u) => { try { return new URL(u, url.href).href; } catch (_) { return null; } };
  // Wrap an absolute URL so it loads back through this proxy.
  const base = "https://" + req.headers.host + "/api/proxy?url=";
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
    // Inject the runtime interceptor FIRST so it patches fetch/XHR/etc. before
    // any of the page's own scripts run — this is what stops requests going
    // straight to the target domain.
    const inject = interceptor(base, url.href);
    if (/<head[^>]*>/i.test(html))      html = html.replace(/<head[^>]*>/i, (m) => m + inject);
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => m + inject);
    else                                html = inject + html;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.status(upstream.status).send(html);
    return;
  }

  if (ct.includes("css")) {
    const css = await upstream.text();
    res.setHeader("content-type", ct);
    res.status(upstream.status).send(rewriteCssUrls(css));
    return;
  }

  // Everything else (images, fonts, scripts, etc.): stream the bytes through.
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.setHeader("content-type", ct || "application/octet-stream");
  res.status(upstream.status).send(buf);
};

// Inline script injected into every proxied HTML page. It runs before the site's
// own scripts and reroutes runtime requests (fetch, XHR, sendBeacon, dynamically
// set src/href, newly inserted nodes) back through this proxy, so the browser
// never connects to the target domain directly. WebSocket is blocked (can't be
// proxied on serverless) rather than allowed to leak a direct connection.
function interceptor(proxyBase, origin) {
  const PROXY = JSON.stringify(proxyBase);      // "https://host/api/proxy?url="
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

// Block localhost, private/link-local ranges and cloud metadata so the proxy
// can't be pointed at internal infrastructure.
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
