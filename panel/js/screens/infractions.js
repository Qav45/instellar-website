/* =========================================================================
   Screen: Punish a player  (#infractions, #infractions/<name>)
   Two steps — 1 Who? 2 Why? — plus the target's record on the right.
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P;
  var esc = P.esc;
  var ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

  function ui() { return P.ui('infractions', { q: '', target: '', tpl: null, tplOpen: false, tName: '', tType: 'Mute', tSteps: '', tNote: '' }); }
  function targetOf(u) { return (u.target || u.q || '').trim(); }
  function me() { return P.state.me || {}; }

  function stepsHelp(u) {
    if (u.tType === 'Warn') return 'Warn templates are a single "warn" step.';
    return 'Comma-separated, one per offence: e.g. 30m, 3h, 1d, 7d, perm. "warn" is allowed as a first step. '
      + (P.rank(P.currentRole()) < P.rank('Admin') && u.tType === 'Ban' ? 'Perm or over-30-day ban steps need Admin or higher.' : '');
  }

  /* ---------------- step 1 ---------------- */
  function suggestions(u) {
    var q = u.q.trim().toLowerCase();
    var rows = (P.state.data.presence || []).slice();
    if (q) rows = rows.filter(function (p) { var n = String(p.name || ''); return n.toLowerCase().indexOf(q) > -1 && n !== u.q.trim(); });
    else rows.sort(function (a, b) { return (P.isOnline(b) ? 1 : 0) - (P.isOnline(a) ? 1 : 0); });
    return rows.slice(0, 8);
  }
  function whoCard(name) {
    var pr = P.presenceOf(name);
    var sub = pr ? (P.isOnline(pr) ? 'Online now' : 'Offline · last seen ' + P.timeAgo(pr.last_seen).toLowerCase()) : 'Not seen online yet';
    var rec = P.playerRecord(name).status;
    var pill = rec === 'Banned' ? '<span class="status danger">Banned</span>' : rec === 'Muted' ? '<span class="status warn">Muted</span>' : '<span class="status ok">Not banned</span>';
    var prot = P.protectionFor(name) ? '<span class="protected-pill">Protected</span>' : '';
    return '<div class="p-who">' + P.avatar(name, 'avatar-lg')
      + '<span class="p-mid"><span class="p-name">' + esc(name) + '</span><span class="p-on">' + esc(sub) + '</span></span>'
      + '<span class="p-who-right">' + prot + pill + '<button type="button" class="ghost-link" data-action="clear">change</button></span></div>';
  }
  function stepWho(u) {
    var t = targetOf(u);
    var h = '<div class="p-step"><span class="p-num">1</span><h3>Who?</h3></div>'
      + '<div class="gl-search p-search"><span class="gl-search-icon">⌕</span>'
      + '<input class="gl-input" type="text" id="infractions-q" data-field="q" data-enter="pickTyped" placeholder="Type a player name…" autocomplete="off" spellcheck="false" value="' + esc(u.target || u.q) + '"></div>';
    if (t) h += whoCard(t);
    if (!u.target) {
      var sug = suggestions(u);
      if (sug.length) {
        h += '<div class="p-sugg">' + sug.map(function (p) {
          var on = P.isOnline(p);
          return '<button type="button" class="p-sugg-row" data-action="pick" data-name="' + esc(p.name) + '">' + P.avatar(p.name, 'avatar-sm')
            + '<span class="p-sugg-name">' + esc(p.name) + '</span>'
            + '<span class="p-sugg-meta' + (on ? ' is-on' : '') + '">' + (on ? '<i class="p-dot"></i>Online now' : 'Last seen ' + esc(P.timeAgo(p.last_seen).toLowerCase())) + '</span></button>';
        }).join('') + '</div>';
      } else if (!t) h += '<p class="hint-line">Nobody has been seen online yet — type a name to punish anyone.</p>';
    }
    return h;
  }

  /* ---------------- step 2 ---------------- */
  function tplChips(u) {
    return '<div class="p-reasons">' + P.allTemplates().map(function (tp) {
      return '<button type="button" class="chip p-tchip ' + P.actionClass(tp.type) + (u.tpl === tp.key ? ' is-active' : '') + '" data-action="tpl" data-key="' + esc(tp.key) + '"><i class="p-dot"></i>' + esc(tp.name) + '</button>';
    }).join('') + '</div>';
  }
  function ladder(u, tp, target) {
    var sug = P.suggestedStep(target, tp);
    var h = '<div class="p-tpl"><div class="p-tpl-top">' + P.typePill(tp.type) + '<b>' + esc(tp.name) + '</b>'
      + '<span class="p-tpl-by">' + (tp.id ? 'custom · by ' + esc(tp.by) : 'guideline') + '</span>';
    if (tp.id && (tp.byId === me().id || P.canServerConfig())) h += '<button type="button" class="gl-btn gl-btn-ghost gl-btn-sm p-tpl-rm" data-action="tplRemove">Remove</button>';
    h += '</div><div class="p-ladder">';
    tp.steps.forEach(function (st, i) {
      var type = st === 'Warn' ? 'Warn' : tp.type;
      var on = !!target && i === sug;
      var nth = ORD[i] || (i + 1) + 'th';
      var lab = st === 'Permanent' ? 'Perm ' + tp.type.toLowerCase() : st;
      h += '<button type="button" class="p-rung ' + P.actionClass(type) + (on ? ' is-next' : '') + '" data-action="step" data-i="' + i + '">' + esc(nth + ' · ' + lab) + '</button>';
      if (st === 'Permanent' && tp.type === 'Ban' && P.canWipeban()) {
        h += '<button type="button" class="p-rung wipeban' + (on ? ' is-next' : '') + '" data-action="step" data-i="' + i + '" data-wipe="1">' + esc(nth + ' · Wipeban') + '</button>';
      }
    });
    h += '</div>';
    if (tp.note) h += '<p class="p-tpl-note">' + esc(tp.note) + '</p>';
    h += '<p class="hint-line">' + (target
      ? 'Highlighted: the next rung for ' + esc(target) + ' (' + sug + ' earlier under this offence). Picking a step opens the usual confirm.'
      : 'Type or pick a player to see which rung comes next.')
      + ' If the automute already muted them, leave that mute alone.</p>'
      + '<p class="hint-line">Click the offence again for manual actions.</p></div>';
    return h;
  }
  function manual(u, target) {
    var off = target ? '' : ' p-off';
    var acts = ['Warn', 'Mute', 'Kick', 'Ban', 'Unban'].concat(P.canWipeban() ? ['Wipeban'] : []);
    var h = '<div class="p-actions">';
    acts.forEach(function (t) {
      h += '<button type="button" class="p-act ' + P.actionClass(t) + (t === 'Ban' ? ' is-key' : '') + off + '" data-action="manual" data-type="' + t + '">' + t + '</button>';
    });
    h += '</div><p class="hint-line p-actions-hint">' + (target
      ? 'Pick an action for ' + esc(target) + ' — you add a reason and proof next.'
      : 'Pick a player above first.') + '</p>';
    return h;
  }
  function tplForm(u) {
    return '<div class="p-tform">'
      + '<div class="field-label">New template <span class="hint">shared with all staff on this server</span></div>'
      + '<input class="gl-input" type="text" id="infractions-tname" data-field="tName" placeholder="Offence, e.g. Griefing" value="' + esc(u.tName) + '">'
      + '<div class="chip-wrap p-tform-types">' + ['Warn', 'Mute', 'Ban'].map(function (t) {
        return '<button type="button" class="chip p-tchip ' + P.actionClass(t) + (u.tType === t ? ' is-active' : '') + '" data-action="tType" data-v="' + t + '"><i class="p-dot"></i>' + t + '</button>';
      }).join('') + '</div>'
      + '<input class="gl-input" type="text" id="infractions-tsteps" data-field="tSteps" data-enter="tplSave" placeholder="Steps, e.g. 30m, 3h, 1d, 7d, perm" value="' + esc(u.tSteps) + '">'
      + '<p class="hint-line">' + esc(stepsHelp(u)) + '</p>'
      + '<input class="gl-input" type="text" id="infractions-tnote" data-field="tNote" data-enter="tplSave" placeholder="Note for staff (optional)" value="' + esc(u.tNote) + '">'
      + '<div class="p-tform-btns"><button type="button" class="gl-btn gl-btn-ghost gl-btn-sm" data-action="tplToggle">Cancel</button>'
      + '<button type="button" class="gl-btn gl-btn-primary gl-btn-sm" data-action="tplSave">Save template</button></div></div>';
  }
  function stepWhy(u) {
    var target = targetOf(u);
    var tp = u.tpl ? P.allTemplates().filter(function (x) { return x.key === u.tpl; })[0] : null;
    var canTpl = P.hasPerm('Warn') || P.hasPerm('Mute') || P.hasPerm('Ban');
    var h = '<div class="p-step"><span class="p-num">2</span><h3>Why?</h3>'
      + (canTpl && !u.tplOpen ? '<button type="button" class="gl-btn gl-btn-ghost gl-btn-sm p-tpl-add" data-action="tplToggle">+ Custom template</button>' : '') + '</div>';
    if (u.tplOpen) h += tplForm(u);
    h += tplChips(u);
    if (tp) h += ladder(u, tp, target);
    else h += manual(u, target);
    return h;
  }

  /* ---------------- right: record ---------------- */
  function record(u) {
    var target = targetOf(u);
    if (!target) return '<div class="gl-card p-card p-record"><div class="empty p-empty">Pick a player to see their record.</div></div>';
    var t = target.toLowerCase();
    // The record is the ledger: every punishment the server actually carried out, wherever it was
    // issued. Reading mod_actions here showed only what this panel queued, so a player banned in
    // game read as "No punishments yet" -- the reason somebody would then hand out a first warning
    // to a repeat offender. P.playerRecord falls back to mod_actions when the ledger is absent.
    var rec = P.playerRecord(target);
    var all = rec.history.map(function (e) { return e.row; });
    var rows = all.slice(0, 12);
    var h = '<div class="gl-card p-card p-record"><h3 class="p-hist-head">' + esc(target) + '’s record</h3>';
    if (!rows.length) h += '<div class="empty">No punishments yet.</div>';
    else {
      h += '<div class="p-hist">' + rows.map(function (a) {
        var bits = [];
        if (a.duration) bits.push(esc(a.duration));
        bits.push('by ' + esc(a.by_name));
        bits.push(esc(P.timeAgo(a.created_at)));
        if (a.revoked_at) bits.push('lifted by ' + esc(a.revoked_by || 'staff'));
        if (a.silent) bits.push('silent');
        return '<div class="p-row"><span class="p-what">' + P.typePill(a.type) + esc(a.reason) + ' <span class="p-dim">· ' + bits.join(' · ') + '</span>'
          + (a.status === 'Failed' && a.error ? '<span class="p-err">' + esc(a.error) + '</span>' : '')
          + (a.proof && a.proof.length ? '<span class="p-proof">' + P.proofLinks(a.proof) + '</span>' : '')
          + '</span>' + P.statusPill(a.status, a.error) + '</div>';
      }).join('') + '</div>';
      if (all.length > 12) h += '<a class="p-more" href="#audit/' + esc(encodeURIComponent(target)) + '" data-goto="audit/' + esc(target) + '">+ ' + (all.length - 12) + ' older — see History</a>';
    }
    return h + '</div>';
  }

  /* ---------------- template save ---------------- */
  function saveTemplate(u) {
    var name = u.tName.trim();
    var steps = P.parseSteps(u.tSteps);
    if (!name) { P.toast('fail', 'Give the template a name (the offence).'); return; }
    if (!steps) { P.toast('fail', 'Steps not understood. Use e.g. "30m, 3h, 1d, 7d, perm" or "Warn, 7d, 14d".'); return; }
    if (u.tType === 'Warn' && steps.some(function (st) { return st !== 'Warn'; })) { P.toast('fail', 'A Warn template can only have "warn" steps. Pick Mute or Ban for durations.'); return; }
    var problem = P.templateProblem(u.tType, steps);
    if (problem) { P.toast('fail', problem); return; }
    P.api.addTemplate(name, u.tType, steps, u.tNote.trim()).then(function (ok) {
      if (!ok) return;
      u.tplOpen = false; u.tName = ''; u.tSteps = ''; u.tNote = '';
      P.rerender();
    });
  }

  P.registerScreen('infractions', {
    title: 'Infractions',
    nav: { label: 'Infractions', icon: 'infractions', order: 20 },
    onEnter: function (s) {
      if (s.param) { var u = ui(); u.target = String(s.param).trim(); u.q = u.target; }
    },
    render: function (root) {
      var u = ui();
      root.innerHTML = '<div class="page-head"><div><h2>Infractions</h2><p class="sub">Pick a player, pick a reason — we suggest the rest.</p></div></div>'
        + '<div class="p-grid"><div class="p-col">'
        + '<div class="gl-card p-card">' + stepWho(u) + '</div>'
        + '<div class="gl-card p-card">' + stepWhy(u) + '</div>'
        + '</div>' + record(u) + '</div>';
    },
    onInput: function (f, el) {
      var u = ui();
      if (f === 'q') { u.q = el.value; u.target = ''; P.rerender(); return; }
      if (f === 'tName') u.tName = el.value;
      else if (f === 'tSteps') u.tSteps = el.value;
      else if (f === 'tNote') u.tNote = el.value;
    },
    onAction: function (a, el) {
      var u = ui(), target = targetOf(u);
      if (a === 'pick') { u.target = el.getAttribute('data-name'); u.q = u.target; P.rerender(); return; }
      if (a === 'pickTyped') { u.target = u.q.trim(); P.rerender(); return; }
      if (a === 'clear') { u.target = ''; u.q = ''; P.rerender(); var q = document.getElementById('infractions-q'); if (q) q.focus(); return; }
      if (a === 'tpl') { var k = el.getAttribute('data-key'); u.tpl = u.tpl === k ? null : k; P.rerender(); return; }
      if (a === 'tplToggle') { u.tplOpen = !u.tplOpen; P.rerender(); return; }
      if (a === 'tType') { u.tType = el.getAttribute('data-v'); if (u.tType === 'Warn') u.tSteps = 'warn'; P.rerender(); return; }
      if (a === 'tplSave') { saveTemplate(u); return; }
      if (a === 'tplRemove') {
        var tp = P.allTemplates().filter(function (x) { return x.key === u.tpl; })[0];
        if (!tp || !tp.id) return;
        P.confirm('Remove the template "' + tp.name + '" for everyone on this server?', 'Remove', 'danger').then(function (ok) {
          if (!ok) return;
          P.api.removeTemplate(tp.id).then(function (done) { if (done) { u.tpl = null; P.toast('ok', 'Template removed.'); P.rerender(); } });
        });
        return;
      }
      if (a === 'step') {
        if (!target) { P.toast('fail', 'Type or pick a player name first.'); return; }
        var t2 = P.allTemplates().filter(function (x) { return x.key === u.tpl; })[0]; if (!t2) return;
        var st = t2.steps[Number(el.getAttribute('data-i'))]; if (!st) return;
        if (el.getAttribute('data-wipe')) { P.openPunish({ type: 'Wipeban', target: target, reason: t2.name }); return; }
        if (st === 'Warn') { P.openPunish({ type: 'Warn', target: target, reason: t2.name }); return; }
        P.openPunish({ type: t2.type, target: target, reason: t2.name, duration: st });
        return;
      }
      if (a === 'manual') {
        if (!target) { P.toast('fail', 'Type or pick a player name first.'); return; }
        P.openPunish({ type: el.getAttribute('data-type'), target: target, reason: '' });
      }
    }
  });
})();
