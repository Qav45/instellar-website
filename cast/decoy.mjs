// A Google Classroom lookalike, drawn locally. Built once and kept hidden, so
// show() is a single style change on a layer that is already laid out - no
// network, nothing to load. It covers the whole viewer, desktop and toolbar.
// The page is a plain imitation made for this page: no Google logo or assets.

const HTML = `
<div class="dc-top">
  <span class="dc-burger">&#9776;</span>
  <span class="dc-word">Classroom</span>
  <span class="dc-grow"></span>
  <span class="dc-plus">+</span>
  <span class="dc-me">B</span>
</div>
<div class="dc-grid">
  ${[
    ["English 10", "Period 2", "#1e8e3e"],
    ["Algebra II", "Period 3", "#1967d2"],
    ["Biology", "Period 4", "#e37400"],
    ["U.S. History", "Period 6", "#a142f4"],
    ["Spanish II", "Period 7", "#d93025"],
    ["Study Hall", "Period 8", "#3c4043"],
  ].map(([name, sub, color]) => `
  <div class="dc-card">
    <div class="dc-band" style="background:${color}"><b>${name}</b><small>${sub}</small></div>
    <div class="dc-body"></div>
    <div class="dc-foot">&#128193; &nbsp; &#128200;</div>
  </div>`).join("")}
</div>`;

const CSS = `
#decoy { display:none; position:fixed; inset:0; z-index:100000; background:#fff; color:#202124;
         font-family:"Google Sans",Roboto,Arial,sans-serif; overflow:auto; }
#decoy .dc-top { display:flex; align-items:center; gap:16px; height:64px; padding:0 20px;
                 border-bottom:1px solid #dadce0; background:#fff; position:sticky; top:0; }
#decoy .dc-burger { font-size:22px; color:#5f6368; }
#decoy .dc-word { font-size:22px; color:#5f6368; }
#decoy .dc-grow { flex:1; }
#decoy .dc-plus { font-size:28px; color:#5f6368; }
#decoy .dc-me { width:32px; height:32px; border-radius:50%; background:#1a73e8; color:#fff;
                display:flex; align-items:center; justify-content:center; font-size:16px; }
#decoy .dc-grid { display:flex; flex-wrap:wrap; gap:24px; padding:24px; }
#decoy .dc-card { width:304px; height:288px; border:1px solid #dadce0; border-radius:8px;
                  display:flex; flex-direction:column; overflow:hidden; background:#fff; }
#decoy .dc-band { height:100px; padding:16px; color:#fff; display:flex; flex-direction:column; gap:4px; }
#decoy .dc-band b { font-size:22px; font-weight:500; }
#decoy .dc-band small { font-size:14px; }
#decoy .dc-body { flex:1; }
#decoy .dc-foot { height:52px; border-top:1px solid #dadce0; display:flex; align-items:center;
                  justify-content:flex-end; padding:0 16px; color:#5f6368; }`;

let el = null, savedTitle = "";

function build() {
  if (el) return;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  el = document.createElement("div");
  el.id = "decoy";
  el.innerHTML = HTML;
  document.body.appendChild(el);
}

export function prepare() { build(); }

export function show() {
  build();
  savedTitle = document.title;
  document.title = "Classroom";
  el.style.display = "block";
}

export function hide() {
  if (!el) return;
  el.style.display = "none";
  if (savedTitle) document.title = savedTitle;
}
