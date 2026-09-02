# Panel QA harness

Lets you open the moderation panel (`../../panel/`) against an in-memory fake Supabase, so every
screen can be checked without staff credentials.

- `dev.html` — the panel with `supabase-mock.js` + `fixtures.js` in front of the real `panel/js` files.
  Open it via `file://` (Chrome needs `--allow-file-access-from-files`) or any static server from the repo root.
  Query params: `?as=<username>` signs in directly (`kai.mod` Moderator, `qav45` Supervisor, `ash.vellum` Sr Admin,
  `rin.helper` Helper, `lia.admin` Admin on Instellar 2), `&server=instellar2`, `&open=<data-action|punish|punish-protected|punish-banned|player>`
  opens a modal, and `#<screen>` / `#<screen>/<param>` picks the screen. A hidden `<pre id="__dbg">` holds JS errors,
  the auth state and the mock query log (grep it from `chrome --headless=new --dump-dom`).
- `flow.html` — an end-to-end scripted flow (`flow-body.js`) that punishes, protects, approves, manages staff, switches
  server, logs out and back in; results land in `<pre id="__test">`.
- `check.js` — static checker for the panel sources: every `<button>` has `type=`, every `data-action` is handled,
  every `data-goto` targets a registered screen, DB strings go through `P.esc()`, no `100vh`/inline handlers/external
  URLs, contrast of the ink tokens, `node --check`. `node tools/panel-qa/check.js` exits 1 on any failure.

Screenshot example (Windows):
```
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1440,1000 --virtual-time-budget=6000 --allow-file-access-from-files \
  --screenshot=out.png "file:///<repo>/tools/panel-qa/dev.html?as=qav45#supdash"
```
Fixture data is invented; the password check in the mock accepts `test` for every account.
