/* =========================================================================
   Screen: Players (#players) — who is online right now, plus P.openPlayer()
   the side sheet with notes / history / quick actions.
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P;
  var esc = P.esc;

  function ui() { return P.ui('players', { q: '', filter: 'All' }); }
  function recPill(status) {
    return status === 'Banned' ? '<span class="status danger">Banned</span>' : status === 'Muted' ? '<span class="status warn">Muted</span>' : '';
  }
  function seenText(pr) {
    if (!pr) return 'Not seen online yet';
    return P.isOnline(pr) ? 'Online now' : 'Offline · last seen ' + P.timeAgo(pr.last_seen).toLowerCase();
  }
  function actionRow(a) {
    var bits = [];
    if (a.duration) bits.push(esc(a.duration));
    bits.push('by ' + esc(a.by_name));
    bits.push(esc(P.timeAgo(a.created_at)));
    return '<div class="p-row"><span class="p-what">' + P.typePill(a.type) + esc(a.reason) + ' <span class="p-dim">· ' + bits.join(' · ') + '</span>'
      + (a.status === 'Failed' && a.error ? '<span class="p-err">' + esc(a.error) + '</span>' : '')
      + (a.proof && a.proof.length ? '<span class="p-proof">' + P.proofLinks(a.proof) + '</span>' : '')
      + '</span>' + P.statusPill(a.status, a.error) + '</div>';
  }

  /* ---------------- side sheet ---------------- */
  P.openPlayer = function (name) {
    name = String(name || '');
    var st = { note: '', saving: false };
    function body() {
      var pr = P.presenceOf(name);
      var rec = P.playerRecord(name, pr && pr.uuid);
      var notes = (P.state.data.notes || []).filter(function (n) { return String(n.target || '').toLowerCase() === name.toLowerCase(); });
      var h = '<div class="pl-status">' + (rec.status === 'Banned' ? '<span class="status danger">Banned</span>' : rec.status === 'Muted' ? '<span class="status warn">Muted</span>' : '<span class="status ok">Not banned</span>')
        + (pr && P.isOnline(pr) ? '<span class="status ok"><i class="dot"></i>Online</span>' : '') + '</div>'
        + '<div class="pl-kv"><span class="pl-k">Last seen</span><span>' + esc(pr ? (P.isOnline(pr) ? 'Online now' : P.timeAgo(pr.last_seen)) : 'Not seen online yet') + '</span></div>'
        + '<div class="pl-kv"><span class="pl-k">UUID</span>' + (pr && pr.uuid ? '<span class="pl-mono">' + esc(pr.uuid) + '</span>' : '<span class="x-dim">Not seen online yet</span>') + '</div>';

      h += '<div class="pl-sec">Quick actions</div><div class="chip-wrap pl-quick">';
      ['Warn', 'Mute', 'Kick', 'Ban', 'IpBan', 'Unban'].concat(rec.status === 'Muted' ? ['Unmute'] : []).concat(P.canWipeban() ? ['Wipeban'] : []).forEach(function (t) {
        var danger = t === 'Ban' || t === 'IpBan' || t === 'Wipeban';
        h += '<button type="button" class="gl-btn gl-btn-sm' + (danger ? ' gl-btn-danger' : '') + '" data-action="punish" data-type="' + t + '">' + esc(P.actionLabel(t)) + '</button>';
      });
      h += '</div><a class="pl-link" href="#infractions/' + esc(encodeURIComponent(name)) + '" data-goto="infractions/' + esc(name) + '">Use a template → Punish a player</a>';
      h += '<div class="pl-sec">Notes <span class="hint">visible to all staff</span></div>';
      h += notes.length ? '<div class="pl-notes">' + notes.map(function (n) {
        return '<div class="pl-note"><p>' + esc(n.text) + '</p><span class="pl-note-by">' + esc(n.by_name) + ' · ' + esc(P.timeAgo(n.created_at)) + '</span></div>';
      }).join('') + '</div>' : '<div class="empty pl-empty">No notes yet.</div>';
      h += '<input class="gl-input" type="text" id="players-note" data-field="note" data-enter="addNote" placeholder="Add a note (Enter)" autocomplete="off" value="' + esc(st.note) + '"' + (st.saving ? ' disabled' : '') + '>';

      h += '<div class="pl-sec">History</div>';
      h += rec.all.length ? '<div class="p-hist">' + rec.all.map(actionRow).join('') + '</div>' : '<div class="empty pl-empty">No punishments yet.</div>';

      return h;
    }
    function subLine() { return esc(seenText(P.presenceOf(name))); }
    var m = P.openModal({
      variant: 'side', title: esc(name), avatarName: name, sub: subLine(), html: body(),
      onAction: function (a, el) {
        if (a === 'punish') { P.openPunish({ type: el.getAttribute('data-type'), target: name, reason: '' }); return; }
        if (a === 'addNote') {
          var text = st.note.trim();
          if (!text || st.saving) return;
          st.saving = true; m.update({ html: body() });
          P.api.addNote(name, text).then(function (ok) {
            st.saving = false;
            if (ok) st.note = '';
            if (P.modal.current === m) { m.update({ html: body() }); var inp = document.getElementById('players-note'); if (inp) inp.focus(); }
          });
        }
      },
      onInput: function (f, el) { if (f === 'note') st.note = el.value; },
      rerender: function () { m.update({ html: body(), sub: subLine() }); }
    });
    return m;
  };

  /* ---------------- screen ---------------- */
  P.registerScreen('players', {
    title: 'Players',
    nav: { label: 'Players', icon: 'players', order: 30 },
    render: function (root, s) {
      var u = ui();
      var online = P.onlinePlayers();
      var q = u.q.trim().toLowerCase();
      var rows = online.map(function (p) { return { p: p, status: P.playerRecord(p.name, p.uuid).status }; }).filter(function (r) {
        if (u.filter !== 'All' && r.status !== u.filter) return false;
        if (!q) return true;
        return String(r.p.name || '').toLowerCase().indexOf(q) > -1 || String(r.p.uuid || '').toLowerCase().indexOf(q) > -1;
      });
      var h = '<div class="page-head"><div><h2>Players</h2><p class="sub">' + online.length + ' online on ' + esc(P.serverName(s.server)) + '</p></div></div>'
        + '<div class="filter-row x-filters"><div class="gl-search"><span class="gl-search-icon">⌕</span>'
        + '<input class="gl-input" type="search" id="players-q" data-field="q" placeholder="Type a player name…" autocomplete="off" value="' + esc(u.q) + '"></div>'
        + '<div class="x-chips">' + ['All', 'Muted', 'Banned'].map(function (f) {
          return '<button type="button" class="chip x-chip' + (u.filter === f ? ' is-active' : '') + '" data-action="filter" data-v="' + f + '">' + f + '</button>';
        }).join('') + '</div></div>';
      h += '<div class="tbl-scroll"><div class="gl-card x-tbl pl-tbl">'
        + '<div class="table-head x-th"><span>Player</span><span>Status</span><span>Last seen</span><span class="x-right">Actions</span></div>';
      if (!online.length) h += '<div class="empty">Nobody is online right now.</div>';
      else if (!rows.length) h += '<div class="empty">No players match.</div>';
      else h += rows.map(function (r) {
        var p = r.p;
        return '<div class="list-row x-tr" data-action="open" data-name="' + esc(p.name) + '" tabindex="0">'
          + '<div class="x-user">' + P.avatar(p.name) + '<span class="x-name x-ell">' + esc(p.name) + '</span></div>'
          + '<span class="pl-st"><span class="status ok"><i class="dot"></i>Online</span>' + recPill(r.status) + '</span>'
          + '<span class="x-num x-dim">' + (P.isOnline(p) ? 'Online now' : esc(P.timeAgo(p.last_seen))) + '</span>'
          + '<span class="x-right"><button type="button" class="gl-btn gl-btn-ghost gl-btn-sm x-mini" data-action="kick" data-name="' + esc(p.name) + '">Kick</button>'
          + '<button type="button" class="gl-btn gl-btn-ghost gl-btn-sm x-mini" data-goto="infractions/' + esc(p.name) + '">Punish…</button></span></div>';
      }).join('');
      root.innerHTML = h + '</div></div>';
    },
    onInput: function (f, el) { if (f === 'q') { ui().q = el.value; P.rerender(); } },
    onAction: function (a, el, ev) {
      if (a === 'filter') { ui().filter = el.getAttribute('data-v'); P.rerender(); return; }
      if (a === 'kick') { P.openPunish({ type: 'Kick', target: el.getAttribute('data-name'), reason: '' }); return; }
      if (a === 'open') P.openPlayer(el.getAttribute('data-name'));
    }
  });
})();
