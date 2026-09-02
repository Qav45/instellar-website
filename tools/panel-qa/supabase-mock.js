/* In-memory fake of the subset of supabase-js the panel uses. Load BEFORE panel/js/core.js.
   window.MOCK = { db, session, reset(), as(username) }  — see fixtures.js */
(function () {
  var M = window.MOCK = window.MOCK || {};
  M.db = M.db || {};
  M.session = null;          // { user:{id} }
  M.channels = [];
  M.log = [];

  var seq = 100000;
  function now() { return new Date().toISOString(); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function me() { if (!M.session) return null; return (M.db.staff || []).filter(function (s) { return s.id === M.session.user.id; })[0] || null; }
  var RANK = { Trainee: 1, Helper: 2, 'Jr Moderator': 3, Moderator: 4, 'Sr Moderator': 5, 'Jr Admin': 6, Admin: 7, 'Sr Admin': 8, Management: 9, Owner: 10, Supervisor: 11 };
  function durationDays(d) { if (!d) return Infinity; var m = String(d).trim().toLowerCase().match(/^(\d+)\s*(second|minute|hour|day|week|month|year)s?$/); if (!m) return Infinity; return Number(m[1]) * ({ second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2]]); }
  function requiredRank(type, dur) { if (type === 'Unban' || type === 'Wipeban') return 7; if (type === 'Ban' && durationDays(dur) > 30) return 7; if (type === 'Ban') return 4; return 2; }
  function protectedRow(name, type) {
    return (M.db.protected_players || []).filter(function (p) { return p.name_lc === String(name).trim().toLowerCase() && (!p.expires_at || new Date(p.expires_at) > new Date()) && (p.blocks || []).indexOf(type) > -1; })[0] || null;
  }

  // ---- triggers ----
  function beforeInsert(table, row) {
    var u = me();
    if (table === 'mod_actions') {
      row.id = ++seq; row.created_at = row.created_at || now();
      if (!u) throw new Error('new row violates row-level security policy for table "mod_actions"');
      row.by_id = u.id; row.by_name = u.display_name;
      var need = requiredRank(row.type, row.duration);
      var want = RANK[u.role] >= need ? 'Pending' : 'Approval';
      if (row.status !== want) throw new Error('new row violates row-level security policy for table "mod_actions"');
      if (row.type === 'Wipeban') row.duration = 'Permanent';
      var pp = protectedRow(row.target, row.type);
      if (pp) {
        M.db.protection_blocks.push({ id: ++seq, target: row.target, type: row.type, reason: row.reason, by_id: u.id, by_name: u.display_name, server: row.server, created_at: now() });
        row.status = 'Denied'; row.error = 'PROTECTED: ' + row.target + ' is protected' + (pp.reason ? ' (' + pp.reason + ')' : '') + ' - ask a Supervisor.';
      }
      row.proof = row.proof || null; row.error = row.error || null;
    } else if (table === 'protected_players') {
      if (!u || u.role !== 'Supervisor') throw new Error('new row violates row-level security policy for table "protected_players"');
      row.id = ++seq; row.created_at = now(); row.name_lc = String(row.name).trim().toLowerCase();
      if ((M.db.protected_players || []).some(function (p) { return p.name_lc === row.name_lc; })) throw new Error('duplicate key value violates unique constraint "protected_players_name_lc"');
      row.added_by = u.id; row.added_by_name = u.display_name;
    } else if (table === 'staff') {
      row.created_at = row.created_at || now(); row.perms = row.perms || [];
      M.db.staff_audit.push({ id: ++seq, staff_id: row.id, username: row.username, display_name: row.display_name, action: 'invited', old_role: null, new_role: row.role, old_perms: null, new_perms: row.perms, server: row.server, by_id: u && u.id, by_name: u ? u.display_name : 'Supabase SQL', created_at: now() });
    } else {
      row.id = row.id || ++seq; row.created_at = row.created_at || now();
      if (u && 'by_id' in row) { row.by_id = u.id; row.by_name = u.display_name; }
    }
    return row;
  }
  function afterUpdate(table, before, after) {
    var u = me();
    if (table === 'staff' && (before.role !== after.role || JSON.stringify(before.perms) !== JSON.stringify(after.perms))) {
      M.db.staff_audit.push({ id: ++seq, staff_id: after.id, username: after.username, display_name: after.display_name, action: before.role !== after.role ? 'role_changed' : 'perms_changed', old_role: before.role, new_role: after.role, old_perms: before.perms, new_perms: after.perms, server: after.server, by_id: u && u.id, by_name: u ? u.display_name : 'Supabase SQL', created_at: now() });
    }
    if (table === 'mod_actions' && after.status === 'Pending' && before.status !== 'Pending') {
      var pp = protectedRow(after.target, after.type);
      if (pp) { after.status = 'Denied'; after.error = 'PROTECTED: ' + after.target + ' is protected - ask a Supervisor.'; }
    }
  }

  // ---- query builder ----
  function Query(table) {
    this.table = table; this.filters = []; this.orders = []; this.lim = null; this.mode = 'select'; this.payload = null; this.sing = 0; this.returning = false;
  }
  var proto = Query.prototype;
  proto.select = function () { if (this.mode === 'select') this.mode = 'select'; else this.returning = true; return this; };
  proto.eq = function (k, v) { this.filters.push(function (r) { return r[k] === v; }); return this; };
  proto.neq = function (k, v) { this.filters.push(function (r) { return r[k] !== v; }); return this; };
  proto.in = function (k, vs) { this.filters.push(function (r) { return vs.indexOf(r[k]) > -1; }); return this; };
  proto.gte = function (k, v) { this.filters.push(function (r) { return r[k] >= v; }); return this; };
  proto.lte = function (k, v) { this.filters.push(function (r) { return r[k] <= v; }); return this; };
  proto.ilike = function (k, v) { var re = new RegExp('^' + v.replace(/%/g, '.*') + '$', 'i'); this.filters.push(function (r) { return re.test(String(r[k])); }); return this; };
  proto.order = function (k, o) { this.orders.push([k, !o || o.ascending !== false]); return this; };
  proto.limit = function (n) { this.lim = n; return this; };
  proto.range = function (a, b) { this.from_ = a; this.lim = b - a + 1; return this; };
  proto.single = function () { this.sing = 1; return this; };
  proto.maybeSingle = function () { this.sing = 2; return this; };
  proto.insert = function (rows) { this.mode = 'insert'; this.payload = rows; return this; };
  proto.update = function (patch) { this.mode = 'update'; this.payload = patch; return this; };
  proto.delete = function () { this.mode = 'delete'; return this; };
  proto.exec = function () {
    var self = this;
    var tbl = M.db[self.table];
    if (!tbl && self.table === 'punishments_staff' && M.db.punishments) {
      tbl = M.db.punishments.map(function (p) {
        var c = clone(p);
        c.in_force = !!(c.active && (!c.expires_at || new Date(c.expires_at) > new Date()));
        return c;
      });
    }
    if (!tbl) return { data: null, error: { message: 'relation "public.' + self.table + '" does not exist', code: '42P01' } };
    M.log.push(self.mode + ' ' + self.table);
    var res;
    try {
      if (self.mode === 'select') {
        res = tbl.filter(function (r) { return self.filters.every(function (f) { return f(r); }); });
        self.orders.forEach(function (o) { res.sort(function (a, b) { var x = a[o[0]], y = b[o[0]]; return (x < y ? -1 : x > y ? 1 : 0) * (o[1] ? 1 : -1); }); });
        if (self.from_) res = res.slice(self.from_);
        if (self.lim) res = res.slice(0, self.lim);
        res = clone(res);
      } else if (self.mode === 'insert') {
        var rows = Array.isArray(self.payload) ? self.payload : [self.payload];
        res = rows.map(function (r) { var c = beforeInsert(self.table, clone(r)); tbl.push(c); return clone(c); });
      } else if (self.mode === 'update') {
        res = [];
        tbl.forEach(function (r) { if (self.filters.every(function (f) { return f(r); })) { var before = clone(r); Object.keys(self.payload).forEach(function (k) { r[k] = clone(self.payload[k]); }); afterUpdate(self.table, before, r); res.push(clone(r)); } });
      } else if (self.mode === 'delete') {
        res = [];
        for (var i = tbl.length - 1; i >= 0; i--) if (self.filters.every(function (f) { return f(tbl[i]); })) { res.push(tbl[i]); tbl.splice(i, 1); }
      }
    } catch (e) { return { data: null, error: { message: e.message } }; }
    if (self.sing === 1) { if (res.length !== 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }; return { data: res[0], error: null }; }
    if (self.sing === 2) return { data: res[0] || null, error: null };
    if (self.mode !== 'select' && !self.returning) return { data: null, error: null };
    return { data: res, error: null };
  };
  proto.then = function (ok, bad) { var self = this; return new Promise(function (r) { setTimeout(function () { r(self.exec()); }, 5); }).then(ok, bad); };
  proto.catch = function (bad) { return this.then(null, bad); };

  var subs = [];
  function client() {
    return {
      from: function (t) { return new Query(t); },
      rpc: function (name, args) {
        return new Promise(function (resolve) {
          setTimeout(function () {
            M.log.push('rpc ' + name);
            var u = me();
            var a = args || {};
            function find(id) { return M.db.mod_actions.filter(function (r) { return r.id === id; })[0]; }
            try {
              if (name === 'approve_action' || name === 'deny_action') {
                var r = find(a.action_id); if (!r) throw new Error('Action not found');
                if (r.status !== 'Approval') throw new Error('This action is not awaiting approval');
                if (RANK[u.role] < requiredRank(r.type, r.duration)) throw new Error('Your role cannot ' + (name === 'approve_action' ? 'approve' : 'deny') + ' this action');
                if (name === 'approve_action' && protectedRow(r.target, r.type)) throw new Error('PROTECTED: ' + r.target + ' is protected - ask a Supervisor.');
                var b = clone(r); r.status = name === 'approve_action' ? 'Pending' : 'Denied'; afterUpdate('mod_actions', b, r);
              } else if (name === 'retry_action') {
                var r2 = find(a.action_id); if (r2 && r2.status === 'Failed') { r2.status = 'Pending'; r2.error = null; }
              } else if (name === 'revoke_staff') {
                var idx = M.db.staff.findIndex(function (s) { return s.id === a.target_id; });
                if (idx < 0) throw new Error('Not a staff member');
                var tgt = M.db.staff[idx];
                if (tgt.role === 'Supervisor') throw new Error('The Supervisor can only be removed via SQL');
                if (RANK[u.role] <= RANK[tgt.role] && u.role !== 'Supervisor') throw new Error('You can only revoke staff below your own rank');
                M.db.staff.splice(idx, 1);
                M.db.staff_audit.push({ id: ++seq, staff_id: tgt.id, username: tgt.username, display_name: tgt.display_name, action: 'removed', old_role: tgt.role, new_role: null, old_perms: tgt.perms, new_perms: null, server: tgt.server, by_id: u.id, by_name: u.display_name, created_at: now() });
              } else if (name === 'ping_staff') {
                if (u) u.last_seen_at = now();
              } else if (name === 'protection_blocks_type') {
                resolve({ data: !!protectedRow(a.p_name, a.p_type), error: null }); return;
              } else throw new Error('function ' + name + ' does not exist');
              resolve({ data: null, error: null });
            } catch (e) { resolve({ data: null, error: { message: e.message } }); }
          }, 5);
        });
      },
      auth: {
        getSession: function () { return Promise.resolve({ data: { session: M.session ? { user: M.session.user } : null }, error: null }); },
        signInWithPassword: function (o) {
          var handle = String(o.email).replace('@staff.instellar', '');
          var st = M.db.staff.filter(function (s) { return s.username === handle; })[0];
          if (!st || o.password !== 'test') return Promise.resolve({ data: { user: null }, error: { message: 'Invalid login credentials' } });
          M.session = { user: { id: st.id } };
          return Promise.resolve({ data: { user: { id: st.id } }, error: null });
        },
        signOut: function () { M.session = null; return Promise.resolve({ error: null }); },
        signUp: function (o) {
          var handle = String(o.email).replace('@staff.instellar', '');
          if (M.db.staff.some(function (s) { return s.username === handle; })) return Promise.resolve({ data: { user: { id: 'u-dup-' + handle } }, error: null });
          return Promise.resolve({ data: { user: { id: 'u-' + handle } }, error: null });
        }
      },
      channel: function (name) {
        var ch = { name: name, handlers: [], on: function (kind, opts, fn) { ch.handlers.push({ kind: kind, opts: opts, fn: fn }); return ch; }, subscribe: function () { subs.push(ch); return ch; }, send: function (msg) { subs.forEach(function (c) { c.handlers.forEach(function (h) { if (h.kind === 'broadcast' && h.opts.event === msg.event) h.fn({ payload: msg.payload }); }); }); return Promise.resolve('ok'); } };
        M.channels.push(ch);
        return ch;
      },
      removeChannel: function (ch) { subs = subs.filter(function (c) { return c !== ch; }); return Promise.resolve('ok'); },
      storage: {
        from: function (bucket) {
          return {
            upload: function (path, file) { M.log.push('upload ' + bucket + '/' + path); return Promise.resolve({ data: { path: path }, error: null }); },
            getPublicUrl: function (path) { return { data: { publicUrl: 'https://mock.local/storage/v1/object/public/' + bucket + '/' + path } }; }
          };
        }
      }
    };
  }
  window.supabase = { createClient: function () { return client(); } };
  M.as = function (username) { var st = M.db.staff.filter(function (s) { return s.username === username; })[0]; M.session = st ? { user: { id: st.id } } : null; return !!st; };
  // fire a fake postgres change to every subscriber for a table
  M.emit = function (table) { subs.forEach(function (c) { c.handlers.forEach(function (h) { if (h.kind === 'postgres_changes' && h.opts.table === table) h.fn({}); }); }); };
})();
