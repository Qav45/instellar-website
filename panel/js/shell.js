/* =========================================================================
   Instellar moderation panel — shell (sidebar, topbar, login)
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P;
  var esc = P.esc;

  function navItems(s) {
    return Object.keys(P.screens).map(function (k) { return P.screens[k]; })
      .filter(function (d) { return d.nav && (!d.nav.show || d.nav.show(s)) && P.screenAllowed(d.key); })
      .sort(function (a, b) { return (a.nav.order || 0) - (b.nav.order || 0); });
  }
  function icon(name) {
    return '<span class="gl-nav-icon"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-' + esc(name) + '"/></svg></span>';
  }
  function isActive(def, s) {
    if (def.key === s.screen) return true;
    if (def.key === 'dashboard' && s.screen === 'supdash') return true;
    return false;
  }

  P.renderShell = function (s) {
    var nav = document.getElementById('nav');
    if (!s.authed) { if (nav) nav.innerHTML = ''; return; }
    nav.innerHTML = navItems(s).map(function (d) {
      var count = d.nav.count ? d.nav.count(s) : 0;
      return '<a class="gl-nav-item' + (isActive(d, s) ? ' is-active' : '') + '" href="#' + esc(d.key) + '" data-goto="' + esc(d.key) + '" data-navkey="' + esc(d.key) + '"'
        + (isActive(d, s) ? ' aria-current="page"' : '') + '>' + icon(d.nav.icon || d.key) + '<span class="gl-nav-label">' + esc(d.nav.label) + '</span>'
        + '<span class="gl-nav-count" data-navcount="' + esc(d.key) + '"' + (count ? '' : ' hidden') + '>' + (count || '') + '</span></a>';
    }).join('');

    var seg = document.getElementById('server-seg');
    seg.style.setProperty('--gl-seg-count', String(P.cfg.SERVERS.length));
    seg.innerHTML = P.cfg.SERVERS.map(function (sv) {
      return '<input type="radio" name="srv" id="srv-' + esc(sv[0]) + '" value="' + esc(sv[0]) + '" data-field="server"' + (s.server === sv[0] ? ' checked' : '') + '>';
    }).join('') + P.cfg.SERVERS.map(function (sv) {
      return '<label class="gl-seg-item" for="srv-' + esc(sv[0]) + '">' + esc(sv[1]) + '</label>';
    }).join('') + '<span class="gl-seg-thumb"></span>';

    var me = s.me || {};
    document.getElementById('ident').innerHTML = P.avatar(me.display_name || '?')
      + '<span class="who"><b>' + esc(me.display_name || '') + '</b><span class="me-role role-' + P.roleClass(me.role) + '">' + esc(me.role || '') + '</span></span>'
      + '<button type="button" class="icon-btn" data-action="logout" title="Sign out" aria-label="Sign out"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-signout"/></svg></button>';

    var def = P.screens[s.screen];
    document.getElementById('pageTitle').textContent = def ? def.title : 'Instellar';
    document.getElementById('topbar-server').textContent = P.serverName(s.server);
    document.title = (def ? def.title + ' · ' : '') + 'Instellar Panel';
  };

  P.renderNavCounts = function (s) {
    navItems(s).forEach(function (d) {
      var el = document.querySelector('[data-navcount="' + d.key + '"]'); if (!el) return;
      var c = d.nav.count ? d.nav.count(s) : 0;
      el.textContent = c || ''; el.hidden = !c;
    });
  };

  P.onShellAction = function (action, el) {
    if (action === 'logout') { P.api.logout(); return true; }
    return false;
  };
  P.onShellInput = function (field, el) {
    if (field === 'server') { if (el.checked) P.api.setServer(el.value); return true; }
    return false;
  };

  /* ---------------- login ---------------- */
  var login = { user: '', pw: '', busy: false };
  P.renderLogin = function (s) {
    var err = s.loginError;
    return '<div class="login-wrap"><div class="wordmark">Instellar</div><p class="tagline">Sign in to the moderation panel</p>'
      + '<form class="login-card" id="login-form" autocomplete="on" novalidate>'
      + '<label class="gl-field"><span class="gl-label">Username</span><input class="gl-input" type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" data-field="loginUser" data-enter="login" value="' + esc(login.user) + '" placeholder="your.username"' + (s.booting ? ' disabled' : '') + ' autofocus></label>'
      + '<label class="gl-field"><span class="gl-label">Password</span><input class="gl-input" type="password" name="password" autocomplete="current-password" data-field="loginPw" data-enter="login" value="' + esc(login.pw) + '" placeholder="••••••••"' + (s.booting ? ' disabled' : '') + '></label>'
      + (err ? '<p class="login-error" role="alert">' + esc(err) + '</p>' : '')
      + '<button type="submit" class="gl-btn gl-btn-primary login-btn"' + (login.busy || s.booting ? ' disabled' : '') + '>' + (s.booting ? 'Connecting…' : login.busy ? 'Signing in…' : 'Sign in') + '</button>'
      + '</form>'
      + '<p class="login-foot">Staff access only · ask an admin for an account</p></div>';
  };
  P.onLoginInput = function (field, el) {
    if (field === 'loginUser') login.user = el.value;
    if (field === 'loginPw') login.pw = el.value;
    if (P.state.loginError) { P.state.loginError = ''; var e = document.querySelector('.login-error'); if (e) e.remove(); }
  };
  P.onLoginAction = function (action) {
    if (action !== 'login' || login.busy) return;
    login.busy = true; P.rerender();
    P.api.login(login.user, login.pw).then(function (err) {
      login.busy = false;
      if (err) { P.state.loginError = err; login.pw = ''; P.rerender(); var pw = document.querySelector('[data-field="loginPw"]'); if (pw) pw.focus(); }
      else { login.user = ''; login.pw = ''; }
    });
  };
  document.addEventListener('submit', function (ev) {
    if (ev.target && ev.target.id === 'login-form') { ev.preventDefault(); P.onLoginAction('login'); }
  });
})();
