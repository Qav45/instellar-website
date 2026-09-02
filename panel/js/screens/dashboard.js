/* =========================================================================
   Dashboard (Owner / Moderator overview) — every number is computed from
   P.state.data (punishments30, recent30 queue, presenceAll, staffAll, actions, anns, serverStatus).
   Range chips (Today / 7 days / 30 days) filter ledger rows by created_at and
   by the current server. The 14-day chart ignores the range.
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P;
  var esc = P.esc;
  var DAY = 86400000;
  var PUNISH = ['Ban', 'IP ban', 'Blacklist', 'Wipeban', 'Mute', 'Warn', 'Kick'];   // Unban/Unmute are not punishments

  function ui() { return P.ui('dashboard', { range: 7, ann: '' }); }
  function isPunish(a) { return PUNISH.indexOf(a.type) > -1 && ['Active', 'Expired', 'Lifted', 'Executed', 'Pending'].indexOf(a.status) > -1; }
  function ts(iso) { var t = new Date(iso).getTime(); return isNaN(t) ? 0 : t; }
  function startOfToday() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  // Current window + the window before it, in ms.
  function windows(range) {
    var now = Date.now();
    if (range === 1) { var t0 = startOfToday(); return { from: t0, to: now, pFrom: t0 - DAY, pTo: t0 }; }
    var len = range * DAY;
    return { from: now - len, to: now, pFrom: now - 2 * len, pTo: now - len };
  }
  function rangeLabel(range) { return range === 1 ? 'today' : 'last ' + range + ' days'; }

  function inWin(rows, from, to, server) {
    return rows.filter(function (a) { var t = ts(a.created_at); return a.server === server && t >= from && t < to; });
  }
  function reasonGroup(reason) {
    var r = String(reason || '').trim(), rl = r.toLowerCase();
    var tps = P.builtinTemplates();
    for (var i = 0; i < tps.length; i++) { if (rl.indexOf(tps[i].name.toLowerCase()) === 0) return tps[i].name; }
    return r || '(no reason)';
  }
  function verb(t) { return ({ Ban: 'banned', 'IP ban': 'IP banned', Blacklist: 'blacklisted', Wipeban: 'wipebanned', Mute: 'muted', Warn: 'warned', Kick: 'kicked', Unban: 'unbanned', Unmute: 'unmuted' })[t] || String(t || '').toLowerCase(); }
  function lastSeenOf(st, byActs) {
    var t = st.last_seen_at ? ts(st.last_seen_at) : 0;
    var acts = Math.max(byActs[st.id] || 0, byActs[st.display_name] || 0);
    return Math.max(t, acts);
  }

  /* ---------------- chart (14 days, stacked) ---------------- */
  var SERIES = [
    { key: 'ban', label: 'Bans', types: ['Ban', 'Wipeban'] },
    { key: 'mute', label: 'Mutes', types: ['Mute'] },
    { key: 'warn', label: 'Warns', types: ['Warn'] },
    { key: 'kick', label: 'Kicks', types: ['Kick'] }
  ];
  function niceStep(max) {
    if (max <= 4) return 1;
    var raw = max / 3, pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / pow;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  }
  function chart(rows, server) {
    var t0 = startOfToday();
    var days = [];
    for (var i = 13; i >= 0; i--) {
      var from = t0 - i * DAY;
      days.push({ from: from, to: from + DAY, counts: [0, 0, 0, 0], total: 0 });
    }
    var idxOf = {}; days.forEach(function (d, i) { idxOf[d.from] = i; });
    rows.forEach(function (a) {
      if (a.server !== server || !isPunish(a)) return;
      var t = ts(a.created_at); if (!t) return;
      var d = days[idxOf[new Date(t).setHours(0, 0, 0, 0)]];
      if (!d) return;
      for (var s = 0; s < SERIES.length; s++) { if (SERIES[s].types.indexOf(a.type) > -1) { d.counts[s]++; d.total++; } }
    });
    var totals = [0, 0, 0, 0], grand = 0;
    days.forEach(function (d) { d.counts.forEach(function (c, s) { totals[s] += c; }); grand += d.total; });
    var max = Math.max.apply(null, days.map(function (d) { return d.total; }));
    var step = niceStep(max);
    var top = Math.max(step, Math.ceil(max / step) * step);

    var W = 700, H = 292, L = 34, R = 8, T = 18, B = 46;
    var plotH = H - T - B, plotW = W - L - R;
    var slot = plotW / 14, bw = 24;
    var scale = plotH / top;
    var svg = '', defs = '', gap = 2, radius = 4;
    // grid + y labels
    for (var v = 0; v <= top; v += step) {
      var y = T + plotH - v * scale;
      svg += '<line class="d-grid' + (v === 0 ? ' is-base' : '') + '" x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '"/>'
        + '<text class="d-ylab" x="' + (L - 10) + '" y="' + (y + 4).toFixed(1) + '">' + v + '</text>';
    }
    var wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var bars = '', labels = '';
    days.forEach(function (d, i) {
      var x = L + slot * i + (slot - bw) / 2, cx = x + bw / 2;
      var base = T + plotH, isToday = i === 13;
      if (d.total > 0) {
        var hTot = d.total * scale;
        var yTop = base - hTot;
        var r = Math.min(radius, hTot / 2);
        defs += '<clipPath id="dashbar' + i + '"><path d="M' + x.toFixed(1) + ' ' + base + ' V' + (yTop + r).toFixed(1) + ' Q' + x.toFixed(1) + ' ' + yTop.toFixed(1) + ' ' + (x + r).toFixed(1) + ' ' + yTop.toFixed(1)
          + ' H' + (x + bw - r).toFixed(1) + ' Q' + (x + bw).toFixed(1) + ' ' + yTop.toFixed(1) + ' ' + (x + bw).toFixed(1) + ' ' + (yTop + r).toFixed(1) + ' V' + base + ' Z"/></clipPath>';
        var yCur = base, segs = '', drawn = d.counts.filter(Boolean).length, k = 0;
        d.counts.forEach(function (c, s) {
          if (!c) return;
          var h = c * scale, y0 = yCur - h;
          k++;
          // 2px surface gap between touching segments: every segment but the topmost gives up 2px at its top
          var isTop = k === drawn, gy = isTop ? y0 : y0 + gap, gh = Math.max(0.5, isTop ? h : h - gap);
          segs += '<rect class="d-seg d-' + SERIES[s].key + '" x="' + x.toFixed(1) + '" y="' + gy.toFixed(1) + '" width="' + bw + '" height="' + gh.toFixed(1) + '"' + (isToday ? '' : ' opacity=".82"') + '><title>' + esc(SERIES[s].label + ': ' + c) + '</title></rect>';
          yCur = y0;
        });
        bars += '<g clip-path="url(#dashbar' + i + ')">' + segs + '</g>';
        if (isToday) bars += '<text class="d-total" x="' + cx.toFixed(1) + '" y="' + (yTop - 8).toFixed(1) + '">' + d.total + '</text>';
      }
      var lab = isToday ? 'Today' : wd[new Date(d.from).getDay()];
      labels += '<text class="d-xlab' + (isToday ? ' is-today' : '') + '" x="' + cx.toFixed(1) + '" y="' + (H - 22) + '">' + lab + '</text>';
    });
    var aria = 'Punishments per day for the last 14 days on ' + P.serverName(server) + ': ' + grand + ' total — '
      + SERIES.map(function (s, i) { return totals[i] + ' ' + s.label.toLowerCase(); }).join(', ') + '.';
    var legend = '<div class="d-legend">' + SERIES.map(function (s, i) {
      return '<span class="d-lg"><i class="d-sw d-' + s.key + '"></i>' + s.label + ' <span class="d-lg-n">' + totals[i] + '</span></span>';
    }).join('') + '</div>';
    var body = grand
      ? '<svg class="d-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(aria) + '"><defs>' + defs + '</defs>' + svg + bars + labels + '</svg>'
      : '<div class="empty d-chart-empty">No punishments in the last 14 days.</div>';
    return '<div class="gl-glass d-card"><div class="d-card-head"><h3>Punishments · last 14 days</h3>' + legend + '</div>' + body + '</div>';
  }

  /* ---------------- render ---------------- */
  function render(root, s) {
    var u = ui(), d = s.data, server = s.server, srvName = P.serverName(server);
    var queue = d.recent30 || [], recent = d.punishments30 ? P.ledgerRows(d.punishments30) : queue, actions = d.actions || [], staff = d.staff || [];
    var w = windows(u.range);
    var cur = inWin(recent, w.from, w.to, server);
    var prev = inWin(recent, w.pFrom, w.pTo, server);
    var queueCur = inWin(queue, w.from, w.to, server);
    var rl = rangeLabel(u.range);

    // --- tiles
    var onlineAll = (d.presenceAll || []).filter(P.isOnline);
    var on1 = onlineAll.filter(function (p) { return p.server === 'instellar1'; }).length;
    var on2 = onlineAll.filter(function (p) { return p.server === 'instellar2'; }).length;

    var punCur = cur.filter(isPunish).length, punPrev = prev.filter(isPunish).length;
    var diff = punCur - punPrev;
    var diffHtml = diff === 0 ? 'same as the period before'
      : '<span class="' + (diff > 0 ? 'd-up' : 'd-down') + '">' + (diff > 0 ? '▲ ' : '▼ ') + Math.abs(diff) + '</span> vs the period before';

    var approvals = actions.filter(function (a) { return a.status === 'Approval'; });
    var oldest = approvals.reduce(function (m, a) { var t = ts(a.created_at); return (!m || t < m) ? t : m; }, 0);

    var activeIds = {}; cur.forEach(function (a) { if (a.by_id) activeIds[a.by_id] = 1; else if (a.by_name) activeIds[a.by_name] = 1; });
    var activeCount = Object.keys(activeIds).length;
    var lastActBy = {};
    recent.forEach(function (a) { var t = ts(a.created_at); if (a.by_id && t > (lastActBy[a.by_id] || 0)) lastActBy[a.by_id] = t; if (a.by_name && t > (lastActBy[a.by_name] || 0)) lastActBy[a.by_name] = t; });
    var unused = staff.filter(function (st) { return lastSeenOf(st, lastActBy) < Date.now() - 30 * DAY; });

    var tiles = '<div class="d-stats">'
      + '<div class="stat gl-glass d-stat"><div class="stat-label">Players online now</div><div class="stat-value d-big"><i class="d-live"></i>' + onlineAll.length + '</div>'
      + '<div class="stat-sub">' + on1 + ' on Instellar 1 · ' + on2 + ' on Instellar 2</div></div>'
      + '<div class="stat gl-glass d-stat"><div class="stat-label">Punishments · ' + esc(rl) + '</div><div class="stat-value d-big">' + punCur + '</div><div class="stat-sub">' + diffHtml + '</div></div>'
      + '<div class="stat gl-glass d-stat d-stat-link" data-goto="approvals" role="link" tabindex="0"><div class="stat-label">Waiting for approval</div><div class="stat-value d-big' + (approvals.length ? ' is-warn' : '') + '">' + approvals.length + '</div>'
      + '<div class="stat-sub">' + (approvals.length ? 'oldest waiting ' + esc(P.timeAgo(new Date(oldest).toISOString()).toLowerCase()) : 'nothing waiting') + '</div></div>'
      + '<div class="stat gl-glass d-stat"><div class="stat-label">Staff active · ' + esc(rl) + '</div><div class="stat-value d-big">' + activeCount + '<span class="d-of">of ' + staff.length + '</span></div>'
      + '<div class="stat-sub">unused 30 days: ' + unused.length + '</div></div>'
      + '</div>';

    // --- top reasons
    var groups = {};
    cur.filter(isPunish).forEach(function (a) { var g = reasonGroup(a.reason); groups[g] = (groups[g] || 0) + 1; });
    var top = Object.keys(groups).map(function (k) { return { name: k, n: groups[k] }; }).sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name); }).slice(0, 6);
    var maxR = top.length ? top[0].n : 0;
    var reasons = '<div class="gl-glass d-card"><div class="d-card-head"><h3>Top reasons · ' + esc(rl) + '</h3></div>'
      + (top.length ? '<div class="d-rz-list">' + top.map(function (r) {
        return '<div class="d-rz"><span class="d-rz-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span><span class="d-rz-count">' + r.n + '</span><span class="d-rz-track"><i style="width:' + P.pct(r.n, maxR) + '%"></i></span></div>';
      }).join('') + '</div>' : '<div class="empty">No punishments ' + esc(rl) + '.</div>') + '</div>';

    // --- needs your attention
    var failed = queueCur.filter(function (a) { return a.status === 'Failed'; }).length;
    var blocks24 = (d.blocks || []).filter(function (b) { return ts(b.created_at) > Date.now() - DAY; }).length;
    var attn = [];
    if (approvals.length) attn.push('<div class="d-attn-row"><i class="d-attn-dot is-warn"></i><span class="d-attn-txt"><b>' + plural(approvals.length, 'punishment') + '</b> ' + (approvals.length === 1 ? 'is' : 'are') + ' waiting for approval</span><button type="button" class="gl-btn gl-btn-primary gl-btn-sm" data-goto="approvals">Review</button></div>');
    if (failed) attn.push('<div class="d-attn-row"><i class="d-attn-dot is-danger"></i><span class="d-attn-txt"><b>' + plural(failed, 'command') + ' failed</b> ' + esc(rl) + ' because the server could not execute ' + (failed === 1 ? 'it' : 'them') + '</span><button type="button" class="gl-btn gl-btn-sm" data-action="seeFailed">See</button></div>');
    if (unused.length) attn.push('<div class="d-attn-row"><i class="d-attn-dot is-muted"></i><span class="d-attn-txt"><b>' + plural(unused.length, 'staff account') + '</b> ' + (unused.length === 1 ? 'has' : 'have') + ' not been used for 30 days</span><button type="button" class="gl-btn gl-btn-sm" data-goto="staff">View staff</button></div>');
    if (P.isSupervisor() && blocks24) attn.push('<div class="d-attn-row"><i class="d-attn-dot is-warn"></i><span class="d-attn-txt"><b>' + plural(blocks24, 'punishment') + '</b> ' + (blocks24 === 1 ? 'was' : 'were') + ' blocked by protection in the last 24 hours</span><button type="button" class="gl-btn gl-btn-sm" data-goto="protection">See</button></div>');
    var attention = '<div class="gl-glass d-card d-attn"><div class="d-card-head"><h3>Needs your attention</h3></div>'
      + (attn.length ? '<div class="d-attn-list">' + attn.join('') + '</div>' : '<div class="d-attn-clear"><i class="d-attn-dot is-ok"></i>All clear — nothing needs you right now.</div>') + '</div>';

    // --- most active staff
    var byStaff = {};
    cur.forEach(function (a) { var n = a.by_name || '—'; byStaff[n] = (byStaff[n] || 0) + 1; });
    var topStaff = Object.keys(byStaff).map(function (k) { return { name: k, n: byStaff[k] }; }).sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name); }).slice(0, 5);
    var maxS = topStaff.length ? topStaff[0].n : 0;
    var staffCard = '<div class="gl-glass d-card"><div class="d-card-head"><h3>Most active staff · ' + esc(rl) + '</h3></div>'
      + (topStaff.length ? '<div class="d-staff-list">' + topStaff.map(function (r) {
        var st = P.staffByName(r.name);
        return '<div class="d-staff">' + P.avatar(r.name, 'avatar-sm') + '<span class="d-staff-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span>'
          + (st ? P.rolePill(st.role) : '<span class="d-staff-norole">—</span>')
          + '<span class="d-staff-track"><i style="width:' + P.pct(r.n, maxS) + '%"></i></span><span class="d-staff-num">' + r.n + '</span></div>';
      }).join('') + '</div>' : '<div class="empty">No staff activity ' + esc(rl) + '.</div>') + '</div>';

    // --- servers
    var servers = '<div class="gl-glass d-card"><div class="d-card-head"><h3>Servers</h3></div><div class="d-srv-list">' + P.cfg.SERVERS.map(function (sv) {
      var id = sv[0];
      var online = (d.presenceAll || []).filter(function (p) { return p.server === id && P.isOnline(p); }).length;
      var last = recent.filter(function (a) { return a.server === id && isPunish(a); })[0];
      var st = (d.serverStatus || []).filter(function (r) { return r.server === id; })[0];
      var newestPres = (d.presenceAll || []).filter(function (p) { return p.server === id; }).reduce(function (m, p) { var t = ts(p.last_seen); return t > m ? t : m; }, 0);
      var live = st ? (Date.now() - ts(st.last_seen) < 5 * 60000) : online > 0;
      var second = st
        ? '<span class="d-srv-num">' + esc(st.tps === null || st.tps === undefined ? '—' : Number(st.tps).toFixed(1)) + ' <em>TPS</em></span>'
        : '<span class="d-srv-num d-srv-dim">—</span>';
      var meta = 'Last punishment ' + esc(last ? P.timeAgo(last.created_at).toLowerCase() : 'never') + ' · '
        + (st ? 'checked in ' + esc(P.timeAgo(st.last_seen).toLowerCase()) : 'last player update ' + esc(newestPres ? P.timeAgo(new Date(newestPres).toISOString()).toLowerCase() : 'never'));
      return '<div class="d-srv' + (id === server ? ' is-current' : '') + '"><span class="d-srv-name"><i class="d-live' + (live ? '' : ' is-off') + '"></i>' + esc(sv[1]) + '</span>'
        + '<span class="d-srv-num">' + online + ' <em>' + (online === 1 ? 'player' : 'players') + '</em></span>' + second
        + '<span class="d-srv-meta">' + meta + '</span></div>';
    }).join('') + '</div></div>';

    // --- announcements
    var canPost = P.canEditGuides();
    var anns = (d.anns || []).slice().sort(function (a, b) { return ts(b.created_at) - ts(a.created_at); });
    var annCard = '<div class="gl-glass d-card d-anns"><div class="d-card-head"><h3>Announcements</h3></div>'
      + (canPost ? '<input class="gl-input d-ann-input" type="text" maxlength="500" placeholder="Write an announcement… (Enter to post)" data-field="ann" data-enter="postAnn" value="' + esc(u.ann) + '" aria-label="Write an announcement">' : '')
      + (anns.length ? '<div class="d-ann-list">' + anns.map(function (a) {
        return '<div class="ann d-ann"><p>' + esc(a.body) + '</p><div class="d-ann-foot"><span class="by">' + esc(a.by_name || '—') + ' · ' + esc(P.timeAgo(a.created_at)) + '</span>'
          + (canPost ? '<button type="button" class="ghost-link d-ann-del" data-action="delAnn" data-id="' + esc(a.id) + '" aria-label="Delete announcement">Delete</button>' : '') + '</div></div>';
      }).join('') + '</div>' : '<div class="empty">No announcements.</div>') + '</div>';

    // --- latest activity
    var latest = (d.punishments30 ? P.ledgerRows(d.punishments30).filter(function (a) { return a.server === server; }) : actions).slice(0, 6);
    var act = '<div class="list gl-glass d-act" style="--cols:26px minmax(0,1fr) auto auto"><div class="list-top"><h3>Latest activity</h3><span class="gl-spacer"></span><a class="ghost-link" href="#audit" data-goto="audit">See all history →</a></div>'
      + (latest.length ? '<div class="list-body">' + latest.map(function (a) {
        var sub = [a.reason, a.duration].filter(Boolean).map(esc).join(' · ');
        return '<div class="list-row" data-action="player" data-name="' + esc(a.target) + '" tabindex="0" role="button">' + P.avatar(a.target, 'avatar-sm')
          + '<span class="main"><span class="name">' + esc(a.by_name || '—') + ' ' + esc(verb(a.type)) + ' <b>' + esc(a.target) + '</b></span><span class="sub">' + (sub || '—') + '</span></span>'
          + '<span class="meta">' + esc(P.timeAgo(a.created_at)) + '</span>' + P.statusPill(a.status, a.error) + '</div>';
      }).join('') + '</div>' : '<div class="empty">No punishments yet.</div>') + '</div>';

    var chips = [[1, 'Today'], [7, '7 days'], [30, '30 days']].map(function (c) {
      return '<button type="button" class="chip' + (u.range === c[0] ? ' is-active' : '') + '" data-action="range" data-v="' + c[0] + '"' + (u.range === c[0] ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' + c[1] + '</button>';
    }).join('');

    root.innerHTML = '<div class="page-head"><div><h2>Dashboard</h2><p class="sub">How ' + esc(srvName) + ' is doing</p></div><div class="actions"><div class="d-seg-chips" role="group" aria-label="Time range">' + chips + '</div></div></div>'
      + tiles
      + '<div class="d-row d-row-chart">' + chart(recent, server) + reasons + '</div>'
      + attention
      + '<div class="d-row d-row-two">' + staffCard + servers + '</div>'
      + '<div class="d-row d-row-two">' + act + annCard + '</div>';
  }

  function onAction(action, el) {
    var u = ui();
    if (action === 'range') { u.range = Number(el.getAttribute('data-v')) || 7; P.rerender(); return; }
    if (action === 'seeFailed') { P.ui('audit', { q: '', filter: 'All' }).filter = 'Failed'; P.route('audit'); return; }
    if (action === 'player') { var n = el.getAttribute('data-name'); if (n) P.openPlayer(n); return; }
    if (action === 'postAnn') {
      var text = String(u.ann || '').trim();
      if (!text) return;
      u.ann = ''; P.rerender();
      P.api.postAnn(text);
      return;
    }
    if (action === 'delAnn') {
      var id = el.getAttribute('data-id');
      var a = (P.state.data.anns || []).filter(function (x) { return String(x.id) === String(id); })[0];
      if (!a) return;
      P.confirm('Delete this announcement?', 'Delete', 'danger').then(function (ok) { if (ok) P.api.removeAnn(a.id); });
    }
  }
  function onInput(field, el) {
    if (field === 'ann') ui().ann = el.value;
  }

  P.registerScreen('dashboard', {
    title: 'Dashboard',
    nav: { label: 'Dashboard', icon: 'dashboard', order: 10 },
    render: render, onAction: onAction, onInput: onInput
  });
})();
