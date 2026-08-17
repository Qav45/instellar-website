window.P.boot();
(function(){
  var out=[]; function log(){ out.push(Array.prototype.join.call(arguments,' ')); }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
  function q(sel){ return document.querySelector(sel); }
  function click(sel){ var el=q(sel); if(!el){ log('MISSING',sel); return false; } el.click(); return true; }
  function type(sel,v){ var el=q(sel); if(!el){ log('MISSING',sel); return; } el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); }
  function txt(sel){ var el=q(sel); return el?el.textContent.trim():'(none)'; }
  function toasts(){ return Array.prototype.map.call(document.querySelectorAll('#toast-root .gl-toast-text'),function(e){return e.textContent;}).join(' | '); }
  async function waitFor(fn,ms){ var t=0; while(t<(ms||3000)){ if(fn()) return true; await sleep(50); t+=50; } return false; }
  async function run(){
    await waitFor(function(){ return P.state.authed && P.state.data.actions.length; },5000);
    log('1 authed as', P.state.me.username, 'screen', P.state.screen);
    P.route('infractions','Nova_Tide'); await sleep(100);
    P.openPunish({type:'Ban',target:'Nova_Tide',reason:'x',duration:'7 days'}); await sleep(50);
    var btn=q('#modal-root [data-action="submit"]'); log('2 protected submit disabled =', btn && btn.disabled, '| pill:', txt('#modal-root .protected-pill'));
    P.closeModal();
    var before=MOCK.db.mod_actions.length;
    P.openPunish({type:'Ban',target:'Sn0wF0x_',reason:'Cheating / Hacking',duration:'7 days'}); await sleep(50);
    type('#modal-root [data-field="proofLink"]','https://example.com/clip');
    click('#modal-root [data-action="submit"]'); await sleep(300);
    var row=MOCK.db.mod_actions[MOCK.db.mod_actions.length-1];
    log('3 inserted', MOCK.db.mod_actions.length-before, 'row', row.type, row.target, row.status, JSON.stringify(row.proof), '| toast:', toasts(), '| modal open:', !!P.modal.current);
    P.openPunish({type:'Ban',target:'ghast_kid',reason:'Doxing / DDoSing',duration:'Permanent'}); await sleep(50);
    click('#modal-root [data-action="submit"]'); await sleep(300);
    row=MOCK.db.mod_actions[MOCK.db.mod_actions.length-1]; log('4 perm ban status', row.status, '| toast:', toasts());
    P.route('audit','Sn0wF0x_'); await sleep(400);
    log('5 history rows', document.querySelectorAll('.a-tbl .x-tr').length, 'first status:', txt('.a-tbl .x-tr .status'));
    P.route('players'); await sleep(200);
    var name=q('[data-action="open"]'); if(name){ name.click(); await sleep(100); log('6 sheet title', txt('#modal-root h3'), '| notes inputs', document.querySelectorAll('#modal-root [data-field="note"]').length); }
    type('#modal-root [data-field="note"]','test note'); var ni=q('#modal-root [data-field="note"]'); if(ni){ ni.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await sleep(300); log('7 note toast:', toasts(), 'notes in db', MOCK.db.player_notes.length); }
    click('#modal-root [data-action="punish"][data-type="Kick"]'); await sleep(100); log('8 punish modal from sheet:', txt('#modal-root h3'));
    P.closeModal();
    P.route('approvals'); await sleep(200);
    log('9 approvals rows', document.querySelectorAll('[data-action="approve"]').length, 'needs pills', document.querySelectorAll('.x-needs').length);
    P.route('dashboard'); await sleep(200);
    click('[data-action="range"][data-v="30"]'); await sleep(100); log('10 range 30 active:', q('[data-action="range"][data-v="30"]').classList.contains('is-active'));
    MOCK.as('qav45'); await P.api.finishLogin('u-qav45'); await sleep(600);
    log('11 now', P.state.me.username, 'screen', P.state.screen, 'nav has protection:', !!q('[data-navkey="protection"]'));
    P.route('protection'); await sleep(200);
    click('[data-action="add"]'); await sleep(100);
    type('#modal-root [data-field="name"]','Kestrel99'); type('#modal-root [data-field="reason"]','Youtuber');
    click('#modal-root [data-action="until"][data-v="7"]'); await sleep(50);
    click('#modal-root [data-action="protect"]'); await sleep(400);
    var pp=MOCK.db.protected_players.filter(function(x){return x.name==='Kestrel99';})[0];
    log('12 protected inserted:', !!pp, pp&&JSON.stringify(pp.blocks), pp&&pp.expires_at?'expires':'', '| toast:', toasts(), '| rows', document.querySelectorAll('.pr-tbl .x-tr').length);
    P.route('approvals'); await sleep(200);
    var ap=q('[data-action="approve"]'); if(ap){ var id=ap.getAttribute('data-id'); ap.click(); await sleep(300); var r2=MOCK.db.mod_actions.filter(function(x){return String(x.id)===String(id);})[0]; log('13 approved ->', r2&&r2.status, '| toast:', toasts()); }
    P.route('staff'); await sleep(200);
    var mg=q('[data-action="manage"][data-id="u-rin"]'); if(mg){ mg.click(); await sleep(100); click('#modal-root [data-action="manage-role"][data-role="Jr Moderator"]'); await sleep(50); click('#modal-root [data-action="manage-save"]'); await sleep(300); var st=MOCK.db.staff.filter(function(x){return x.id==='u-rin';})[0]; log('14 rin role now', st.role, '| audit rows', MOCK.db.staff_audit.length, '| toast:', toasts()); } else log('14 no manage button for u-rin');
    var s2=q('#srv-instellar2'); if(s2){ s2.checked=true; s2.dispatchEvent(new Event('change',{bubbles:true})); } await sleep(400);
    log('15 server', P.state.server, 'staff rows', P.state.data.staff.length, 'title server', txt('#topbar-server'));
    click('[data-action="logout"]'); await sleep(200); log('16 authed', P.state.authed, 'login form', !!q('#login-form'));
    type('[data-field="loginUser"]','kai.mod'); type('[data-field="loginPw"]','nope'); q('#login-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); await sleep(300); log('17 login error:', txt('.login-error'));
    type('[data-field="loginUser"]','kai.mod'); type('[data-field="loginPw"]','test'); q('#login-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); await sleep(600); log('18 authed', P.state.authed, P.state.me&&P.state.me.username, 'screen', P.state.screen);
    var pre=document.createElement('pre'); pre.id='__test'; pre.textContent=out.join('\n'); document.body.appendChild(pre);
  }
  run().catch(function(e){ out.push('EXC '+(e&&e.stack||e)); var pre=document.createElement('pre'); pre.id='__test'; pre.textContent=out.join('\n'); document.body.appendChild(pre); });
})();
