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
