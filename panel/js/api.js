/* =========================================================================
   Instellar moderation panel — Supabase api layer
   Mirrors the old panel's calls 1:1 (tables, RPCs, statuses). Every loader
   writes P.state.data and calls P.rerender().
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P;
  var S = P.state;
  var api = P.api = {};
  var _sb = null, _live = null, _poll = null, _lastPing = 0;

  api.sb = function () {
    if (!_sb) _sb = window.supabase.createClient(P.cfg.SB_URL, P.cfg.SB_KEY);
    return _sb;
  };
  function srvChanged(srv) { return srv !== S.server; }
  function tableMissing(err) { return !!err && /relation .* does not exist|schema cache|not find the table|does not exist/i.test(String(err.message || err)); }

  /* ---------------- auth ---------------- */
  api.resume = function () {
    var tries = 0;
    (function boot() {
      if (!window.supabase) { if (tries++ < 40) setTimeout(boot, 300); else { S.booting = false; P.render(); } return; }
      api.sb().auth.getSession().then(function (r) {
        var sess = r && r.data && r.data.session;
        if (sess) api.finishLogin(sess.user.id); else { S.booting = false; P.render(); }
      }).catch(function (e) { console.error(e); S.booting = false; P.render(); });
    })();
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') api.checkAccess(); });
  };
  // returns null on success, otherwise the error string to show
  api.login = function (user, pw) {
    var u = String(user || '').trim().toLowerCase();
    if (!u || !pw) return Promise.resolve('Enter your username and password.');
    if (!window.supabase) return Promise.resolve('Still connecting — try again in a second.');
    return api.sb().auth.signInWithPassword({ email: u + '@staff.instellar', password: pw }).then(function (r) {
      if (r.error || !r.data || !r.data.user) return 'Incorrect username or password.';
      return api.finishLogin(r.data.user.id).then(function (ok) { return ok ? null : (S.loginError || 'This account has no staff access.'); });
    }).catch(function () { return 'Could not reach the server. Try again.'; });
  };
  api.finishLogin = function (uid) {
    return api.sb().from('staff').select('*').eq('id', uid).single().then(function (r) {
      if (r.error || !r.data) {
        return api.sb().auth.signOut().then(function () {
          S.loginError = 'This account has no staff access.'; S.authed = false; S.me = null; S.booting = false; P.render(); return false;
        });
      }
      S.me = r.data; S.authed = true; S.loginError = ''; S.booting = false;
      var h = P.parseHash();
      P.route(h.key, h.param);
      api.loadAll();
      api.startLive();
      api.pingStaff();
      return true;
    });
  };
  api.logout = function () {
    api.stopLive();
    try { api.sb().auth.signOut(); } catch (e) {}
    clearData();
    S.authed = false; S.me = null; S.loginError = ''; S.ui = {};
    P.closeModal();
    P.render();
  };
  api.forceLogout = function (msg) {
    api.stopLive();
    try { api.sb().auth.signOut({ scope: 'local' }); } catch (e) {}
    clearData();
    S.authed = false; S.me = null; S.loginError = msg || ''; S.ui = {};
    P.closeModal();
    P.render();
  };
  function clearData() {
    var d = S.data;
    ['actions', 'staff', 'notes', 'presence', 'logs', 'guides', 'anns', 'blacklist', 'templates', 'recent30', 'presenceAll', 'staffAll', 'protected', 'blocks', 'staffAudit', 'serverStatus'].forEach(function (k) { d[k] = []; });
    d.protectionError = null; d.auditError = null;
  }
  // Still on the staff list? Role/perm/name changes apply live.
  api.checkAccess = function () {
    var me = S.me;
    if (!S.authed || !me) return Promise.resolve();
    return api.sb().from('staff').select('*').eq('id', me.id).maybeSingle().then(function (r) {
      if (r.error || !S.authed || !S.me || S.me.id !== me.id) return;
      if (!r.data) { api.forceLogout('Your staff access has been revoked.'); return; }
      if (JSON.stringify(r.data) !== JSON.stringify(S.me)) { S.me = r.data; P.render(); }
    });
  };

  /* ---------------- live ---------------- */
  api.startLive = function () {
    if (_live) return;
    var sb = api.sb();
    _live = sb.channel('panel-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mod_actions' }, function () { api.loadData(); api.loadRecent30(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff' }, function () { api.loadData(); api.loadStaffAll(); api.checkAccess(); })
      .on('broadcast', { event: 'revoked' }, function (msg) {
        var payload = msg && msg.payload;
        if (S.me && payload && payload.uid === S.me.id) api.forceLogout('Your staff access has been revoked.');
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'player_notes' }, function () { api.loadData(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_logs' }, function () { api.loadLogs(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'guides' }, function () { api.loadGuides(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'announcements' }, function () { api.loadAnns(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'punishment_blacklist' }, function () { api.loadBlacklist(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'punish_templates' }, function () { api.loadTemplates(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'protected_players' }, function () { api.loadProtection(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'protection_blocks' }, function () { api.loadProtection(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_audit' }, function () { api.loadStaffAudit(); })
      .subscribe();
    _poll = setInterval(function () {
      if (!S.authed) return;
      api.loadData(); api.checkAccess();
      if (['dashboard', 'supdash', 'protection', 'players', 'infractions'].indexOf(S.screen) > -1) api.loadDash();
      if (Date.now() - _lastPing > 10 * 60000) api.pingStaff();
    }, P.cfg.POLL_MS);
  };
  api.stopLive = function () {
    if (_poll) { clearInterval(_poll); _poll = null; }
    if (_live) { try { api.sb().removeChannel(_live); } catch (e) {} _live = null; }
  };
  api.broadcastRevoked = function (uid) {
    if (_live) { try { _live.send({ type: 'broadcast', event: 'revoked', payload: { uid: uid } }); } catch (e) {} }
  };

  /* ---------------- server switch ---------------- */
  api.setServer = function (id) {
    if (id === S.server) return;
    try { localStorage.setItem('instellar_server', id); } catch (e) {}
    S.server = id;
    var d = S.data;
    ['actions', 'staff', 'notes', 'presence', 'logs', 'guides', 'anns', 'templates'].forEach(function (k) { d[k] = []; });
    S.ui = {};
    P.closeModal();
    P.render();
    api.loadAll();
    P.toast('ok', 'Switched to ' + P.serverName(id) + '.');
  };

  /* ---------------- loaders ---------------- */
  api.loadAll = function () {
    api.loadData(); api.loadLogs(); api.loadGuides(); api.loadAnns(); api.loadBlacklist(); api.loadTemplates(); api.loadDash();
  };
  api.loadDash = function () {
    api.loadRecent30(); api.loadPresenceAll(); api.loadStaffAll(); api.loadProtection(); api.loadStaffAudit(); api.loadServerStatus();
  };
  api.loadData = function () {
    var sb = api.sb(), srv = S.server;
    return Promise.all([
      sb.from('mod_actions').select('*').eq('server', srv).order('created_at', { ascending: false }).limit(300),
      sb.from('staff').select('*').eq('server', srv).order('created_at', { ascending: true }),
      sb.from('player_notes').select('*').eq('server', srv).order('created_at', { ascending: true }).limit(1000),
      sb.from('player_presence').select('*').eq('server', srv).order('last_seen', { ascending: false }).limit(2000)
    ]).then(function (r) {
      var a = r[0], st = r[1], n = r[2], pr = r[3];
      if (a.error || st.error) { S.data.auditError = (a.error || st.error).message; P.toast('fail', 'Could not load data: ' + (a.error || st.error).message); return; }
      if (srvChanged(srv) || !S.authed) return;
      S.data.auditError = null;
      S.data.actions = a.data || [];
      S.data.staff = st.data || [];
      if (!n.error) S.data.notes = n.data || [];
      if (pr && !pr.error) S.data.presence = pr.data || [];
      P.rerender();
    });
  };
  api.loadLogs = function () {
    var srv = S.server;
    return api.sb().from('staff_logs').select('*').eq('server', srv).order('created_at', { ascending: false }).limit(200).then(function (r) {
      if (r.error || !r.data || srvChanged(srv)) return;
      S.data.logs = r.data; P.rerender();
    });
  };
  api.loadGuides = function () {
    var srv = S.server;
    return api.sb().from('guides').select('*').eq('server', srv).order('created_at', { ascending: false }).limit(100).then(function (r) {
      if (r.error || !r.data || srvChanged(srv)) return;
      S.data.guides = r.data; P.rerender();
    });
  };
  api.loadAnns = function () {
    var srv = S.server;
    return api.sb().from('announcements').select('*').eq('server', srv).order('created_at', { ascending: false }).limit(20).then(function (r) {
      if (r.error || !r.data || srvChanged(srv)) return;
      S.data.anns = r.data; P.rerender();
    });
  };
  api.loadBlacklist = function () {
    if (!P.canServerConfig()) return Promise.resolve();
    return api.sb().from('punishment_blacklist').select('*').order('created_at', { ascending: false }).limit(1000).then(function (r) {
      if (r.error || !r.data) return;
      S.data.blacklist = r.data; P.rerender();
    });
  };
  api.loadTemplates = function () {
    var srv = S.server;
    return api.sb().from('punish_templates').select('*').eq('server', srv).order('created_at', { ascending: true }).limit(200).then(function (r) {
      if (r.error || !r.data || srvChanged(srv)) return;
      S.data.templates = r.data.map(function (t) { return { key: 'c-' + t.id, id: t.id, name: t.name, type: t.type, steps: t.steps || [], note: t.note || '', by: t.by_name, byId: t.by_id }; });
      P.rerender();
    });
  };
  // both servers, last 30 days — dashboards
  // PostgREST caps a request at 1000 rows, so page until a short page comes back (max 5 pages).
  api.loadRecent30 = function () {
    var since = new Date(Date.now() - 30 * 86400000).toISOString();
    var PAGE = 1000, rows = [], page = 0;
    function next() {
      return api.sb().from('mod_actions').select('id,server,type,target,reason,duration,by_id,by_name,status,error,proof,created_at')
        .gte('created_at', since).order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1).then(function (r) {
          if (r.error || !r.data) return rows.length ? rows : null;
          rows = rows.concat(r.data);
          page++;
          if (r.data.length < PAGE || page >= 5) return rows;
          return next();
        });
    }
    return next().then(function (all) {
      if (!all) return;
      S.data.recent30 = all; P.rerender();
    });
  };
  api.loadPresenceAll = function () {
    return api.sb().from('player_presence').select('*').order('last_seen', { ascending: false }).limit(4000).then(function (r) {
      if (r.error || !r.data) return;
      S.data.presenceAll = r.data; P.rerender();
    });
  };
  api.loadStaffAll = function () {
    return api.sb().from('staff').select('*').order('created_at', { ascending: true }).then(function (r) {
      if (r.error || !r.data) return;
      S.data.staffAll = r.data; P.rerender();
    });
  };
  api.loadProtection = function () {
    var sb = api.sb();
    return Promise.all([
      sb.from('protected_players').select('*').order('created_at', { ascending: false }).limit(1000),
      sb.from('protection_blocks').select('*').order('created_at', { ascending: false }).limit(500)
    ]).then(function (r) {
      if (r[0].error) { S.data.protectionError = tableMissing(r[0].error) ? 'missing' : r[0].error.message; P.rerender(); return; }
      S.data.protectionError = null;
      S.data.protected = r[0].data || [];
      if (!r[1].error) S.data.blocks = r[1].data || [];
      P.rerender();
    });
  };
  api.loadStaffAudit = function () {
    var since = new Date(Date.now() - 30 * 86400000).toISOString();
    return api.sb().from('staff_audit').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(500).then(function (r) {
      if (r.error || !r.data) return;
      S.data.staffAudit = r.data; P.rerender();
    });
  };
  api.loadServerStatus = function () {
    return api.sb().from('server_status').select('*').then(function (r) {
      if (r.error || !r.data) return;
      S.data.serverStatus = r.data; P.rerender();
    });
  };
  api.pingStaff = function () {
    _lastPing = Date.now();
    try { api.sb().rpc('ping_staff').then(function () {}); } catch (e) {}
  };

  /* ---------------- punishments ---------------- */
  // row = {type,target,reason,duration|null,proof|null}; returns {error} or {row}
  api.submitAction = function (row) {
    var full = {
      server: S.server, type: row.type, target: row.target, reason: row.reason, duration: row.duration || null,
      by_id: S.me.id, by_name: S.me.display_name,
      status: P.needsApproval(row.type, row.duration || undefined) ? 'Approval' : 'Pending',
      proof: row.proof && row.proof.length ? row.proof : null
    };
    return api.sb().from('mod_actions').insert(full).select('id,status,error').single().then(function (r) {
      if (r.error) return { error: r.error.message };
      api.loadData(); api.loadRecent30();
      var d = r.data || {};
      if (d.status === 'Denied' && P.isProtectedError(d.error)) return { error: d.error, protectedBlock: true };
      return { row: d, approval: full.status === 'Approval' };
    });
  };
  // The types the 'proof' bucket accepts (keep in step with proof-setup.sql).
  var EXT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4'
  };
  // Phones and screenshot tools sometimes hand over a file with no type at all,
  // and Storage rejects those, so fall back to the extension.
  P.proofType = function (f) {
    if (f && f.type && f.type !== 'application/octet-stream') return f.type;
    var e = ((String(f && f.name || '').match(/\.(\w+)$/) || [])[1] || '').toLowerCase();
    return EXT_MIME[e] || '';
  };
  // Say what actually went wrong: the reason is nearly always the bucket, not the file.
  function uploadError(msg, f) {
    var m = String(msg || '');
    if (/mime type|content type/i.test(m)) return 'The proof bucket does not accept ' + (P.proofType(f) || 'that file type') + '. Re-run supabase/proof-setup.sql, or attach a PNG or JPG.';
    if (/bucket not found/i.test(m)) return 'The proof bucket is missing. Run supabase/proof-setup.sql in Supabase.';
    if (/row-level security|violates|unauthorized|not authorized|jwt/i.test(m)) return 'Storage would not accept the upload from your account. Re-run supabase/proof-setup.sql, then sign out and back in.';
    if (/maximum allowed size|payload too large|entity too large/i.test(m)) return f.name + ' is too big for the proof bucket (50 MB).';
    return m;
  }
  // Uploads proof files to the public 'proof' bucket. Returns { urls } or { error }.
  api.uploadProof = function (files) {
    var urls = [], i = 0;
    function next() {
      if (i >= files.length) return Promise.resolve({ urls: urls });
      var f = files[i++];
      var rand = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(8)), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      var safe = f.name.replace(/[^\w.\-]+/g, '_').slice(-80);
      var path = S.server + '/' + Date.now() + '-' + rand + '-' + safe;
      return api.sb().storage.from('proof').upload(path, f, { contentType: P.proofType(f) || undefined, upsert: false }).then(function (r) {
        if (r.error) return { error: uploadError(r.error.message, f) };
        urls.push(api.sb().storage.from('proof').getPublicUrl(path).data.publicUrl);
        return next();
      });
    }
    return next();
  };
  function numId(id) { return /^\d+$/.test(String(id)) ? Number(id) : id; }
  api.approve = function (id) {
    return api.sb().rpc('approve_action', { action_id: numId(id) }).then(function (r) {
      if (r.error) { P.toast('fail', r.error.message); return false; }
      P.toast('ok', 'Approved — queued for the server.'); api.loadData(); api.loadRecent30(); return true;
    });
  };
  api.deny = function (id) {
    return api.sb().rpc('deny_action', { action_id: numId(id) }).then(function (r) {
      if (r.error) { P.toast('fail', r.error.message); return false; }
      P.toast('ok', 'Denied — it will not run.'); api.loadData(); api.loadRecent30(); return true;
    });
  };
  api.retry = function (id) {
    return api.sb().rpc('retry_action', { action_id: numId(id) }).then(function (r) {
      if (r.error) { P.toast('fail', r.error.message); return false; }
      P.toast('info', 'Retrying action…'); api.loadData(); return true;
    });
  };

  /* ---------------- notes / logs / guides / announcements ---------------- */
  api.addNote = function (target, text) {
    return api.sb().from('player_notes').insert({ server: S.server, target: target, text: text, by_id: S.me.id, by_name: P.myName() }).then(function (r) {
      if (r.error) { P.toast('fail', 'Could not save the note: ' + r.error.message); return false; }
      P.toast('ok', 'Note saved — visible to all staff.'); api.loadData(); return true;
    });
  };
  api.submitLog = function (what, why, after) {
    return api.sb().from('staff_logs').insert({ server: S.server, what: what, why: why, after: after, by_name: P.myName(), by_id: S.me.id, status: 'Pending' }).then(function (r) {
      if (r.error) { P.toast('fail', 'Could not save the log: ' + r.error.message); return false; }
      P.toast('ok', 'Logged — awaiting approval.'); api.loadLogs(); return true;
    });
  };
  api.approveLog = function (id) {
    return api.sb().from('staff_logs').update({ status: 'Approved' }).eq('id', numId(id)).then(function (r) {
      if (r.error) { P.toast('fail', r.error.message); return false; }
      P.toast('ok', 'Log approved.'); api.loadLogs(); return true;
    });
  };
  api.addGuide = function (title, body) {
    return api.sb().from('guides').insert({ server: S.server, title: title, body: body, by_name: P.myName(), by_id: S.me.id }).then(function (r) {
      if (r.error) { P.toast('fail', 'Could not publish: ' + r.error.message); return false; }
      P.toast('ok', 'Guide published.'); api.loadGuides(); return true;
    });
  };
  api.removeGuide = function (id) {
    return api.sb().from('guides').delete().eq('id', numId(id)).then(function (r) {
      if (r.error) { P.toast('fail', r.error.message); return false; }
      api.loadGuides(); return true;
    });
  };
  api.postAnn = function (text) {
    return api.sb().from('announcements').insert({ server: S.server, body: text, by_name: P.myName(), by_id: S.me.id }).then(function (r) {
      if (r.error) { P.toast('fail', 'Could not post: ' + r.error.message); return false; }
      P.toast('ok', 'Announcement posted.'); api.loadAnns(); return true;
    });
  };
  api.removeAnn = function (id) {
    return api.sb().from('announcements').delete().eq('id', numId(id)).then(function (r) {
      if (r.error) { P.toast('fail', r.error.message); return false; }
      api.loadAnns(); return true;
    });
  };

  /* ---------------- blacklist / templates ---------------- */
  api.addBlacklist = function (name) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) { P.toast('fail', 'That is not a valid Minecraft username.'); return Promise.resolve(false); }
    if ((S.data.blacklist || []).some(function (b) { return String(b.name).toLowerCase() === name.toLowerCase(); })) { P.toast('fail', name + ' is already hidden.'); return Promise.resolve(false); }
    return api.sb().from('punishment_blacklist').insert({ name: name, by_id: S.me.id, by_name: P.myName() }).then(function (r) {
      if (r.error) { P.toast('fail', 'Could not add: ' + r.error.message); return false; }
      P.toast('ok', name + ' can no longer be looked up on instellar.net/punishment.'); api.loadBlacklist(); return true;
    });
  };
  api.removeBlacklist = function (b) {
    return api.sb().from('punishment_blacklist').delete().eq('id', numId(b.id)).then(function (r) {
      if (r.error) { P.toast('fail', r.error.message); return false; }
      P.toast('ok', b.name + ' can be looked up again.'); api.loadBlacklist(); return true;
    });
  };
  api.addTemplate = function (name, type, steps, note) {
    return api.sb().from('punish_templates').insert({ server: S.server, name: name, type: type, steps: steps, note: note || null, by_name: P.myName(), by_id: S.me.id }).then(function (r) {
      if (r.error) { P.toast('fail', 'Could not save the template: ' + r.error.message); return false; }
      P.toast('ok', 'Template "' + name + '" added.'); api.loadTemplates(); return true;
    });
  };
  api.removeTemplate = function (id) {
    return api.sb().from('punish_templates').delete().eq('id', numId(id)).then(function (r) {
      if (r.error) { P.toast('fail', r.error.message); return false; }
      api.loadTemplates(); return true;
    });
  };

  /* ---------------- staff ---------------- */
  // Creates the login with a throw-away client so our own session is untouched.
  api.invite = function (o) {
    var handle = String(o.handle || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
    var name = String(o.name || '').trim();
    if (!name || !handle) { P.toast('fail', 'Name and username are required.'); return Promise.resolve(false); }
    if (String(o.pw || '').length < 8) { P.toast('fail', 'Password must be at least 8 characters.'); return Promise.resolve(false); }
    if (o.pw !== o.pw2) { P.toast('fail', 'Passwords do not match.'); return Promise.resolve(false); }
    var tmp = window.supabase.createClient(P.cfg.SB_URL, P.cfg.SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    return tmp.auth.signUp({ email: handle + '@staff.instellar', password: o.pw }).then(function (r) {
      if (r.error || !r.data || !r.data.user) { P.toast('fail', 'Could not create the login: ' + (r.error ? r.error.message : 'unknown error')); return false; }
      return api.sb().from('staff').insert({ id: r.data.user.id, server: S.server, username: handle, display_name: name, role: o.role, perms: P.ROLE_DEFAULT_PERMS[o.role] || [] }).then(function (r2) {
        if (r2.error) { P.toast('fail', 'Login created, but granting staff access failed: ' + r2.error.message); return false; }
        P.toast('ok', name + ' added as ' + o.role + ' — they sign in with username "' + handle + '".');
        api.loadData(); api.loadStaffAll(); return true;
      });
    });
  };
  api.saveStaff = function (handle, role, perms) {
    return api.sb().from('staff').update({ role: role, perms: role === 'Owner' ? ['All permissions'] : perms.slice() }).eq('username', handle).then(function (r) {
      if (r.error) { P.toast('fail', 'Could not update: ' + r.error.message); return false; }
      api.loadData(); api.loadStaffAll(); return true;
    });
  };
  api.revokeStaff = function (id) {
    return api.sb().rpc('revoke_staff', { target_id: id }).then(function (r) {
      if (r.error) { P.toast('fail', 'Could not revoke: ' + r.error.message); return false; }
      api.broadcastRevoked(id);
      api.loadData(); api.loadStaffAll(); return true;
    });
  };

  /* ---------------- protection (Supervisor) ---------------- */
  api.protect = function (o) {
    return api.sb().from('protected_players').insert({ name: o.name, reason: o.reason || '', blocks: o.blocks, expires_at: o.expires_at || null, added_by: S.me.id, added_by_name: P.myName() }).then(function (r) {
      if (r.error) {
        var m = r.error.message || '';
        P.toast('fail', /duplicate|unique/i.test(m) ? o.name + ' is already protected.' : tableMissing(r.error) ? 'Protection is not set up yet — run supabase/protection-setup.sql.' : 'Could not protect: ' + m);
        return false;
      }
      P.toast('ok', o.name + ' is now protected.'); api.loadProtection(); return true;
    });
  };
  api.unprotect = function (id) {
    return api.sb().from('protected_players').delete().eq('id', numId(id)).then(function (r) {
      if (r.error) { P.toast('fail', r.error.message); return false; }
      api.loadProtection(); return true;
    });
  };
})();
