/* =========================================================================
   Supervisor dashboard — key 'supdash' (Supervisor only, no nav entry: the
   sidebar's Dashboard routes Supervisors here via core.js resolveKey).
   Everything is computed from P.state.data (both servers). Classes: .s-*
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P;
  var esc = P.esc;
  var KEY = 'supdash';
  var DAY = 86400000, HOUR = 3600000, MIN = 60000;

  /* ---------------- small pure helpers ---------------- */
  function ui() { return P.ui(KEY, { range: 7 }); }
  function ts(iso) { var t = new Date(iso).getTime(); return isNaN(t) ? 0 : t; }
  function list(v) { return Array.isArray(v) ? v : []; }
  function newestFirst(rows) { return rows.slice().sort(function (a, b) { return ts(b.created_at) - ts(a.created_at); }); }
  function rangeStart(r) {
    if (r === 1) { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    return Date.now() - r * DAY;
  }
  function rangeLabel(r) { return r === 1 ? 'today' : 'last ' + r + ' days'; }
  function inRange(rows, r) { var s = rangeStart(r); return list(rows).filter(function (a) { return ts(a.created_at) >= s; }); }
  function sinceMidnight(rows) { return inRange(rows, 1); }
  function younger(rows, ms) { var lim = Date.now() - ms; return list(rows).filter(function (a) { return ts(a.created_at) >= lim; }); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function durText(ms) {
    if (ms < HOUR) return plural(Math.max(1, Math.floor(ms / MIN)), 'minute');
    if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour');
    return plural(Math.floor(ms / DAY), 'day');
  }
  function agoLower(iso) { var t = P.timeAgo(iso); return t === 'Just now' ? 'just now' : t; }
  function hasProof(a) { return list(a.proof).some(function (u) { return typeof u === 'string' && !!u; }); }
  function isBanish(a) { return a.type === 'Ban' || a.type === 'Wipeban'; }
  function isDeniedReal(a) { return a.status === 'Denied' && !P.isProtectedError(a.error); }
  function isApprovedReq(a) { return a.status === 'Pending' || a.status === 'Executed' || a.status === 'Failed'; }
  function byStaff(a, s) { return a.by_id ? a.by_id === s.id : (!!a.by_name && a.by_name === s.display_name); }
  function staffMap(staffAll) { var m = {}; list(staffAll).forEach(function (s) { m[s.id] = s; }); return m; }
  // A request = the row needed (or needs) someone higher up to say yes.
  function isRequest(a, byId) {
    if (a.status === 'Approval' || isDeniedReal(a)) return true;
    var au = a.by_id ? byId[a.by_id] : null;
    return !!au && P.rank(P.requiredRole(a.type, a.duration)) > P.rank(au.role);
  }
  function serverTag(server) { return '<span class="s-srv-tag">' + esc(P.serverName(server)) + '</span>'; }
  function verb(type) { return ({ Ban: 'banned', Wipeban: 'wipebanned', Mute: 'muted', Kick: 'kicked', Warn: 'warned', Unban: 'unbanned' })[type] || String(type || '').toLowerCase(); }
  function short(text, n) { var t = String(text || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function pctText(a, b) { return b ? P.pct(a, b) + '%' : '—'; }

  /* ---------------- derived data ---------------- */
  // heartbeat per server: server_status.last_seen, else newest presence row for that server
  function heartbeat(d, server) {
    var st = list(d.serverStatus).filter(function (r) { return r.server === server; })[0];
    if (st && st.last_seen) return { at: ts(st.last_seen), fromPresence: false, tps: st.tps };
    var at = 0;
    list(d.presenceAll).forEach(function (p) { if (p.server === server) at = Math.max(at, ts(p.last_seen)); });
    return { at: at, fromPresence: true, tps: null };
  }
  function onlineOn(d, server) { return list(d.presenceAll).filter(function (p) { return p.server === server && P.isOnline(p); }).length; }

  function staffSentence(r) {
    var who = '<b>' + esc(r.display_name || r.username || 'Someone') + '</b>', by = ' <em>by ' + esc(r.by_name || 'unknown') + '</em>';
    if (r.action === 'invited') return who + ' was invited as ' + esc(r.new_role || '—') + by;
    if (r.action === 'role_changed') {
      var up = P.rank(r.new_role) > P.rank(r.old_role);
      return who + ' was ' + (up ? 'promoted' : 'moved down') + ' to ' + esc(r.new_role || '—') + ' (was ' + esc(r.old_role || '—') + ')' + by;
    }
    if (r.action === 'perms_changed') {
      var o = list(r.old_perms), n = list(r.new_perms);
      var added = n.filter(function (p) { return o.indexOf(p) < 0; }).map(function (p) { return '+' + p; });
      var removed = o.filter(function (p) { return n.indexOf(p) < 0; }).map(function (p) { return '−' + p; });
      var diff = added.concat(removed).join(', ') || 'no difference';
      return who + '&#39;s permissions changed: ' + esc(diff) + by;
    }
    if (r.action === 'removed') return who + ' lost staff access (was ' + esc(r.old_role || '—') + ')' + by;
    return who + ' — ' + esc(r.action || 'changed') + by;
  }
  function staffDot(action) { return ({ invited: 'is-ok', role_changed: 'is-gold', perms_changed: 'is-warn', removed: 'is-danger' })[action] || 'is-muted'; }
  function blockSentence(b) { return '<b>' + esc(b.by_name || 'Someone') + '</b> tried to ' + esc(String(b.type || 'punish').toLowerCase()) + ' <b>' + esc(b.target) + '</b>'; }

  // per-staff numbers inside the range
  function staffStats(s, rows, blocks, byId, allRows) {
    var mine = rows.filter(function (a) { return byStaff(a, s); });
    var reqs = mine.filter(function (a) { return isRequest(a, byId); });
    var denied = reqs.filter(isDeniedReal).length;
    var bans = mine.filter(isBanish).length;
    var noProof = mine.filter(function (a) { return P.isPermBan(a) && !hasProof(a); }).length;
    var myBlocks = blocks.filter(function (b) { return byStaff(b, s); }).length;
    var lastAct = newestFirst(list(allRows).filter(function (a) { return byStaff(a, s); }))[0];
    var lastOn = s.last_seen_at || (lastAct ? lastAct.created_at : null);
    var pct = reqs.length ? P.pct(denied, reqs.length) : null;
    var flag = (P.rank(s.role) <= 2 && bans >= 3) || noProof >= 2 || (pct !== null && pct >= 30 && reqs.length >= 5) || myBlocks >= 1;
    return { s: s, actions: mine.length, bans: bans, noProof: noProof, reqs: reqs.length, denied: denied, pct: pct, lastOn: lastOn, blocks: myBlocks, flag: flag };
  }
  function approvalSplit(rows, byId) {
    var reqs = rows.filter(function (a) { return isRequest(a, byId); });
    var denied = reqs.filter(isDeniedReal).length;
    var approved = reqs.filter(isApprovedReq).length;
    var waiting = reqs.filter(function (a) { return a.status === 'Approval'; }).length;
    return { total: reqs.length, approved: approved, denied: denied, waiting: waiting };
  }
  function unusedCount(staffAll, allRows) {
    var lim = Date.now() - 30 * DAY;
    return list(staffAll).filter(function (s) {
      var last = s.last_seen_at ? ts(s.last_seen_at) : 0;
      if (!last) { var a = newestFirst(list(allRows).filter(function (r) { return byStaff(r, s); }))[0]; last = a ? ts(a.created_at) : 0; }
      return last < lim;
    }).length;
  }

  function collect(s) {
    var d = s.data, r = ui().range;
    var byId = staffMap(d.staffAll);
    var all = list(d.recent30);
    var rows = inRange(all, r);
    var team = list(d.staffAll).filter(function (m) { return m.role !== 'Supervisor'; });
    var blocksR = inRange(d.blocks, r);
    var stats = team.map(function (m) { return staffStats(m, rows, blocksR, byId, all); })
      .sort(function (a, b) { return (b.flag - a.flag) || (b.actions - a.actions) || (b.bans - a.bans); });
    return { d: d, r: r, byId: byId, all: all, rows: rows, team: team, stats: stats, blocksR: blocksR, label: rangeLabel(r) };
  }

  /* ---------------- blocks ---------------- */
  function renderHead(c) {
    var chips = [[1, 'Today'], [7, '7 days'], [30, '30 days']].map(function (x) {
      return '<button type="button" class="chip' + (c.r === x[0] ? ' is-active' : '') + '" data-action="range" data-v="' + x[0] + '">' + x[1] + '</button>';
    }).join('');
    return '<div class="page-head"><div><div class="s-title"><h2>Supervisor overview</h2>' + P.rolePill('Supervisor') + '</div>'
      + '<p class="sub">Everything important, both servers.</p></div>'
      + '<div class="actions"><div class="s-chips" role="group" aria-label="Time range">' + chips + '</div></div></div>';
  }

  function critRow(cls, html, btn) {
    return '<div class="s-crit-row"><i class="s-dot ' + cls + '"></i><span class="s-crit-txt">' + html + '</span>'
      + (btn ? '<button type="button" class="gl-btn gl-btn-sm' + (btn.primary ? ' gl-btn-primary' : '') + '" data-goto="' + esc(btn.goto) + '">' + esc(btn.label) + '</button>' : '') + '</div>';
  }
  function criticalItems(c) {
    var d = c.d, items = [];
    var permNoProof = sinceMidnight(c.all).filter(function (a) { return P.isPermBan(a) && !hasProof(a); }).length;
    if (permNoProof) items.push(critRow('is-danger', '<b>' + esc(plural(permNoProof, 'permanent ban')) + ' today</b> ' + (permNoProof === 1 ? 'has' : 'have') + ' no proof', { label: 'Review', goto: 'audit', primary: true }));
    var newest = newestFirst(younger(d.staffAudit, DAY))[0];
    if (newest) items.push(critRow('is-gold', staffSentence(newest) + ' · ' + esc(P.timeAgo(newest.created_at)), { label: 'View staff', goto: 'staff' }));
    var blk = newestFirst(younger(d.blocks, DAY));
    if (blk.length) {
      var who = blk.slice(0, 2).map(function (b) { return esc(b.target) + ', by ' + esc(b.by_name || 'unknown'); }).join('; ');
      items.push(critRow('is-warn', '<b>' + esc(plural(blk.length, 'ban attempt')) + ' on protected players ' + (blk.length === 1 ? 'was' : 'were') + ' blocked</b> — ' + who + (blk.length > 2 ? ' …' : ''), { label: 'Protection', goto: 'protection' }));
    }
    P.cfg.SERVERS.forEach(function (sv) {
      var hb = heartbeat(d, sv[0]);
      var age = hb.at ? Date.now() - hb.at : Infinity;
      if (age <= 3 * MIN) return;
      var txt = hb.at ? (hb.fromPresence ? 'no player update for ' : 'has not checked in for ') + durText(age) : 'has never checked in';
      items.push(critRow('is-warn', '<b>' + esc(sv[1]) + '</b> ' + esc(txt), { label: 'Players', goto: 'players' }));
    });
    var failed = c.all.filter(function (a) { return a.status === 'Failed'; }).length;
    if (failed) items.push(critRow('is-danger', '<b>' + esc(plural(failed, 'command')) + ' failed</b> in the last 30 days', { label: 'History', goto: 'audit' }));
    return items.slice(0, 5);
  }
  function renderCritical(c) {
    var items = criticalItems(c);
    return '<div class="gl-glass s-card s-crit"><div class="s-card-head"><i class="s-gold-dot"></i><h3>Critical right now</h3></div>'
      + (items.length ? '<div class="s-crit-list">' + items.join('') + '</div>' : '<p class="s-calm">Nothing critical right now.</p>') + '</div>';
  }

  function tile(label, value, sub, cls) {
    return '<div class="stat gl-glass s-stat"><div class="stat-label">' + esc(label) + '</div><div class="stat-value s-big' + (cls ? ' ' + cls : '') + '">' + value + '</div><div class="stat-sub">' + esc(sub) + '</div></div>';
  }
  function renderStats(c) {
    var d = c.d, rows = c.rows;
    var on1 = onlineOn(d, 'instellar1'), on2 = onlineOn(d, 'instellar2');
    var perm = rows.filter(P.isPermBan), permNoProof = perm.filter(function (a) { return !hasProof(a); }).length;
    var wipe = rows.filter(function (a) { return a.type === 'Wipeban'; }).length;
    var ap = approvalSplit(rows, c.byId);
    var prot = P.activeProtected().length, blocked30 = list(d.blocks).length ? inRange(d.blocks, 30).length : 0;
    var staffN = list(d.staffAll).length;
    return '<div class="s-stats">'
      + tile('Players online', '<i class="s-live' + (on1 + on2 ? '' : ' is-off') + '"></i>' + (on1 + on2), on1 + ' + ' + on2 + ' on the two servers')
      + tile('Permanent bans', String(perm.length), c.label + ' · ' + permNoProof + ' with no proof')
      + tile('Wipebans', String(wipe), c.label)
      + tile('Approvals denied', pctText(ap.denied, ap.total), c.label + ' · about ' + ap.denied + ' of ' + ap.total + ' requests', ap.total && P.pct(ap.denied, ap.total) >= 20 ? 'is-warn' : '')
      + tile('Protected players', String(prot), blocked30 + ' blocked attempts in 30 days')
      + tile('Staff accounts', String(staffN), unusedCount(d.staffAll, c.all) + ' unused 30 days')
      + '</div>';
  }

  function staffRow(st) {
    var s = st.s;
    return '<div class="s-tr' + (st.flag ? ' is-flag' : '') + '">'
      + '<span class="s-who">' + P.avatar(s.display_name, 'avatar-sm') + '<span class="s-who-txt"><span class="s-who-name">' + esc(s.display_name || s.username) + '</span><small>' + esc(P.serverName(s.server)) + '</small></span></span>'
      + '<span>' + P.rolePill(s.role) + '</span>'
      + '<span class="r s-n">' + st.actions + '</span>'
      + '<span class="r s-n' + (st.flag && P.rank(s.role) <= 2 && st.bans >= 3 ? ' is-bad' : '') + '">' + st.bans + '</span>'
      + '<span class="r s-n' + (st.noProof >= 2 ? ' is-bad' : '') + '">' + st.noProof + '</span>'
      + '<span class="r s-n' + (st.pct !== null && st.pct >= 30 && st.reqs >= 5 ? ' is-bad' : '') + '">' + (st.pct === null ? '—' : st.pct + '%') + '</span>'
      + '<span class="r s-t">' + esc(st.lastOn ? P.timeAgo(st.lastOn) : '—') + '</span>'
      + '<span class="r">' + (st.flag ? '<span class="s-flag">Check</span>' : '') + '</span>'
      + '</div>';
  }
  function renderOversight(c) {
    var flagged = c.stats.filter(function (x) { return x.flag; }).length;
    var body = c.stats.length
      ? '<div class="tbl-scroll"><div class="s-tbl"><div class="s-th"><span>Member</span><span>Role</span><span class="r">Actions</span><span class="r">Bans</span><span class="r">No proof</span><span class="r">Denied</span><span class="r">Last on</span><span class="r">Flag</span></div>'
        + c.stats.map(staffRow).join('') + '</div></div>'
        + '<p class="s-note">' + (flagged ? esc(plural(flagged, 'person is', 'people are')) + ' flagged — worth a look.' : 'Nobody is flagged.') + '</p>'
      : '<div class="empty">No staff yet.</div>';
    return '<div class="gl-glass s-card"><div class="s-card-head"><h3>Staff oversight · ' + esc(c.label) + '</h3><span class="gl-spacer"></span><span class="ghost-link" data-goto="staff">All staff →</span></div>' + body + '</div>';
  }
  function renderBans(c) {
    var top = c.stats.slice().sort(function (a, b) { return (b.bans - a.bans) || (b.flag - a.flag); }).slice(0, 8);
    var max = top.reduce(function (m, x) { return Math.max(m, x.bans); }, 0);
    var bars = top.map(function (x) {
      var w = max ? Math.round(100 * x.bans / max) : 0;
      return '<div class="s-bar' + (x.flag ? ' is-flag' : '') + '" title="' + esc(x.s.display_name + ': ' + plural(x.bans, 'ban')) + '"><span class="s-bar-name">' + esc(x.s.display_name) + '</span>'
        + '<span class="s-bar-track"><i style="width:' + w + '%"></i></span><span class="s-bar-num">' + x.bans + '</span></div>';
    }).join('');
    return '<div class="gl-glass s-card"><div class="s-card-head"><h3>Bans per staff · ' + esc(c.label) + '</h3></div>'
      + (top.length && max ? '<div class="s-bars">' + bars + '</div>' : '<div class="empty">No bans ' + esc(c.label) + '.</div>')
      + '<div class="s-legend"><span class="s-lg"><i class="s-sw is-normal"></i>Normal</span><span class="s-lg"><i class="s-sw is-flag"></i>Flagged — worth a look</span></div></div>';
  }

  function punishRow(a) {
    var canUndo = a.status === 'Executed' && isBanish(a);
    return '<div class="s-pu">' + P.typePill(a.type)
      + '<span class="s-pu-txt"><b>' + esc(a.target) + '</b> · ' + esc(a.reason || '—') + ' · by ' + esc(a.by_name || 'unknown') + ' · ' + esc(P.serverName(a.server)) + '</span>'
      + '<span class="s-pu-btns">' + (canUndo ? '<button type="button" class="gl-btn gl-btn-ghost gl-btn-sm" data-action="undo" data-id="' + esc(a.id) + '">Undo</button>' : '')
      + '<button type="button" class="gl-btn gl-btn-sm" data-goto="audit/' + esc(a.target) + '">Review</button></span>'
      + '<span class="s-pu-meta">' + (hasProof(a) ? '<span class="s-proof is-ok">proof ✓</span>' : '<span class="s-proof is-bad">no proof</span>') + P.statusPill(a.status, a.error) + '<span class="s-pu-when">' + esc(P.timeAgo(a.created_at)) + '</span></span></div>';
  }
  function renderBig(c) {
    var big = newestFirst(c.rows.filter(function (a) { return P.isPermBan(a) || a.type === 'Unban'; })).slice(0, 8);
    return '<div class="gl-glass s-card"><div class="s-card-head"><h3>Big punishments · ' + esc(c.label) + '</h3><span class="gl-spacer"></span><span class="ghost-link" data-goto="audit">See all →</span></div>'
      + (big.length ? '<div class="s-punish">' + big.map(punishRow).join('') + '</div>' : '<div class="empty">No permanent bans or unbans ' + esc(c.label) + '.</div>') + '</div>';
  }
  function renderChanges(c) {
    var d = c.d;
    var rows = newestFirst(inRange(d.staffAudit, 30)).slice(0, 8);
    var blk = newestFirst(list(d.blocks)).slice(0, 3);
    var changes = rows.length ? '<div class="s-chg">' + rows.map(function (r) {
      return '<div class="s-ch"><i class="s-dot ' + staffDot(r.action) + '"></i><span class="s-ch-txt">' + staffSentence(r) + '</span><span class="s-ch-time">' + esc(P.timeAgo(r.created_at)) + '</span></div>';
    }).join('') + '</div>' : '<div class="empty">No staff changes in 30 days.</div>';
    var blocks = blk.length ? '<div class="s-chg">' + blk.map(function (b) {
      return '<div class="s-ch"><i class="s-dot is-danger"></i><span class="s-ch-txt">' + blockSentence(b) + '</span><span class="s-ch-time">' + esc(P.timeAgo(b.created_at)) + '</span></div>';
    }).join('') + '</div>' : '<div class="empty">No blocked attempts.</div>';
    return '<div class="s-col">'
      + '<div class="gl-glass s-card"><div class="s-card-head"><h3>Staff &amp; role changes</h3><span class="gl-spacer"></span><span class="ghost-link" data-goto="staff">Staff →</span></div>' + changes + '</div>'
      + '<div class="gl-glass s-card s-blocked"><div class="s-card-head"><i class="s-gold-dot"></i><h3>Blocked attempts on protected players</h3></div>' + blocks
      + '<button type="button" class="gl-btn gl-btn-sm s-blocked-btn" data-goto="protection">Open protection</button></div>'
      + '</div>';
  }

  function stackBar(ap, cls) {
    var t = ap.total || 0;
    function seg(n, k, label) { return n ? '<i class="' + k + '" style="width:' + (100 * n / t) + '%" title="' + esc(label + ' ' + n) + '"></i>' : ''; }
    return '<div class="s-appr-bar' + (cls ? ' ' + cls : '') + '">' + (t ? seg(ap.approved, 'is-ok', 'Approved') + seg(ap.denied, 'is-bad', 'Denied') + seg(ap.waiting, 'is-muted', 'Still waiting') : '<i class="is-empty" style="width:100%"></i>') + '</div>';
  }
  function legend(ap) {
    return '<div class="s-legend"><span class="s-lg"><i class="s-sw is-ok"></i>Approved ' + ap.approved + '</span><span class="s-lg"><i class="s-sw is-bad"></i>Denied ' + ap.denied + '</span><span class="s-lg"><i class="s-sw is-muted"></i>Still waiting ' + ap.waiting + '</span></div>';
  }
  function serverRow(c, sv) {
    var d = c.d, hb = heartbeat(d, sv[0]);
    var age = hb.at ? Date.now() - hb.at : Infinity;
    var cls = age < 2 * MIN ? 'is-ok' : age < 5 * MIN ? 'is-warn' : 'is-danger';
    var mine = c.all.filter(function (a) { return a.server === sv[0]; });
    var waiting = mine.filter(function (a) { return a.status === 'Pending'; }).length;
    var failed = mine.filter(function (a) { return a.status === 'Failed'; }).length;
    var ap = approvalSplit(inRange(mine, c.r), c.byId);
    var checked = hb.at ? (hb.fromPresence ? 'Last player update ' : 'Checked in ') + agoLower(new Date(hb.at).toISOString()) : 'Never checked in';
    return '<div class="s-srv"><span class="s-srv-name"><i class="s-live ' + cls + '"></i>' + esc(sv[1]) + '</span>'
      + '<span class="s-srv-num">' + onlineOn(d, sv[0]) + ' <em>players</em></span>'
      + (hb.tps !== null && hb.tps !== undefined ? '<span class="s-srv-num">' + esc(hb.tps) + ' <em>TPS</em></span>' : '<span></span>')
      + '<span class="s-srv-ping ' + cls + '">' + esc(checked) + '</span>'
      + '<span class="s-srv-q">Waiting <b>' + waiting + '</b> · Failed <b' + (failed ? ' class="is-bad"' : '') + '>' + failed + '</b></span>'
      + '<span class="s-srv-bar"><span class="s-srv-bar-lbl">Approvals · ' + esc(c.label) + '</span>' + stackBar(ap, 's-appr-mini') + '<span class="s-srv-bar-nums">' + (ap.total ? ap.approved + ' approved · ' + ap.denied + ' denied · ' + ap.waiting + ' waiting' : 'none') + '</span></span>'
      + '</div>';
  }
  function renderServers(c) {
    var ap = approvalSplit(c.rows, c.byId);
    return '<div class="s-row s-row-two">'
      + '<div class="gl-glass s-card"><div class="s-card-head"><h3>Servers &amp; queue</h3></div><div class="s-srv-list">' + P.cfg.SERVERS.map(function (sv) { return serverRow(c, sv); }).join('') + '</div></div>'
      + '<div class="gl-glass s-card"><div class="s-card-head"><h3>Approvals · ' + esc(c.label) + '</h3><span class="gl-spacer"></span><span class="ghost-link" data-goto="audit">History →</span></div><div class="s-appr">'
      + '<div class="s-appr-total">' + ap.total + ' <em>' + (ap.total === 1 ? 'request' : 'requests') + ' on both servers</em></div>' + stackBar(ap) + legend(ap)
      + (ap.total ? '' : '<p class="s-calm">No approval requests ' + esc(c.label) + '.</p>')
      + '</div></div></div>';
  }

  function feedEvents(c) {
    var d = c.d, ev = [];
    newestFirst(c.all).slice(0, 40).forEach(function (a) {
      ev.push({ t: ts(a.created_at), kind: P.typePill(a.type), server: a.server, status: P.statusPill(a.status, a.error),
        html: '<b>' + esc(a.by_name || 'Someone') + '</b> ' + esc(verb(a.type)) + ' <b>' + esc(a.target) + '</b>' + (a.reason ? ' · ' + esc(a.reason) : '') + (a.duration ? ' · ' + esc(a.duration) : '') });
    });
    list(d.staffAudit).forEach(function (r) { ev.push({ t: ts(r.created_at), kind: '<span class="s-kind is-role">Staff</span>', server: r.server, status: '', html: staffSentence(r) }); });
    list(d.blocks).forEach(function (b) { ev.push({ t: ts(b.created_at), kind: '<span class="s-kind is-punish">Blocked</span>', server: b.server, status: '<span class="status danger">Blocked</span>', html: blockSentence(b) + (b.reason ? ' · ' + esc(b.reason) : '') }); });
    list(d.anns).forEach(function (a) { ev.push({ t: ts(a.created_at), kind: '<span class="s-kind is-note">Announcement</span>', server: a.server || P.state.server, status: '', html: '<b>' + esc(a.by_name || 'Someone') + '</b> posted: ' + esc(short(a.body, 90)) }); });
    list(d.logs).forEach(function (l) { ev.push({ t: ts(l.created_at), kind: '<span class="s-kind is-login">Log</span>', server: l.server || P.state.server, status: l.status ? P.statusPill(l.status) : '', html: '<b>' + esc(l.by_name || 'Someone') + '</b>: ' + esc(short(l.what, 90)) }); });
    return ev.sort(function (a, b) { return b.t - a.t; }).slice(0, 30);
  }
  function renderFeed(c) {
    var ev = feedEvents(c);
    return '<div class="gl-glass s-card s-feed"><div class="s-card-head"><i class="s-live"></i><h3>Everything · live feed</h3><span class="gl-spacer"></span><span class="ghost-link" data-goto="audit">See all history →</span></div>'
      + (ev.length ? '<div class="s-feed-list">' + ev.map(function (e) {
        return '<div class="s-fr"><span class="s-fr-kind">' + e.kind + '</span><span class="s-fr-txt">' + e.html + '</span>' + serverTag(e.server) + '<span class="s-fr-st">' + e.status + '</span><span class="s-fr-time">' + esc(P.timeAgo(e.t ? new Date(e.t).toISOString() : null)) + '</span></div>';
      }).join('') + '</div>' : '<div class="empty">Nothing has happened yet.</div>') + '</div>';
  }

  /* ---------------- screen ---------------- */
  P.registerScreen(KEY, {
    title: 'Dashboard',
    guard: function () { return P.isSupervisor(); },
    render: function (root, s) {
      var c = collect(s);
      root.innerHTML = renderHead(c) + renderCritical(c) + renderStats(c)
        + '<div class="s-row s-row-wide">' + renderOversight(c) + renderBans(c) + '</div>'
        + '<div class="s-row s-row-two s-top">' + renderBig(c) + renderChanges(c) + '</div>'
        + renderServers(c) + renderFeed(c);
    },
    onAction: function (action, el, ev, s) {
      if (action === 'range') { ui().range = Number(el.getAttribute('data-v')) || 7; P.rerender(); return; }
      if (action === 'undo') {
        var id = el.getAttribute('data-id');
        var a = list(s.data.recent30).filter(function (r) { return String(r.id) === id; })[0];
        if (!a) { P.toast('fail', 'That punishment is not loaded any more.'); return; }
        P.openPunish({ type: 'Unban', target: a.target, reason: 'Undo by Supervisor', server: a.server });
      }
    }
  });
})();
