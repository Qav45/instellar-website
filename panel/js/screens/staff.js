/* =========================================================================
   Screens: 'staff' (list + invite + manage/revoke) and 'blacklist' (Hidden names)
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P;
  var esc = P.esc;

  var PERM_LABEL = {
    Warn: 'Warn players', Mute: 'Mute players', Kick: 'Kick players', Ban: 'Ban players', Unban: 'Unban players',
    Wipeban: 'Wipeban players', Guides: 'Edit guides', 'Staff management': 'Add and remove staff', 'Server config': 'Change server settings'
  };

  function myRank() { return P.rank(P.currentRole()); }
  // Manage is offered only to ownership, never on Supervisor rows, and only below your own rank unless you are Supervisor.
  function canManage(row) {
    if (!P.isOwnership() || row.role === 'Supervisor') return false;
    return P.isSupervisor() || P.rank(row.role) < myRank();
  }
  function canRevoke(row) {
    var me = P.state.me;
    return !!me && row.id !== me.id && (row.role !== 'Owner' || P.isSupervisor());
  }
  function expandPerms(perms) {
    perms = Array.isArray(perms) ? perms : [];
    return perms.indexOf('All permissions') > -1 ? P.PERMS.slice() : perms.slice();
  }
  function hasLastSeen() {
    var d = P.state.data;
    return (d.staffAll || []).concat(d.staff || []).some(function (r) { return r && r.last_seen_at !== undefined; });
  }
  function sortedStaff() {
    return (P.state.data.staff || []).slice().sort(function (a, b) {
      var d = P.rank(b.role) - P.rank(a.role);
      return d || String(a.display_name || '').localeCompare(String(b.display_name || ''));
    });
  }

  /* ---------------- staff list ---------------- */
  function renderStaff(root, s) {
    var rows = sortedStaff();
    var owner = P.isOwnership();
    var showLast = hasLastSeen();
    var cols = 'minmax(180px,1.5fr) 118px minmax(170px,1.4fr) 96px' + (showLast ? ' 104px' : '') + (owner ? ' 150px' : '');
    var minW = 620 + (showLast ? 104 : 0) + (owner ? 150 : 0);

    var head = '<div class="page-head x-head"><div><h2>Staff</h2><p class="sub x-sub">Who helps run ' + esc(P.serverName(s.server)) + ', and what they can do.</p></div>'
      + '<div class="actions x-actions">' + (owner ? '<button type="button" class="gl-btn gl-btn-primary" data-action="invite">+ Add staff</button>' : '') + '</div></div>';

    if (!rows.length) {
      root.innerHTML = head + '<div class="gl-card"><div class="empty">No staff on this server yet.</div></div>';
      return;
    }

    var html = '<div class="tbl-scroll"><div class="gl-glass x-tbl st-tbl" style="--x-cols:' + cols + ';min-width:' + minW + 'px">'
      + '<div class="table-head x-th"><span>Member</span><span>Role</span><span>Can do</span><span>Joined</span>'
      + (showLast ? '<span>Last online</span>' : '') + (owner ? '<span class="x-right">&nbsp;</span>' : '') + '</div>';

    rows.forEach(function (r) {
      var me = P.state.me && r.id === P.state.me.id;
      var perms = Array.isArray(r.perms) ? r.perms : [];
      var permText = perms.length ? perms.map(esc).join(', ') : '—';
      html += '<div class="list-row x-tr">'
        + '<div class="x-user">' + P.avatar(r.display_name) + '<span class="x-ell"><span class="x-name">' + esc(r.display_name) + (me ? ' <span class="x-you">You</span>' : '') + '</span><br><span class="x-handle">@' + esc(r.username) + '</span></span></div>'
        + '<span>' + P.rolePill(r.role) + '</span>'
        + '<span class="st-perms">' + permText + '</span>'
        + '<span class="x-num x-dim">' + esc(P.timeAgo(r.created_at)) + '</span>'
        + (showLast ? '<span class="x-num x-dim">' + esc(r.last_seen_at ? P.timeAgo(r.last_seen_at) : '—') + '</span>' : '');
      if (owner) {
        html += '<span class="x-right">' + (canManage(r)
          ? '<button type="button" class="gl-btn gl-btn-ghost gl-btn-sm x-mini" data-action="manage" data-id="' + esc(r.id) + '">Manage</button>'
          : '<span class="x-needs">Can’t be edited here</span>') + '</span>';
      }
      html += '</div>';
    });
    html += '</div></div>';
    root.innerHTML = head + html;
  }

  /* ---------------- invite modal ---------------- */
  function openInvite() {
    if (!P.isOwnership()) { P.toast('fail', 'Only the owner can add staff.'); return; }
    var f = { name: '', handle: '', role: 'Moderator', pw: '', pw2: '' }, busy = false;
    function body() {
      return '<div class="field-label">Name</div><input class="gl-input" type="text" data-field="name" value="' + esc(f.name) + '" placeholder="Their display name" autocomplete="off">'
        + '<div class="field-label">Username <span class="hint">letters, numbers, . _ -</span></div><input class="gl-input" type="text" data-field="handle" value="' + esc(f.handle) + '" placeholder="e.g. kai.mod" autocapitalize="none" spellcheck="false" autocomplete="off">'
        + '<div class="field-label">Role</div><div class="chip-wrap">' + P.roleList().map(function (r) {
          return '<button type="button" class="chip' + (f.role === r ? ' is-active' : '') + '" data-action="invite-role" data-role="' + esc(r) + '">' + esc(r) + '</button>';
        }).join('') + '</div>'
        + '<div class="field-label">Password <span class="hint">at least 8 characters</span></div><input class="gl-input" type="password" data-field="pw" value="' + esc(f.pw) + '" autocomplete="new-password">'
        + '<div class="field-label">Confirm password</div><input class="gl-input" type="password" data-field="pw2" value="' + esc(f.pw2) + '" data-enter="invite-submit" autocomplete="new-password">'
        + '<p class="note-line">They sign in with the username and this password. Default permissions for the role are applied.</p>';
    }
    function actions() {
      return [{ label: 'Cancel', action: 'cancel', kind: 'ghost' }, { label: busy ? 'Adding…' : 'Add staff', action: 'invite-submit', kind: 'primary', disabled: busy }];
    }
    var m = P.openModal({
      title: 'Add staff', sub: 'Creates a login for a new staff member on ' + esc(P.serverName(P.state.server)) + '.',
      html: body(), actions: actions(),
      onInput: function (field, el) {
        if (field === 'handle') { var v = el.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ''); if (v !== el.value) el.value = v; f.handle = v; }
        else if (field in f) f[field] = el.value;
      },
      onAction: function (a, el) {
        if (a === 'cancel') { P.closeModal(); return; }
        if (a === 'invite-role') { f.role = el.getAttribute('data-role'); m.update({ html: body() }); return; }
        if (a === 'invite-submit') {
          if (busy) return;
          busy = true; m.update({ actions: actions() });
          P.api.invite({ name: f.name, handle: f.handle, role: f.role, pw: f.pw, pw2: f.pw2 }).then(function (ok) {
            busy = false;
            if (ok) P.closeModal(); else if (P.modal.current === m) m.update({ actions: actions() });
          });
        }
      }
    });
  }

  /* ---------------- manage modal ---------------- */
  function openManage(row) {
    if (!canManage(row)) { P.toast('fail', 'You can’t edit this member here.'); return; }
    var st = { id: row.id, handle: row.username, name: row.display_name, role: row.role, perms: expandPerms(row.perms), revoking: false, busy: false };
    function body() {
      var h = '<div class="x-sec" style="margin-top:0">Role</div><div class="chip-wrap">' + P.roleList().map(function (r) {
        return '<button type="button" class="chip' + (st.role === r ? ' is-active' : '') + '" data-action="manage-role" data-role="' + esc(r) + '">' + esc(r) + '</button>';
      }).join('') + '</div>';
      h += '<div class="x-sec">What they can do</div><div class="x-toggles">' + P.PERMS.map(function (p) {
        var on = st.perms.indexOf(p) > -1;
        return '<div class="x-toggle-row"><span class="x-tlabel">' + esc(PERM_LABEL[p] || p) + '</span>'
          + '<label class="gl-switch"><input type="checkbox" data-field="perm" data-perm="' + esc(p) + '"' + (on ? ' checked' : '') + '><span class="gl-switch-track"></span></label></div>';
      }).join('') + '</div>';
      if (st.role === 'Owner') h += '<p class="hint-line">Owners always have every permission.</p>';
      if (canRevoke(row)) {
        h += '<div class="x-revoke st-revoke">' + (st.revoking
          ? '<p class="st-revoke-q">Are you sure? They lose access immediately.</p><div class="st-revoke-btns">'
            + '<button type="button" class="gl-btn gl-btn-danger" data-action="revoke-yes"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Removing…' : 'Yes, remove') + '</button>'
            + '<button type="button" class="gl-btn gl-btn-ghost" data-action="revoke-no">Keep</button></div>'
          : '<button type="button" class="gl-btn gl-btn-ghost" data-action="revoke-start">Remove from staff…</button>') + '</div>';
      }
      return h;
    }
    function actions() {
      return [{ label: 'Cancel', action: 'cancel', kind: 'ghost' }, { label: st.busy ? 'Saving…' : 'Save', action: 'manage-save', kind: 'primary', disabled: st.busy }];
    }
    var m = P.openModal({
      title: esc(st.name), sub: '@' + esc(st.handle), avatarName: st.name,
      html: body(), actions: actions(),
      onInput: function (field, el) {
        if (field !== 'perm') return;
        var p = el.getAttribute('data-perm');
        st.perms = st.perms.filter(function (x) { return x !== p; });
        if (el.checked) st.perms.push(p);
      },
      onAction: function (a, el) {
        if (a === 'cancel') { P.closeModal(); return; }
        if (a === 'manage-role') { st.role = el.getAttribute('data-role'); m.update({ html: body() }); return; }
        if (a === 'revoke-start') { st.revoking = true; m.update({ html: body() }); return; }
        if (a === 'revoke-no') { st.revoking = false; m.update({ html: body() }); return; }
        if (st.busy) return;
        if (a === 'revoke-yes') {
          st.busy = true; m.update({ html: body(), actions: actions() });
          P.api.revokeStaff(st.id).then(function (ok) {
            st.busy = false;
            if (ok) { P.closeModal(); P.toast('ok', st.name + ' no longer has staff access.'); }
            else if (P.modal.current === m) m.update({ html: body(), actions: actions() });
          });
          return;
        }
        if (a === 'manage-save') {
          st.busy = true; m.update({ actions: actions() });
          P.api.saveStaff(st.handle, st.role, st.perms).then(function (ok) {
            st.busy = false;
            if (ok) { P.closeModal(); P.toast('ok', 'Permissions updated for ' + st.name + '.'); }
            else if (P.modal.current === m) m.update({ actions: actions() });
          });
        }
      }
    });
  }

  P.registerScreen('staff', {
    title: 'Staff',
    nav: { label: 'Staff', icon: 'staff', order: 80 },
    render: renderStaff,
    onAction: function (action, el) {
      if (action === 'invite') { openInvite(); return; }
      if (action === 'manage') {
        var id = el.getAttribute('data-id');
        var row = (P.state.data.staff || []).filter(function (r) { return r.id === id; })[0];
        if (row) openManage(row);
      }
    }
  });

  /* ---------------- hidden names (blacklist) ---------------- */
  function renderBlacklist(root, s) {
    var ui = P.ui('blacklist', { name: '', busy: false });
    var rows = (s.data.blacklist || []).slice().sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    var html = '<div class="page-head x-head"><div><h2>Hidden names' + (rows.length ? ' <span class="bl-count">' + rows.length + '</span>' : '') + '</h2>'
      + '<p class="sub x-sub">These names can’t be looked up on instellar.net/punishment. Shared by both servers.</p></div></div>';
    html += '<section class="gl-glass gl-card bl-add"><div class="gl-row bl-add-row">'
      + '<input class="gl-input bl-input" type="text" maxlength="16" placeholder="Type a player name…" data-field="name" data-enter="add" value="' + esc(ui.name) + '" autocapitalize="none" spellcheck="false" autocomplete="off">'
      + '<button type="button" class="gl-btn gl-btn-primary" data-action="add"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? 'Hiding…' : 'Hide name') + '</button></div></section>';
    html += '<section class="gl-glass gl-card bl-list">';
    if (!rows.length) html += '<div class="empty">No hidden names.</div>';
    rows.forEach(function (b) {
      html += '<div class="x-bl-row">' + P.avatar(b.name)
        + '<span class="x-ell"><span class="x-bl-name">' + esc(b.name) + '</span><br><span class="x-dim">hidden by ' + esc(b.by_name || '—') + ' · ' + esc(P.timeAgo(b.created_at)) + '</span></span>'
        + '<button type="button" class="gl-btn gl-btn-ghost gl-btn-sm x-mini" data-action="remove" data-id="' + esc(b.id) + '">Remove</button></div>';
    });
    html += '</section>';
    root.innerHTML = html;
  }

  P.registerScreen('blacklist', {
    title: 'Hidden names',
    nav: { label: 'Hidden names', icon: 'blacklist', order: 90, show: function () { return P.canServerConfig(); } },
    guard: function () { return P.canServerConfig(); },
    render: renderBlacklist,
    onInput: function (field, el) {
      if (field === 'name') P.ui('blacklist').name = el.value;
    },
    onAction: function (action, el) {
      var ui = P.ui('blacklist', { name: '', busy: false });
      if (action === 'add') {
        var name = String(ui.name || '').trim();
        if (!name) { P.toast('fail', 'Type a player name first.'); return; }
        if (ui.busy) return;
        ui.busy = true; P.rerender();
        P.api.addBlacklist(name).then(function (ok) {
          ui.busy = false;
          if (ok) ui.name = '';
          P.rerender();
        });
        return;
      }
      if (action === 'remove') {
        var id = el.getAttribute('data-id');
        var row = (P.state.data.blacklist || []).filter(function (b) { return String(b.id) === id; })[0];
        if (!row) return;
        P.confirm('Show ' + row.name + ' on instellar.net/punishment again?', 'Remove', 'primary').then(function (ok) {
          if (ok) P.api.removeBlacklist(row);
        });
      }
    }
  });
})();
