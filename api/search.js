// Server-side Google search (Vercel serverless function).
//
// GET /api/search?q=<query>
// Calls Google's Custom Search JSON API on the SERVER and returns its JSON
// verbatim, so the browser searches through this Vercel domain instead of
// calling googleapis.com directly (no client-side CORS/referrer issues, and
// the API key stays off the page — set it as a Vercel env var if you like).
//
// The key/cx can come from Vercel Environment Variables (SEARCH_API_KEY /
// SEARCH_ENGINE_ID) or fall back to the values below.

const KEY = process.env.SEARCH_API_KEY || "AIzaSyD1_uLaghiAergBkaM5gV7NX-7fTmhf8r8";
const CX  = process.env.SEARCH_ENGINE_ID || "95460305a59bc4f8a";

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  const q = req.query && req.query.q;
  if (!q) { res.status(400).json({ error: "missing q" }); return; }

  const url = "https://www.googleapis.com/customsearch/v1?key=" +
    encodeURIComponent(KEY) + "&cx=" + encodeURIComponent(CX) +
    "&num=10&q=" + encodeURIComponent(q);

  try {
    const r = await fetch(url);
    const data = await r.json();
    res.status(r.status).json(data);   // pass Google's status + body straight through
  } catch (e) {
    res.status(502).json({ error: "search failed: " + e.message });
  }
};
