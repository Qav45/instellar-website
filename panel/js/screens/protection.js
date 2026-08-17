/* =========================================================================
   Protection screen (Supervisor only)
   Protected players can't be punished by anyone. Data: P.state.data.protected
   (protected_players rows) + P.state.data.blocks (protection_blocks rows).
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P;
  var esc = P.esc;
  var BLOCK_ORDER = ['Ban', 'Wipeban', 'Mute', 'Kick', 'Warn'];
  var DAY = 86400000;
  var NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

  /* ---------------- data ---------------- */
  function sortedBlocks(blocks) {
    return BLOCK_ORDER.filter(function (t) { return (blocks || []).indexOf(t) > -1; });
  }
  function recentBlocks() {
    var since = Date.now() - 30 * DAY;
    return (P.state.data.blocks || []).filter(function (b) {
      var t = new Date(b.created_at).getTime();
      return !isNaN(t) && t >= since;
    }).sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
  }
  function findProtected(id) {
    return (P.state.data.protected || []).filter(function (p) { return String(p.id) === String(id); })[0] || null;
  }

  /* ---------------- render ---------------- */
  function untilCell(p) {
    if (!p.expires_at) return '<span class="pr-until pr-forever">Forever</span>';
    return '<span class="pr-until">until ' + esc(P.fmtDate(p.expires_at)) + '</span>';
  }
  function protectedTable(rows) {
    var body = rows.length ? rows.map(function (p) {
      return '<div class="x-tr">'
        + '<div class="x-user">' + P.avatar(p.name) + '<span class="x-name x-ell">' + esc(p.name) + '</span></div>'
        + '<span class="pr-why" title="' + esc(p.reason || '') + '">' + (p.reason ? esc(p.reason) : '—') + '</span>'
        + '<span class="pr-blocks">' + sortedBlocks(p.blocks).map(P.typePill).join('') + '</span>'
        + '<span class="x-ell">' + esc(p.added_by_name || '—') + '</span>'
        + untilCell(p)
        + '<span class="x-right"><button type="button" class="gl-btn gl-btn-ghost gl-btn-sm x-mini" data-action="remove" data-id="' + esc(p.id) + '">Remove</button></span>'
        + '</div>';
    }).join('') : '<div class="empty">Nobody is protected yet.</div>';
    return '<div class="tbl-scroll pr-gap"><div class="gl-glass x-tbl pr-tbl" style="--x-cols:minmax(150px,1.1fr) minmax(120px,1.4fr) 240px 104px 112px 92px;">'
      + '<div class="x-th"><span>Player</span><span>Why</span><span>Blocks</span><span>Protected by</span><span>Until</span><span class="x-right">&nbsp;</span></div>'
      + body + '</div></div>';
  }
  function attemptsCard(blocks) {
    var body = blocks.length ? blocks.slice(0, 20).map(function (b) {
      return '<div class="pr-att-row">'
        + '<span class="x-stat-pill bad pr-blocked">Blocked</span>'
        + '<span class="pr-att-text"><b class="x-strong">' + esc(b.by_name || 'Someone') + '</b> tried to ' + esc(String(b.type || 'punish').toLowerCase())
        + ' <b class="x-strong">' + esc(b.target) + '</b>'
        + (b.reason ? ' <span class="x-dim">· ' + esc(b.reason) + '</span>' : '')
        + ' <span class="x-dim">· ' + esc(P.serverName(b.server)) + '</span></span>'
        + '<span class="pr-att-when">' + esc(P.timeAgo(b.created_at)) + '</span>'
        + '<span class="x-right"><button type="button" class="gl-btn gl-btn-ghost gl-btn-sm x-mini" data-goto="audit/' + esc(b.target) + '">View in History</button></span>'
        + '</div>';
    }).join('') : '<div class="empty">No blocked attempts yet.</div>';
    return '<div class="gl-glass pr-att">' + body + '</div>';
  }

  function render(root, s) {
    var rows = P.activeProtected();
    var blocks = recentBlocks();
    var err = s.data.protectionError;
    root.innerHTML =
      (err === 'missing'
        ? '<div class="setup-note">Protection is not set up yet — run <code>supabase/protection-setup.sql</code> in Supabase, then reload.</div>'
        : err ? '<div class="setup-note">Could not load protection: ' + esc(err) + '</div>' : '')
      + '<div class="page-head x-head"><div><h2>Protection</h2>'
      + '<p class="sub x-sub">Protected players can’t be banned by anyone. Only you can change this list.</p></div>'
      + '<div class="actions x-actions"><button type="button" class="gl-btn gl-btn-primary" data-action="add">+ Protect a player</button></div></div>'
      + '<div class="stat-grid pr-stats">'
      + '<div class="gl-glass stat"><div class="stat-label">Protected players</div><div class="stat-value">' + rows.length + '</div><div class="stat-sub">Nobody can ban them</div></div>'
      + '<div class="gl-glass stat"><div class="stat-label">Blocked ban attempts</div><div class="stat-value' + (blocks.length ? ' is-danger' : '') + '">' + blocks.length + '</div><div class="stat-sub">Last 30 days</div></div>'
      + '</div>'
      + '<h3 class="pr-cardtitle">Protected players</h3>' + protectedTable(rows)
      + '<h3 class="pr-cardtitle">Blocked attempts</h3>' + attemptsCard(blocks)
      + '<p class="pr-note">Staff who try to ban a protected player see: “This player is protected — ask a Supervisor.”</p>';
  }

  /* ---------------- protect modal ---------------- */
  function openProtect() {
    var st = { name: '', reason: '', Mute: false, Kick: false, days: 0, busy: false };
    var m;
    function toggleRow(type, on, locked) {
      return '<div class="pr-toggle-row' + (locked ? ' pr-locked' : '') + '">'
        + '<span class="pr-tname">' + type + (locked ? ' <span class="pr-always">Always on</span>' : '') + '</span>'
        + '<label class="gl-switch"><input type="checkbox" data-field="blk-' + type + '"' + (on ? ' checked' : '') + (locked ? ' disabled' : '') + '><span class="gl-switch-track"></span></label>'
        + '</div>';
    }
    function html() {
      return '<span class="pr-label">Player name</span>'
        + '<div class="gl-search"><span class="gl-search-icon">⌕</span><input class="gl-input" type="text" maxlength="16" autocomplete="off" spellcheck="false" placeholder="Type a player name…" data-field="name" data-enter="protect" value="' + esc(st.name) + '"></div>'
        + '<span class="pr-label">Why? (shown to staff who try)</span>'
        + '<input class="gl-input" type="text" maxlength="120" placeholder="e.g. Content creator" data-field="reason" data-enter="protect" value="' + esc(st.reason) + '">'
        + '<span class="pr-label">Blocks</span>'
        + '<div class="pr-toggles">' + toggleRow('Ban', true, true) + toggleRow('Wipeban', true, true) + toggleRow('Mute', st.Mute, false) + toggleRow('Kick', st.Kick, false) + '</div>'
        + '<span class="pr-label">For how long</span>'
        + '<div class="x-chips">' + [[0, 'Forever'], [7, '7 days'], [30, '30 days']].map(function (c) {
          return '<button type="button" class="chip x-chip' + (st.days === c[0] ? ' is-active' : '') + '" data-action="until" data-v="' + c[0] + '">' + c[1] + '</button>';
        }).join('') + '</div>';
    }
    function actions() {
      return [{ label: 'Cancel', action: 'cancel', kind: 'ghost' }, { label: st.busy ? 'Protecting…' : 'Protect player', action: 'protect', kind: 'primary', disabled: st.busy }];
    }
    function submit() {
      if (st.busy) return;
      var name = st.name.trim();
      if (!NAME_RE.test(name)) { P.toast('fail', 'That is not a valid Minecraft username.'); return; }
      var blocks = ['Ban', 'Wipeban'];
      if (st.Mute) blocks.push('Mute');
      if (st.Kick) blocks.push('Kick');
      st.busy = true; m.update({ actions: actions() });
      P.api.protect({ name: name, reason: st.reason.trim(), blocks: blocks, expires_at: st.days ? new Date(Date.now() + st.days * DAY).toISOString() : null })
        .then(function (ok) {
          if (ok) { P.closeModal(); return; }
          st.busy = false; if (P.modal.current === m) m.update({ actions: actions() });
        });
    }
    m = P.openModal({
      title: 'Protect a player', sub: 'Nobody will be able to ban them.',
      html: html(), actions: actions(),
      onInput: function (field, el) {
        if (field === 'name') st.name = el.value;
        else if (field === 'reason') st.reason = el.value;
        else if (field === 'blk-Mute') st.Mute = !!el.checked;
        else if (field === 'blk-Kick') st.Kick = !!el.checked;
      },
      onAction: function (action, el) {
        if (action === 'cancel') { P.closeModal(); return; }
        if (action === 'until') { st.days = Number(el.getAttribute('data-v')) || 0; m.update({ html: html() }); return; }
        if (action === 'protect') submit();
      }
    });
  }

  /* ---------------- actions ---------------- */
  function onAction(action, el) {
    if (action === 'add') { openProtect(); return; }
    if (action === 'remove') {
      var p = findProtected(el.getAttribute('data-id'));
      if (!p) return;
      P.confirm(p.name + ' will be bannable again.', 'Remove protection', 'danger').then(function (ok) {
        if (ok) P.api.unprotect(p.id);
      });
    }
  }

  P.registerScreen('protection', {
    title: 'Protection',
    nav: { label: 'Protection', icon: 'protection', order: 95, show: function () { return P.isSupervisor(); } },
    guard: function () { return P.isSupervisor(); },
    render: render,
    onAction: onAction
  });
})();
