/* =========================================================================
   Screens: 'guides' (Rules & guides, pinned punishment ladder + DB guides)
   and 'logging' (Staff logs).
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P;
  var esc = P.esc;

  function byNewest(a, b) { return new Date(b.created_at) - new Date(a.created_at); }
  function nl2br(text) { return esc(text).replace(/\r?\n/g, '<br>'); }

  /* ---------------- guides ---------------- */
  function ladderCol(label, dot, list) {
    return '<div class="x-ladder-col"><span class="x-col-head"><span class="x-dot ' + dot + '"></span>' + label + '</span>'
      + list.map(function (t) {
        var steps = t.steps.map(function (st, i) {
          return (i ? '<span class="x-arrow">→</span>' : '') + '<span class="x-step' + (st === 'Permanent' ? ' is-last' : '') + '">' + esc(st) + '</span>';
        }).join('');
        return '<div class="x-lad"><span class="x-lad-name">' + esc(t.name) + '</span><span class="x-steps">' + steps + '</span></div>';
      }).join('') + '</div>';
  }
  function guidelineNotes() {
    // The lines of the old guidelines text that are not ladders or headings.
    return P.punishGuidelinesText().split('\n').filter(function (l) {
      return l.trim() && l.indexOf('→') === -1 && !/^[^\w\s]/.test(l.trim());
    });
  }
  function pinnedCard() {
    var all = P.builtinTemplates();
    var bans = all.filter(function (t) { return t.type === 'Ban'; });
    var mutes = all.filter(function (t) { return t.type === 'Mute'; });
    return '<article class="gl-glass gl-card g-card g-pinned">'
      + '<div class="x-guide-head"><h3 class="x-guide-title">Punishment guidelines</h3><span class="g-pin">Pinned</span></div>'
      + '<p class="x-guide-body g-lead">How long each punishment should be. First offence on the left, then the next step each time.</p>'
      + '<div class="x-ladders">' + ladderCol('Bans', 'red', bans) + ladderCol('Mutes', 'amber', mutes) + '</div>'
      + '<div class="g-notes">' + guidelineNotes().map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') + '</div>'
      + '</article>';
  }
  function renderGuides(root, s) {
    var canEdit = P.canEditGuides();
    var rows = (s.data.guides || []).slice().sort(byNewest);
    var html = '<div class="page-head x-head"><div><h2>Rules &amp; guides</h2><p class="sub x-sub">The punishment ladder, plus anything the team wrote down for ' + esc(P.serverName(s.server)) + '.</p></div>'
      + '<div class="actions x-actions">' + (canEdit ? '<button type="button" class="gl-btn gl-btn-primary" data-action="add-guide">+ Add guide</button>' : '') + '</div></div>';
    html += '<div class="x-guides">' + pinnedCard();
    if (!rows.length) html += '<div class="gl-card"><div class="empty">No other guides yet.</div></div>';
    rows.forEach(function (g) {
      html += '<article class="gl-glass gl-card g-card">'
        + '<div class="x-guide-head"><h3 class="x-guide-title">' + esc(g.title) + '</h3><span class="gl-spacer" style="flex:1"></span>'
        + (canEdit ? '<button type="button" class="gl-btn gl-btn-ghost gl-btn-sm x-mini" data-action="del-guide" data-id="' + esc(g.id) + '">Delete</button>' : '') + '</div>'
        + '<p class="x-guide-body">' + nl2br(g.body) + '</p>'
        + '<p class="g-meta">by ' + esc(g.by_name || '—') + ' · ' + esc(P.timeAgo(g.created_at)) + '</p>'
        + '</article>';
    });
    html += '</div>';
    root.innerHTML = html;
  }
  function openAddGuide() {
    var f = { title: '', body: '' }, busy = false;
    function body() {
      return '<div class="field-label">Title</div><input class="gl-input" type="text" data-field="gtitle" value="' + esc(f.title) + '" placeholder="e.g. Handling appeals" autocomplete="off">'
        + '<div class="field-label">Content</div><textarea class="gl-textarea g-textarea" data-field="gbody" data-enter="guide-submit" placeholder="Write the guide. Line breaks are kept.">' + esc(f.body) + '</textarea>';
    }
    function actions() { return [{ label: 'Cancel', action: 'cancel', kind: 'ghost' }, { label: busy ? 'Publishing…' : 'Publish', action: 'guide-submit', kind: 'primary', disabled: busy }]; }
    var m = P.openModal({
      title: 'Add guide', sub: 'Every staff member on ' + esc(P.serverName(P.state.server)) + ' will see it.',
      html: body(), actions: actions(),
      onInput: function (field, el) { if (field === 'gtitle') f.title = el.value; if (field === 'gbody') f.body = el.value; },
      onAction: function (a) {
        if (a === 'cancel') { P.closeModal(); return; }
        if (a !== 'guide-submit' || busy) return;
        if (!f.title.trim() || !f.body.trim()) { P.toast('fail', 'Fill in a title and the content.'); return; }
        busy = true; m.update({ actions: actions() });
        P.api.addGuide(f.title.trim(), f.body.trim()).then(function (ok) {
          busy = false;
          if (ok) P.closeModal(); else if (P.modal.current === m) m.update({ actions: actions() });
        });
      }
    });
  }
  P.registerScreen('guides', {
    title: 'Rules & guides',
    nav: { label: 'Rules & guides', icon: 'guides', order: 70 },
    render: renderGuides,
    onAction: function (action, el) {
      if (action === 'add-guide') { if (P.canEditGuides()) openAddGuide(); return; }
      if (action === 'del-guide') {
        if (!P.canEditGuides()) return;
        var id = el.getAttribute('data-id');
        var g = (P.state.data.guides || []).filter(function (x) { return String(x.id) === id; })[0];
        if (!g) return;
        P.confirm('Delete the guide "' + g.title + '"? Everyone loses it.', 'Delete', 'danger').then(function (ok) {
          if (ok) P.api.removeGuide(g.id).then(function (done) { if (done) P.toast('ok', 'Guide deleted.'); });
        });
      }
    }
  });

  /* ---------------- staff logs ---------------- */
  function renderLogging(root, s) {
    var rows = (s.data.logs || []).slice().sort(byNewest);
    var dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    var today = rows.filter(function (j) { return new Date(j.created_at) >= dayStart; }).length;
    var owner = P.isOwnership();
    var html = '<div class="page-head x-head"><div><h2>Staff logs</h2><p class="sub x-sub">Write down what you did and why. An owner approves it.</p></div>'
      + '<div class="actions x-actions"><span class="x-needs lg-count">' + today + ' today · ' + rows.length + ' total</span>'
      + '<button type="button" class="gl-btn gl-btn-primary" data-action="add-log">+ Add log</button></div></div>';
    html += '<div class="x-logs">';
    if (!rows.length) html += '<div class="gl-card"><div class="empty">No logs yet.</div></div>';
    rows.forEach(function (j) {
      var approved = j.status === 'Approved';
      html += '<article class="gl-glass gl-card x-logcard">'
        + '<div class="x-log-top">' + P.avatar(j.by_name || '?') + '<span class="x-strong">' + esc(j.by_name || '—') + '</span><span class="x-dim">' + esc(P.timeAgo(j.created_at)) + '</span>'
        + '<span class="lg-right">' + (approved ? '<span class="status ok">Approved</span>' : '<span class="status warn">Waiting</span>')
        + (owner && !approved ? '<button type="button" class="gl-btn gl-btn-ghost gl-btn-sm x-mini" data-action="approve-log" data-id="' + esc(j.id) + '">Approve</button>' : '')
        + '</span></div>'
        + '<div class="x-log-lines">'
        + '<span class="x-log-k">Did</span><span class="x-log-v">' + nl2br(j.what) + '</span>'
        + '<span class="x-log-k">Why</span><span class="x-log-v">' + nl2br(j.why) + '</span>'
        + '<span class="x-log-k">Result</span><span class="x-log-v">' + nl2br(j.after) + '</span>'
        + '</div></article>';
    });
    html += '</div>';
    root.innerHTML = html;
  }
  function openAddLog() {
    var f = { what: '', why: '', after: '' }, busy = false;
    function body() {
      return '<div class="field-label">What did you do?</div><textarea class="gl-textarea lg-textarea" data-field="what" placeholder="e.g. Teleported Nova_Tide out of a stuck chunk at spawn.">' + esc(f.what) + '</textarea>'
        + '<div class="field-label">Why?</div><textarea class="gl-textarea lg-textarea" data-field="why" placeholder="e.g. They fell into unloaded terrain and couldn’t move.">' + esc(f.why) + '</textarea>'
        + '<div class="field-label">What happened after?</div><textarea class="gl-textarea lg-textarea" data-field="after" data-enter="log-submit" placeholder="e.g. Player was fine; reported the chunk to the devs.">' + esc(f.after) + '</textarea>';
    }
    function actions() { return [{ label: 'Cancel', action: 'cancel', kind: 'ghost' }, { label: busy ? 'Saving…' : 'Save log', action: 'log-submit', kind: 'primary', disabled: busy }]; }
    var m = P.openModal({
      title: 'Add log', sub: 'Three short lines. An owner approves it later.',
      html: body(), actions: actions(),
      onInput: function (field, el) { if (field in f) f[field] = el.value; },
      onAction: function (a) {
        if (a === 'cancel') { P.closeModal(); return; }
        if (a !== 'log-submit' || busy) return;
        if (!f.what.trim() || !f.why.trim() || !f.after.trim()) { P.toast('fail', 'Fill in all three fields.'); return; }
        busy = true; m.update({ actions: actions() });
        P.api.submitLog(f.what.trim(), f.why.trim(), f.after.trim()).then(function (ok) {
          busy = false;
          if (ok) P.closeModal(); else if (P.modal.current === m) m.update({ actions: actions() });
        });
      }
    });
  }
  P.registerScreen('logging', {
    title: 'Staff logs',
    nav: { label: 'Staff logs', icon: 'logging', order: 60 },
    render: renderLogging,
    onAction: function (action, el) {
      if (action === 'add-log') { openAddLog(); return; }
      if (action === 'approve-log') {
        if (!P.isOwnership()) return;
        var id = el.getAttribute('data-id');
        var j = (P.state.data.logs || []).filter(function (x) { return String(x.id) === id; })[0];
        if (j && j.status !== 'Approved') P.api.approveLog(j.id);
      }
    }
  });
})();
