/* =========================================================================
   History ('audit') + Approvals ('approvals') screens.
   History: every mod_actions row on the current server, newest first, with
   search + status chips; #audit/<name> pre-fills the search.
   Approvals: rows with status Approval; Approve / Deny when P.canDecide(a).
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P;
  var esc = P.esc;

  var FILTERS = [['All', 'All'], ['Executed', 'Done'], ['Pending', 'Waiting'], ['Approval', 'Needs approval'], ['Failed', 'Failed'], ['Denied', 'Denied']];

  function ui() { return P.ui('audit', { q: '', filter: 'All', paramSeen: null }); }
  function actions() { return P.state.data.actions || []; }
  function has(v, q) { return String(v || '').toLowerCase().indexOf(q) > -1; }
  function what(a) {
    return '<span class="x-what">' + P.typePill(a.type) + '<span class="a-what-txt" title="' + esc([a.reason, a.duration].filter(Boolean).join(' · ')) + '">' + esc(a.reason || '—')
      + (a.duration ? ' <span class="x-dim">· ' + esc(a.duration) + '</span>' : '') + '</span></span>';
  }
  function decideBtns(a) {
    return '<button type="button" class="gl-btn gl-btn-ghost gl-btn-sm x-mini" data-action="deny" data-id="' + esc(a.id) + '">Deny</button>'
      + '<button type="button" class="gl-btn gl-btn-primary gl-btn-sm x-mini" data-action="approve" data-id="' + esc(a.id) + '">Approve</button>';
  }
  function needs(a) { return '<span class="x-needs">Needs ' + esc(P.requiredRole(a.type, a.duration)) + ' or higher</span>'; }

  /* ---------------- History ---------------- */
  function renderAudit(root, s) {
    var u = ui();
    // route param pre-fills the search (once per param value)
    if (s.param && u.paramSeen !== s.param) { u.q = s.param; u.paramSeen = s.param; }
    if (!s.param) u.paramSeen = null;
    var all = actions();
    var q = String(u.q || '').trim().toLowerCase();
    var rows = all.filter(function (a) {
      return (u.filter === 'All' || a.status === u.filter) && (!q || has(a.target, q) || has(a.by_name, q) || has(a.reason, q));
    });

    var chips = FILTERS.map(function (f) {
      var n = f[0] === 'All' ? all.length : all.filter(function (a) { return a.status === f[0]; }).length;
      return '<button type="button" class="chip x-chip' + (u.filter === f[0] ? ' is-active' : '') + '" data-action="filter" data-v="' + f[0] + '" aria-pressed="' + (u.filter === f[0]) + '">' + f[1]
        + (n && f[0] !== 'All' ? ' <span class="a-chip-n">' + n + '</span>' : '') + '</button>';
    }).join('');

    var body;
    if (!rows.length) body = '<div class="empty">' + (all.length ? 'No matches.' : 'Nothing here yet.') + '</div>';
    else body = rows.map(function (a) {
      var st = P.statusPill(a.status, a.error);
      if (a.status === 'Failed' && a.error) st += '<span class="x-dim a-err" title="' + esc(a.error) + '">' + esc(a.error) + '</span>';
      var acts = '';
      if (a.status === 'Failed') acts = '<button type="button" class="gl-btn gl-btn-ghost gl-btn-sm x-mini" data-action="retry" data-id="' + esc(a.id) + '">Retry</button>';
      else if (a.status === 'Approval') acts = P.canDecide(a) ? decideBtns(a) : needs(a);
      var proof = P.proofLinks(a.proof);
      return '<div class="list-row x-tr a-tr">'
        + '<span class="x-num x-dim a-when">' + esc(P.timeAgo(a.created_at)) + '</span>'
        + '<span class="x-user a-player" data-action="player" data-name="' + esc(a.target) + '" role="button" tabindex="0">' + P.avatar(a.target, 'avatar-sm') + '<span class="x-name x-ell">' + esc(a.target) + '</span></span>'
        + what(a)
        + '<span class="x-ell a-by" title="' + esc(a.by_name) + '">' + esc(a.by_name || '—') + '</span>'
        + '<span class="a-proof">' + (proof || '<span class="x-dim">—</span>') + '</span>'
        + '<span class="a-status">' + st + '</span>'
        + '<span class="x-right a-acts">' + acts + '</span>'
        + '</div>';
    }).join('');

    root.innerHTML = '<div class="page-head x-head"><div><h2>History</h2><p class="sub x-sub">Every punishment on ' + esc(P.serverName(s.server)) + ', newest first.</p></div></div>'
      + '<div class="filter-row x-filters"><div class="gl-search"><span class="gl-search-icon">⌕</span><input class="gl-input" type="search" placeholder="Type a player, staff name or reason…" data-field="q" value="' + esc(u.q) + '" aria-label="Search history"></div>'
      + '<div class="x-chips">' + chips + '</div></div>'
      + '<div class="tbl-scroll"><div class="gl-glass x-tbl a-tbl">'
      + '<div class="table-head x-th"><span>When</span><span>Player</span><span>What</span><span>By</span><span>Proof</span><span>Status</span><span class="x-right">&nbsp;</span></div>'
      + body + '</div></div>';
  }

  function onAuditAction(action, el) {
    var u = ui();
    if (action === 'filter') { u.filter = el.getAttribute('data-v') || 'All'; P.rerender(); return; }
    if (action === 'player') { var n = el.getAttribute('data-name'); if (n) P.openPlayer(n); return; }
    if (action === 'retry') { P.api.retry(el.getAttribute('data-id')); return; }
    if (action === 'approve') { P.api.approve(el.getAttribute('data-id')); return; }
    if (action === 'deny') { P.api.deny(el.getAttribute('data-id')); return; }
  }
  function onAuditInput(field, el) {
    if (field === 'q') { ui().q = el.value; P.rerender(); }
  }

  P.registerScreen('audit', {
    title: 'History',
    nav: { label: 'History', icon: 'audit', order: 40, count: function () { return actions().filter(function (a) { return a.status === 'Pending'; }).length; } },
    render: renderAudit, onAction: onAuditAction, onInput: onAuditInput
  });

  /* ---------------- Approvals ---------------- */
  function renderApprovals(root) {
    var rows = actions().filter(function (a) { return a.status === 'Approval'; });
    var me = P.myName();
    var mine = rows.filter(function (a) { return a.by_name === me; }).length;
    var can = rows.filter(P.canDecide).length;

    var body = rows.length ? '<div class="list-body">' + rows.map(function (a) {
      var meta = [a.reason, a.duration].filter(Boolean).map(esc).join(' · ');
      return '<div class="list-row a-ap-row" data-action="player" data-name="' + esc(a.target) + '" role="button" tabindex="0">' + P.avatar(a.target)
        + '<span class="main"><span class="name">' + P.typePill(a.type) + '<b>' + esc(a.target) + '</b>' + (meta ? '<span class="a-ap-meta">· ' + meta + '</span>' : '') + '</span>'
        + '<span class="sub">Asked by ' + esc(a.by_name || '—') + (a.by_name === me ? ' <span class="x-you">You</span>' : '') + ' · ' + esc(P.timeAgo(a.created_at)) + '</span></span>'
        + '<span class="x-right a-ap-right">' + (P.canDecide(a) ? decideBtns(a) : needs(a)) + '</span>'
        + '</div>';
    }).join('') + '</div>' : '<div class="empty">Nothing is waiting for approval.</div>';

    root.innerHTML = '<div class="page-head x-head"><div><h2>Approvals</h2><p class="sub x-sub">Punishments that need someone higher to say yes.</p></div></div>'
      + '<p class="queue-line a-counts"><b>' + rows.length + '</b> waiting · <b>' + mine + '</b> from you · <b>' + can + '</b> you can decide</p>'
      + '<div class="list gl-glass a-ap" style="--cols:34px minmax(0,1fr) auto">' + body + '</div>';
  }

  P.registerScreen('approvals', {
    title: 'Approvals',
    nav: { label: 'Approvals', icon: 'approvals', order: 50, count: function () { return actions().filter(function (a) { return a.status === 'Approval'; }).length; } },
    render: renderApprovals, onAction: onAuditAction
  });
})();
