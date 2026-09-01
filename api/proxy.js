// Compatibility shim for the old query-param proxy.
//
//   GET /api/proxy?url=<encoded absolute url>
//
// The proxy now lives at /api/p/<sid>/<scheme>/<host>/<path> — see
// api/p/[...path].mjs for why. This redirects the old form to the new one so any
// bookmarked or in-flight URL keeps working, and so the page and the functions can
// be deployed independently.
//
// No session id is minted here; the real handler does that and bounces again.

module.exports = (req, res) => {
  const target = req.query && req.query.url;
  if (!target) { res.status(400).send("Missing ?url"); return; }

  let u;
  try { u = new URL(target); } catch (_) { res.status(400).send("Bad url"); return; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    res.status(400).send("Only http/https"); return;
  }

  res.setHeader("cache-control", "no-store");
  res.setHeader("location",
    "/api/p/" + u.protocol.slice(0, -1) + "/" + u.host + u.pathname + u.search);
  res.status(302);
  res.end();
};
