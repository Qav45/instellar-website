/* =========================================================================
   Instellar moderation panel — core
   -------------------------------------------------------------------------
   Everything lives on window.P (plain script files, no modules, no build).
   Load order: vendor/supabase.js, js/core.js, js/api.js, js/shell.js,
   js/punish.js, js/screens/*.js, then P.boot() (inline in index.html).

   CONTRACT FOR SCREEN MODULES
     P.registerScreen(key, {
       title: 'History',                       // topbar <h1>
       nav: { label:'History', icon:'audit', order:40,
              show(s){return true}, count(s){return 0} },   // omit nav => not in sidebar
       guard(s){ return true },                // false => redirected to dashboard
       render(root, s){ root.innerHTML = ... },// MUST P.esc() every DB string
       onAction(action, el, ev, s){},          // click on [data-action] inside root
       onInput(field, el, ev, s){},            // input/change on [data-field] inside root
       onEnter(s){}, onLeave(s){}              // optional
     });
   Rules: a screen only touches P.state.ui[key] (via P.ui(key, defaults)) and
   calls P.api.*; api writes P.state.data then calls P.rerender(). Every
   <button> carries type="button". Ids inside screen HTML are prefixed with
   the screen key. Interactive elements use data-action / data-field /
   data-goto — no inline handlers.
     data-goto="audit" or data-goto="players/Name" → P.route()
     data-action="x"                              → screen/modal onAction('x', el)
     data-field="q"                               → onInput('q', el) on input/change
     data-field="q" data-enter="submit"           → Enter key → onAction('submit', el)
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P = window.P || {};

  P.cfg = {
    SB_URL: 'https://jaednahuxpjwrqjqytrt.supabase.co',
    SB_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphZWRuYWh1eHBqd3JxanF5dHJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2MzgwODQsImV4cCI6MjA5OTIxNDA4NH0.N30ZCl1afMAMFGd-D--5Ulq7VP4qB9aiBQbdRmwDumQ',
    SERVERS: [['instellar1', 'Instellar 1'], ['instellar2', 'Instellar 2']],
    PRESENCE_MS: 75000,      // presence row older than this = offline
    POLL_MS: 15000,
    TOAST_MS: 4200
  };

  var savedServer = null;
  try { savedServer = localStorage.getItem('instellar_server'); } catch (e) {}

  P.state = {
    authed: false,
    me: null,
    server: savedServer || 'instellar1',
    screen: 'dashboard',
    param: null,
    loginError: '',
    booting: true,
    data: {
      // current server
      actions: [], staff: [], notes: [], presence: [], logs: [], guides: [], anns: [], blacklist: [], templates: [],
      // both servers (dashboards / protection)
      recent30: [], presenceAll: [], staffAll: [], protected: [], blocks: [], staffAudit: [], serverStatus: [],
      protectionError: null, auditError: null
    },
    ui: {}
  };

  P.ui = function (key, defaults) {
    var s = P.state.ui;
    if (!s[key]) { s[key] = {}; if (defaults) Object.keys(defaults).forEach(function (k) { s[key][k] = defaults[k]; }); }
    else if (defaults) Object.keys(defaults).forEach(function (k) { if (!(k in s[key])) s[key][k] = defaults[k]; });
    return s[key];
  };

  /* ---------------------------------------------------------------------
     helpers
     --------------------------------------------------------------------- */
  P.esc = function (v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  P.safeUrl = function (u) { return /^https?:\/\/\S+$/i.test(String(u || '')) ? String(u) : ''; };
  P.serverName = function (id) { return id === 'instellar2' ? 'Instellar 2' : 'Instellar 1'; };

  P.timeAgo = function (iso) {
    if (!iso) return '—';
    var d = new Date(iso), diff = Date.now() - d.getTime();
    if (isNaN(diff)) return '—';
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + 'd ago';
    return d.toLocaleDateString();
  };
  P.fmtDate = function (iso) { var d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
  P.fmtSize = function (n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
  P.pct = function (a, b) { return b ? Math.round(100 * a / b) : 0; };

  P.initials = function (name) {
    var n = String(name || '?').trim();
    var parts = n.split(/[\s._-]+/).filter(Boolean);
    var s = parts.length >= 2 ? parts[0][0] + parts[1][0] : n.slice(0, 2);
    return s.toUpperCase();
  };
  // Same hash as the old panel's avBg(): stable colour per name.
  P.avClass = function (name) {
    var h = 0, s = String(name || '');
    for (var i = 0; i < s.length; i++) h = (h * 17 + s.charCodeAt(i)) % 997;
    return 'av-' + ((h % 6) + 1);
  };
  P.avatar = function (name, extra) {
    return '<span class="avatar ' + P.avClass(name) + (extra ? ' ' + extra : '') + '" aria-hidden="true">' + P.esc(P.initials(name)) + '</span>';
  };

  P.actionClass = function (t) { return ({ Ban: 'ban', Wipeban: 'wipeban', Kick: 'kick', Mute: 'mute', Warn: 'warn', Unban: 'unban' })[t] || 'warn'; };
  P.typePill = function (t) { return '<span class="type-pill ' + P.actionClass(t) + '">' + P.esc(t) + '</span>'; };
  P.roleClass = function (r) {
    return ({ Supervisor: 'supervisor', Owner: 'owner', Management: 'management', 'Sr Admin': 'admin', Admin: 'admin', 'Jr Admin': 'admin',
      'Sr Moderator': 'moderator', Moderator: 'moderator', 'Jr Moderator': 'moderator', Helper: 'helper', Trainee: 'helper' })[r] || 'helper';
  };
  P.rolePill = function (r) { return '<span class="role-pill ' + P.roleClass(r) + '">' + P.esc(r) + '</span>'; };
  // Executed→Done, Pending→Waiting, Approval→Needs approval, Failed, Denied (PROTECTED → Blocked)
  P.statusLabel = function (st, err) {
    if (st === 'Executed') return { cls: 'ok', text: 'Done' };
    if (st === 'Pending') return { cls: 'muted', text: 'Waiting' };
    if (st === 'Approval') return { cls: 'warn', text: 'Needs approval' };
    if (st === 'Failed') return { cls: 'danger', text: 'Failed' };
    if (st === 'Denied') return /^PROTECTED:/.test(err || '') ? { cls: 'danger', text: 'Blocked (protected)' } : { cls: 'muted', text: 'Denied' };
    if (st === 'Approved') return { cls: 'ok', text: 'Approved' };
    return { cls: 'muted', text: st || '—' };
  };
  P.statusPill = function (st, err) { var l = P.statusLabel(st, err); return '<span class="status ' + l.cls + '">' + P.esc(l.text) + '</span>'; };
  P.isProtectedError = function (err) { return /^PROTECTED:/.test(String(err || '')); };

  /* ---------------------------------------------------------------------
     roles / permissions (ported 1:1 from the old panel)
     --------------------------------------------------------------------- */
  P.rank = function (role) { return ({ Trainee: 1, Helper: 2, 'Jr Moderator': 3, Moderator: 4, 'Sr Moderator': 5, 'Jr Admin': 6, Admin: 7, 'Sr Admin': 8, Management: 9, Owner: 10, Supervisor: 11 })[role] || 0; };
  P.roleList = function () { return ['Trainee', 'Helper', 'Jr Moderator', 'Moderator', 'Sr Moderator', 'Jr Admin', 'Admin', 'Sr Admin', 'Management', 'Owner']; };
  P.PERMS = ['Warn', 'Mute', 'Kick', 'Ban', 'Unban', 'Wipeban', 'Guides', 'Staff management', 'Server config'];
  P.ROLE_DEFAULT_PERMS = { Trainee: ['Mute', 'Kick'], Helper: ['Mute', 'Kick', 'Warn'], 'Jr Moderator': ['Mute', 'Kick', 'Warn'], Moderator: ['Ban', 'Mute', 'Kick', 'Warn'], 'Sr Moderator': ['Ban', 'Mute', 'Kick', 'Warn'], 'Jr Admin': ['Ban', 'Unban', 'Mute', 'Kick', 'Warn'], Admin: ['Ban', 'Unban', 'Mute', 'Kick', 'Warn', 'Staff management'], 'Sr Admin': ['Ban', 'Unban', 'Mute', 'Kick', 'Warn', 'Staff management', 'Server config'], Management: ['Ban', 'Unban', 'Mute', 'Kick', 'Warn', 'Staff management', 'Server config'], Owner: ['All permissions'] };

  P.durationDays = function (d) {
    if (!d) return Infinity;
    var m = String(d).trim().toLowerCase().match(/^(\d+)\s*(second|minute|hour|day|week|month|year)s?$/);
    if (!m) return Infinity;
    var per = { second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2]];
    return Number(m[1]) * per;
  };
  P.requiredRole = function (type, duration) {
    if (type === 'Unban') return 'Admin';
    if (type === 'Wipeban') return 'Admin';
    if (type === 'Ban' && P.durationDays(duration) > 30) return 'Admin';
    if (type === 'Ban') return 'Moderator';
    return 'Helper';
  };
  P.currentRole = function () { return P.state.me ? P.state.me.role : 'Helper'; };
  P.myName = function () { return P.state.me ? P.state.me.display_name : ''; };
  P.needsApproval = function (type, duration) { return P.rank(P.currentRole()) < P.rank(P.requiredRole(type, duration)); };
  P.isPermBan = function (a) { return a.type === 'Wipeban' || (a.type === 'Ban' && P.durationDays(a.duration) > 30); };
  P.hasPerm = function (p) {
    var me = P.state.me; if (!me) return false;
    var perms = me.perms || [];
    return me.username === 'instellarownership' || me.role === 'Owner' || me.role === 'Supervisor' || perms.indexOf(p) > -1 || perms.indexOf('All permissions') > -1;
  };
  P.canWipeban = function () { return P.hasPerm('Wipeban'); };
  P.canServerConfig = function () { return P.hasPerm('Server config'); };
  P.canEditGuides = function () { return P.isOwnership() || P.hasPerm('Guides'); };
  P.isOwnership = function () { var me = P.state.me; return !!me && (me.username === 'instellarownership' || me.role === 'Supervisor'); };
  P.isSupervisor = function () { var me = P.state.me; return !!me && me.role === 'Supervisor'; };
  P.canDecide = function (a) { return P.rank(P.currentRole()) >= P.rank(P.requiredRole(a.type, a.duration)); };

  /* ---------------------------------------------------------------------
     punishment templates (ported 1:1)
     --------------------------------------------------------------------- */
  P.builtinTemplates = function () {
    return [
      { key: 'b-cheat', name: 'Cheating / Hacking', type: 'Ban', steps: ['7 days', '14 days', '30 days', 'Permanent'] },
      { key: 'b-dox', name: 'Doxing / DDoSing', type: 'Ban', steps: ['Permanent'], note: 'For actually doing it. A threat alone is a 1 day mute (use the "Doxing / DDoSing threat" mute).' },
      { key: 'b-exploit', name: 'Exploiting / Bug abuse', type: 'Ban', steps: ['14 days', '30 days', 'Permanent'] },
      { key: 'b-map', name: 'Map abuse / Exploiting', type: 'Ban', steps: ['Warn', '7 days', '14 days', 'Permanent'] },
      { key: 'm-spam', name: 'Spamming', type: 'Mute', steps: ['30 minutes', '3 hours', '1 day', '3 days', '7 days'] },
      { key: 'm-racism', name: 'Racism', type: 'Mute', steps: ['7 days', '14 days'] },
      { key: 'm-toxic', name: 'Toxicity', type: 'Mute', steps: ['3 hours', '1 day', '3 days', '7 days'] },
      { key: 'm-flood', name: 'Flooding chat', type: 'Mute', steps: ['3 hours', '1 day', '3 days', '7 days'] },
      { key: 'm-discrim', name: 'Discrimination', type: 'Mute', steps: ['3 days', '7 days'] },
      { key: 'm-slurs', name: 'Slurs (excessive / NSFW / sexualisation)', type: 'Mute', steps: ['3 hours', '1 day', '3 days', '7 days'] },
      { key: 'm-ads', name: 'Advertising', type: 'Mute', steps: ['1 day', 'Permanent'], note: 'Permanent only if it is mass spam.' },
      { key: 'm-death', name: 'Death threats', type: 'Mute', steps: ['1 day', '14 days'] },
      { key: 'm-doxthreat', name: 'Doxing / DDoSing threat', type: 'Mute', steps: ['1 day'], note: 'Threat only. Actually doing it is a permanent ban.' },
      { key: 'm-info', name: 'Attempting to gain personal information', type: 'Mute', steps: ['7 days'] }
    ];
  };
  P.allTemplates = function () { return P.builtinTemplates().concat(P.state.data.templates || []); };
  P.punishGuidelinesText = function () {
    return [
      '🚫 BANS',
      'Cheating / Hacking → 7d → 14d → 30d → Perm',
      'Doxing / DDoSing (including threats) → a threat is a 1d mute; actually doing it is a perm',
      'Exploiting / Bug abuse → 14d → 30d → Perm',
      'Map abuse / Exploiting → Warn → 7d → 14d → Perm',
      '',
      '🔇 MUTES',
      'Spamming → 30m → 3h → 1d → 3d → 7d',
      'Racism → 7d → 14d',
      'Toxicity → 3h → 1d → 3d → 7d',
      'Flooding chat → 3h → 1d → 3d → 7d',
      'Discrimination → 3d → 7d',
      'Slurs (excessive use / NSFW / sexualisation) → 3h → 1d → 3d → 7d',
      'Advertising → 1d → Perm (if mass spam)',
      'Death threats → 1d → 14d',
      'Attempting to gain personal information → 7d',
      '',
      'Perm means a permanent ban or a wipeban.',
      'If the automute already muted them, please do not redo their mute for the above, even if it is lower than the list. PLEASE still let the automute give the punishment (if it did not, do it yourself).',
      'If it is not on this list, please ask one of us or infer.',
      '',
      'These ladders are also the templates on the Punish a player tab.'
    ].join('\n');
  };
  P.parseSteps = function (text) {
    var units = { s: 'second', sec: 'second', second: 'second', m: 'minute', min: 'minute', minute: 'minute',
      h: 'hour', hr: 'hour', hour: 'hour', d: 'day', day: 'day', w: 'week', week: 'week', mo: 'month', month: 'month', y: 'year', year: 'year' };
    var out = [];
    var parts = String(text).split(/[,\n→>]+/);
    for (var i = 0; i < parts.length; i++) {
      var tok = parts[i].trim().toLowerCase().replace(/^-+|-+$/g, '').trim();
      if (!tok) continue;
      if (tok === 'warn' || tok === 'warning') { out.push('Warn'); continue; }
      if (tok === 'perm' || tok === 'permanent' || tok === 'forever') { out.push('Permanent'); continue; }
      var m = tok.match(/^(\d+)\s*([a-z]+)$/);
      var unit = m ? (units[m[2]] || units[m[2].replace(/s$/, '')]) : null;
      if (!unit) return null;
      var n = Number(m[1]); if (!n) return null;
      out.push(n + ' ' + unit + (n === 1 ? '' : 's'));
    }
    return out.length ? out : null;
  };
  P.templateProblem = function (type, steps) {
    if (!P.hasPerm(type)) return 'You need the ' + type + ' permission to make ' + type + ' templates.';
    if (steps.indexOf('Warn') > -1 && !P.hasPerm('Warn')) return 'A Warn step needs the Warn permission.';
    if (type === 'Ban' && P.rank(P.currentRole()) < P.rank('Admin') && steps.some(function (st) { return st !== 'Warn' && P.durationDays(st) > 30; })) {
      return 'Permanent or over-30-day ban steps need Admin or higher.';
    }
    return null;
  };
  // Which rung of the ladder comes next for this player under this offence.
  P.suggestedStep = function (target, tp) {
    if (!target) return 0;
    var t = target.toLowerCase(), n = tp.name.toLowerCase();
    var prior = (P.state.data.actions || []).filter(function (r) {
      return String(r.target || '').toLowerCase() === t && r.status === 'Executed'
        && ['Warn', 'Mute', 'Ban', 'Wipeban'].indexOf(r.type) > -1 && String(r.reason || '').toLowerCase().indexOf(n) === 0;
    }).length;
    return Math.min(prior, tp.steps.length - 1);
  };
  P.proofVM = function (list) {
    return (Array.isArray(list) ? list : []).filter(function (u) { return typeof u === 'string' && u; }).map(function (url) {
      var e = ((url.split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1] || '').toLowerCase();
      var label = /^(png|jpe?g|gif|webp)$/.test(e) ? 'Screenshot' : /^(mp4|webm|mov)$/.test(e) ? 'Clip' : /^(mp3|wav|ogg|m4a)$/.test(e) ? 'Audio' : 'Link';
      return { url: url, label: label };
    });
  };
  P.proofLinks = function (list) {
    return P.proofVM(list).map(function (p) {
      var u = P.safeUrl(p.url); if (!u) return '';
      return '<a class="proof-link" href="' + P.esc(u) + '" target="_blank" rel="noopener noreferrer">' + P.esc(p.label) + '</a>';
    }).join('');
  };

  /* ---------------------------------------------------------------------
     derived data (shared by several screens)
     --------------------------------------------------------------------- */
  P.isOnline = function (row) { return !!row && (Date.now() - new Date(row.last_seen).getTime()) < P.cfg.PRESENCE_MS; };
  P.presenceOf = function (name) {
    var n = String(name || '').toLowerCase();
    return (P.state.data.presence || []).filter(function (p) { return String(p.name || '').toLowerCase() === n; })[0] || null;
  };
  P.onlinePlayers = function (rows) { return (rows || P.state.data.presence || []).filter(P.isOnline); };
  // Ban/mute status + executed history (newest first) from the current server's actions.
  P.playerRecord = function (name) {
    var n = String(name || '').toLowerCase();
    var rows = (P.state.data.actions || []).filter(function (a) { return String(a.target || '').toLowerCase() === n; });
    var status = 'Clear', history = [];
    rows.slice().reverse().forEach(function (a) {
      if (a.status !== 'Executed') return;
      history.unshift({ row: a, active: a.type === 'Ban' || a.type === 'Wipeban' || a.type === 'Mute' });
      if (a.type === 'Ban' || a.type === 'Wipeban') status = 'Banned';
      if (a.type === 'Mute' && status !== 'Banned') status = 'Muted';
      if (a.type === 'Unban') { status = 'Clear'; history.forEach(function (h) { h.active = false; }); }
    });
    return { status: status, history: history, all: rows };
  };
  P.protectionFor = function (name) {
    var n = String(name || '').trim().toLowerCase(), now = Date.now();
    return (P.state.data.protected || []).filter(function (p) {
      return String(p.name_lc || p.name || '').toLowerCase() === n && (!p.expires_at || new Date(p.expires_at).getTime() > now);
    })[0] || null;
  };
  P.activeProtected = function () {
    var now = Date.now();
    return (P.state.data.protected || []).filter(function (p) { return !p.expires_at || new Date(p.expires_at).getTime() > now; });
  };
  P.staffByName = function (name) {
    var n = String(name || '');
    return (P.state.data.staffAll || []).filter(function (s) { return s.display_name === n; })[0]
      || (P.state.data.staff || []).filter(function (s) { return s.display_name === n; })[0] || null;
  };

  /* ---------------------------------------------------------------------
     screens registry + routing
     --------------------------------------------------------------------- */
  P.screens = {};
  P.registerScreen = function (key, def) { def.key = key; P.screens[key] = def; };

  function resolveKey(key) {
    if (!P.screens[key]) key = 'dashboard';
    if (key === 'dashboard' && P.isSupervisor() && P.screens.supdash) key = 'supdash';
    var def = P.screens[key];
    if (def && def.guard && !def.guard(P.state)) key = P.isSupervisor() && P.screens.supdash ? 'supdash' : 'dashboard';
    return key;
  }
  P.parseHash = function () {
    var h = (location.hash || '').replace(/^#\/?/, '');
    if (!h) return { key: 'dashboard', param: null };
    var i = h.indexOf('/');
    var key = i > -1 ? h.slice(0, i) : h;
    var param = i > -1 ? decodeURIComponent(h.slice(i + 1)) : null;
    return { key: key, param: param };
  };
  var suppressHash = false;
  P.route = function (key, param) {
    if (typeof key === 'string' && key.indexOf('/') > -1 && param === undefined) { var i = key.indexOf('/'); param = decodeURIComponent(key.slice(i + 1)); key = key.slice(0, i); }
    var prev = P.state.screen;
    var next = resolveKey(key);
    if (prev !== next && P.screens[prev] && P.screens[prev].onLeave) { try { P.screens[prev].onLeave(P.state); } catch (e) { console.error(e); } }
    P.state.screen = next;
    P.state.param = param || null;
    var hash = '#' + next + (param ? '/' + encodeURIComponent(param) : '');
    if (location.hash !== hash) { suppressHash = true; try { history.replaceState(null, '', hash); } catch (e) { location.hash = hash; } suppressHash = false; }
    if (P.screens[next] && P.screens[next].onEnter) { try { P.screens[next].onEnter(P.state); } catch (e) { console.error(e); } }
    var page = document.getElementById('page');
    if (page) page.scrollTop = 0;
    P.render();
  };
  window.addEventListener('hashchange', function () {
    if (suppressHash) return;
    var h = P.parseHash();
    P.route(h.key, h.param);
  });

  /* ---------------------------------------------------------------------
     rendering
     --------------------------------------------------------------------- */
  P.render = function () {
    var s = P.state;
    document.body.classList.toggle('is-login', !s.authed);
    document.body.classList.toggle('is-supervisor', P.isSupervisor());
    if (P.renderShell) P.renderShell(s);
    P.rerender();
  };
  // Re-render only the current screen, keeping focus/caret and scroll.
  P.rerender = function () {
    var s = P.state;
    var page = document.getElementById('page');
    if (!page) return;
    var scroll = page.scrollTop;
    var active = document.activeElement, focusField = null, selStart = null, selEnd = null;
    if (active && page.contains(active) && active.getAttribute('data-field')) {
      focusField = active.getAttribute('data-field');
      try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (e) {}
    }
    if (!s.authed) {
      page.innerHTML = '<section class="screen" data-screen="login">' + (P.renderLogin ? P.renderLogin(s) : '') + '</section>';
    } else {
      var def = P.screens[s.screen] || P.screens.dashboard;
      var root = page.querySelector('.screen[data-screen="' + s.screen + '"]');
      if (!root) { page.innerHTML = '<section class="screen" data-screen="' + P.esc(s.screen) + '"></section>'; root = page.firstElementChild; }
      try { def.render(root, s); } catch (e) { console.error(e); root.innerHTML = '<div class="gl-card"><div class="empty">Something went wrong drawing this screen. Reload the page.</div></div>'; }
      if (P.renderNavCounts) P.renderNavCounts(s);
    }
    page.scrollTop = scroll;
    if (focusField) {
      var el = page.querySelector('[data-field="' + focusField + '"]');
      if (el) { el.focus({ preventScroll: true }); if (selStart !== null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selEnd); } catch (e) {} } }
    }
    if (P.modal.current && P.modal.current.rerender) P.modal.current.rerender();
  };

  /* ---------------------------------------------------------------------
     toasts
     --------------------------------------------------------------------- */
  var toastId = 0;
  P.toast = function (kind, msg, sub) {
    var root = document.getElementById('toast-root'); if (!root) return 0;
    var id = ++toastId;
    var el = document.createElement('div');
    el.className = 'gl-toast toast-' + kind;
    el.setAttribute('data-toast', String(id));
    var icon = kind === 'ok' ? '✓' : kind === 'fail' ? '!' : kind === 'pending' ? '…' : 'i';
    el.innerHTML = '<span class="gl-toast-icon">' + icon + '</span><span><span class="gl-toast-text">' + P.esc(msg) + '</span>'
      + (sub ? '<span class="gl-toast-sub">' + P.esc(sub) + '</span>' : '') + '</span>'
      + '<button type="button" class="toast-close" data-toast-close="' + id + '" aria-label="Dismiss">×</button>';
    root.appendChild(el);
    root.hidden = false;
    if (kind !== 'pending') setTimeout(function () { P.dismissToast(id); }, P.cfg.TOAST_MS);
    return id;
  };
  P.dismissToast = function (id) {
    var root = document.getElementById('toast-root'); if (!root) return;
    var el = root.querySelector('[data-toast="' + id + '"]');
    if (el) el.remove();
    if (!root.children.length) root.hidden = true;
  };

  /* ---------------------------------------------------------------------
     modal (one at a time): focus trap, Esc, scrim, aria
       P.openModal({ title, sub, avatarName, html, actions:[{label, action, kind:'primary'|'danger'|'ghost', disabled}],
                     onAction(action, el, ev), onInput(field, el, ev), onClose(), variant:'side'|undefined, wide:true })
       The modal object is returned; call modal.update({html, actions, sub}) to redraw, or P.closeModal().
     --------------------------------------------------------------------- */
  P.modal = { current: null };
  P.openModal = function (opts) {
    P.closeModal();
    var root = document.getElementById('modal-root'); if (!root) return null;
    var m = { opts: opts, opener: document.activeElement, id: 'modal-' + (++toastId) };
    m.update = function (patch) { if (patch) Object.keys(patch).forEach(function (k) { m.opts[k] = patch[k]; }); m.draw(); };
    m.rerender = function () { if (m.opts.rerender) m.opts.rerender(m); };
    m.draw = function () {
      var o = m.opts;
      var scrollBox = root.querySelector('.modal-body');
      var scroll = scrollBox ? scrollBox.scrollTop : 0;
      var active = document.activeElement, focusField = null, selStart = null, selEnd = null;
      if (active && root.contains(active) && active.getAttribute('data-field')) {
        focusField = active.getAttribute('data-field');
        try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (e) {}
      }
      var head = o.title !== undefined ? '<div class="modal-head">' + (o.avatarName ? P.avatar(o.avatarName, 'avatar-lg') : '')
        + '<div><h3 id="' + m.id + '-title">' + o.title + '</h3>' + (o.sub ? '<p class="sub">' + o.sub + '</p>' : '') + '</div>'
        + '<button type="button" class="icon-btn modal-x" data-modal-close aria-label="Close">×</button></div>' : '';
      var acts = (o.actions || []).map(function (a) {
        var cls = 'gl-btn' + (a.kind === 'primary' ? ' gl-btn-primary' : a.kind === 'danger' ? ' gl-btn-danger' : a.kind === 'ghost' ? ' gl-btn-ghost' : '');
        return '<button type="button" class="' + cls + '" data-action="' + P.esc(a.action) + '"' + (a.disabled ? ' disabled' : '') + '>' + P.esc(a.label) + '</button>';
      }).join('');
      root.innerHTML = '<div class="overlay' + (o.variant === 'side' ? ' overlay-side' : '') + '">'
        + '<div class="gl-modal-scrim" data-modal-close></div>'
        + '<div class="modal' + (o.wide ? ' modal-wide' : '') + (o.variant === 'side' ? ' modal-side' : '') + '" role="dialog" aria-modal="true" aria-labelledby="' + m.id + '-title" tabindex="-1">'
        + head + '<div class="modal-body">' + (o.html || '') + '</div>'
        + (acts ? '<div class="modal-actions">' + acts + '</div>' : '') + '</div></div>';
      root.hidden = false;
      var box = root.querySelector('.modal-body'); if (box) box.scrollTop = scroll;
      if (focusField) {
        var el = root.querySelector('[data-field="' + focusField + '"]');
        if (el) { el.focus({ preventScroll: true }); if (selStart !== null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selEnd); } catch (e) {} } }
      }
    };
    m.draw();
    P.modal.current = m;
    var page = document.getElementById('page'); if (page) page.setAttribute('inert', '');
    var side = document.querySelector('.sidebar'); if (side) side.setAttribute('inert', '');
    var top = document.querySelector('.topbar'); if (top) top.setAttribute('inert', '');
    setTimeout(function () {
      var first = root.querySelector('[autofocus], input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([disabled]), textarea:not([disabled]), select');
      (first || root.querySelector('.modal')).focus({ preventScroll: true });
    }, 0);
    return m;
  };
  P.closeModal = function () {
    var m = P.modal.current; if (!m) return;
    P.modal.current = null;
    var root = document.getElementById('modal-root');
    if (root) { root.innerHTML = ''; root.hidden = true; }
    ['page'].forEach(function (id) { var el = document.getElementById(id); if (el) el.removeAttribute('inert'); });
    var side = document.querySelector('.sidebar'); if (side) side.removeAttribute('inert');
    var top = document.querySelector('.topbar'); if (top) top.removeAttribute('inert');
    if (m.opts.onClose) { try { m.opts.onClose(); } catch (e) { console.error(e); } }
    if (m.opener && m.opener.focus && document.contains(m.opener)) { try { m.opener.focus({ preventScroll: true }); } catch (e) {} }
  };
  P.confirm = function (text, okLabel, kind) {
    return new Promise(function (resolve) {
      var done = false;
      P.openModal({
        title: 'Are you sure?', html: '<p class="note-line">' + P.esc(text) + '</p>',
        actions: [{ label: 'Cancel', action: 'cancel' }, { label: okLabel || 'Yes', action: 'ok', kind: kind || 'primary' }],
        onAction: function (a) { done = true; P.closeModal(); resolve(a === 'ok'); },
        onClose: function () { if (!done) resolve(false); }
      });
    });
  };

  /* ---------------------------------------------------------------------
     event delegation
     --------------------------------------------------------------------- */
  function dispatchAction(action, el, ev) {
    var modalRoot = document.getElementById('modal-root');
    if (modalRoot && modalRoot.contains(el)) {
      var m = P.modal.current;
      if (m && m.opts.onAction) { try { m.opts.onAction(action, el, ev); } catch (e) { console.error(e); P.toast('fail', 'Something went wrong.'); } }
      return;
    }
    if (P.onShellAction && P.onShellAction(action, el, ev)) return;
    var def = P.state.authed ? P.screens[P.state.screen] : null;
    if (def && def.onAction) { try { def.onAction(action, el, ev, P.state); } catch (e) { console.error(e); P.toast('fail', 'Something went wrong.'); } }
    else if (!P.state.authed && P.onLoginAction) P.onLoginAction(action, el, ev);
  }
  function dispatchInput(field, el, ev) {
    var modalRoot = document.getElementById('modal-root');
    if (modalRoot && modalRoot.contains(el)) {
      var m = P.modal.current;
      if (m && m.opts.onInput) { try { m.opts.onInput(field, el, ev); } catch (e) { console.error(e); } }
      return;
    }
    if (P.onShellInput && P.onShellInput(field, el, ev)) return;
    var def = P.state.authed ? P.screens[P.state.screen] : null;
    if (def && def.onInput) { try { def.onInput(field, el, ev, P.state); } catch (e) { console.error(e); } }
    else if (!P.state.authed && P.onLoginInput) P.onLoginInput(field, el, ev);
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var tc = t.closest('[data-toast-close]');
    if (tc) { P.dismissToast(tc.getAttribute('data-toast-close')); return; }
    if (t.closest('[data-modal-close]')) { ev.preventDefault(); P.closeModal(); return; }
    var go = t.closest('[data-goto]');
    if (go) { ev.preventDefault(); if (P.modal.current) P.closeModal(); P.route(go.getAttribute('data-goto')); return; }
    var act = t.closest('[data-action]');
    if (act) { if (act.tagName === 'A') ev.preventDefault(); if (act.disabled) return; dispatchAction(act.getAttribute('data-action'), act, ev); }
  });
  document.addEventListener('input', function (ev) {
    var t = ev.target; if (!t || !t.getAttribute) return;
    var f = t.getAttribute('data-field'); if (f) dispatchInput(f, t, ev);
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target; if (!t || !t.getAttribute) return;
    var f = t.getAttribute('data-field');
    if (f && (t.type === 'checkbox' || t.type === 'radio' || t.type === 'file' || t.tagName === 'SELECT')) dispatchInput(f, t, ev);
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && P.modal.current) { ev.preventDefault(); P.closeModal(); return; }
    if (ev.key === 'Enter' && ev.target && ev.target.getAttribute) {
      var a = ev.target.getAttribute('data-enter');
      if (a && ev.target.tagName !== 'TEXTAREA') { ev.preventDefault(); dispatchAction(a, ev.target, ev); return; }
      if (a && ev.target.tagName === 'TEXTAREA' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); dispatchAction(a, ev.target, ev); return; }
    }
    // focus trap inside the modal
    if (ev.key === 'Tab' && P.modal.current) {
      var root = document.getElementById('modal-root');
      var f = Array.prototype.filter.call(root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'), function (el) { return el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  });

  /* ---------------------------------------------------------------------
     boot
     --------------------------------------------------------------------- */
  P.boot = function () {
    var h = P.parseHash();
    P.state.screen = P.screens[h.key] ? h.key : 'dashboard';
    P.state.param = h.param;
    P.render();
    if (P.api && P.api.resume) P.api.resume();
  };
})();
