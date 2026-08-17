/* =========================================================================
   Instellar moderation panel — punish confirm modal
   P.openPunish({ type, target, reason?, duration? })
   The ONE confirm dialog every screen uses (Ban / Wipeban / Mute / Warn /
   Kick / Unban). Ported from the old panel's openConfirm/execute.
   ========================================================================= */
(function () {
  'use strict';
  var P = window.P;
  var esc = P.esc;
  var FILE_RE = /^(image\/|video\/(mp4|webm|quicktime)|audio\/)/;
  var MAX_FILES = 5, MAX_BYTES = 50 * 1024 * 1024;

  P.openPunish = function (o) {
    var st = {
      type: o.type, target: String(o.target || ''), reason: o.reason || '',
      duration: o.duration || '7 days', files: [], link: '', busy: false
    };
    var needsDur = st.type === 'Ban' || st.type === 'Mute';
    var me = P.myName();

    function durForApproval() { return needsDur ? st.duration : undefined; }
    function approval() { return P.needsApproval(st.type, durForApproval()); }
    function protection() {
      var pr = P.protectionFor(st.target);
      return pr && (pr.blocks || []).indexOf(st.type) > -1 ? pr : null;
    }
    function subLine() {
      if (st.type === 'Wipeban') return 'Permanent · account marked as wiped · by ' + esc(me);
      if (needsDur) return 'Duration: ' + esc(st.duration) + ' · by ' + esc(me);
      return 'Immediate · by ' + esc(me);
    }
    function html() {
      var h = '';
      h += '<div class="field-label">Reason</div>'
        + '<textarea class="gl-textarea" id="punish-reason" data-field="reason" placeholder="Why? Keep it short — the player will see this." required>' + esc(st.reason) + '</textarea>';
      if (needsDur) {
        var durs = [];
        ['1 hour', '1 day', '7 days', '30 days', st.duration, 'Permanent'].forEach(function (d) { if (d && durs.indexOf(d) < 0) durs.push(d); });
        h += '<div class="field-label">Duration</div><div class="chip-wrap">' + durs.map(function (d) {
          return '<button type="button" class="chip' + (d === st.duration ? ' is-active' : '') + '" data-action="dur" data-v="' + esc(d) + '">' + esc(d) + '</button>';
        }).join('') + '</div>';
      }
      h += '<div class="field-label">Proof <span class="hint">optional · screenshot, mp4, mp3 or a link</span></div>'
        + '<div class="proof-row"><button type="button" class="gl-btn gl-btn-sm" data-action="pickFile"' + (st.busy || st.files.length >= MAX_FILES ? ' disabled' : '') + '>+ Attach file</button>'
        + '<input type="file" id="punish-files" data-field="proofFiles" multiple accept="image/*,video/mp4,video/webm,video/quicktime,audio/*" hidden>'
        + st.files.map(function (f, i) {
          return '<span class="file-chip">' + esc(f.name) + ' · ' + esc(P.fmtSize(f.size))
            + '<button type="button" data-action="rmFile" data-i="' + i + '" aria-label="Remove ' + esc(f.name) + '"' + (st.busy ? ' disabled' : '') + '>×</button></span>';
        }).join('') + '</div>'
        + '<input class="gl-input" type="url" id="punish-link" data-field="proofLink" placeholder="https:// link to a clip, screenshot or Discord message" value="' + esc(st.link) + '">';
      var pr = protection();
      if (pr) {
        h += '<div class="p-protected"><span class="protected-pill">Protected — ' + esc(pr.reason || 'no reason given') + '</span>'
          + '<p class="note-line">This player is protected. Only a Supervisor can change that (Protection tab).</p></div>';
      } else {
        h += '<p class="note-line">' + (approval()
          ? 'Your role can’t run this command directly — it will be sent to a higher role for approval before it executes.'
          : 'This command runs on the game server. It will show as Waiting in History until the plugin confirms it.') + '</p>';
      }
      return h;
    }
    function actions() {
      var danger = st.type === 'Ban' || st.type === 'Wipeban' || st.type === 'Kick';
      var label = st.busy ? 'Uploading proof…' : approval() ? 'Request approval' : 'Confirm ' + st.type.toLowerCase();
      return [
        { label: 'Cancel', action: 'cancel', kind: 'ghost' },
        { label: label, action: 'submit', kind: danger ? 'danger' : 'primary', disabled: st.busy || !!protection() }
      ];
    }
    function title() {
      return '<span class="p-ttype ' + P.actionClass(st.type) + '">' + esc(st.type) + '</span> ' + esc(st.target) + '?';
    }
    function redraw() { m.update({ html: html(), actions: actions(), sub: subLine() }); }

    function submit() {
      if (st.busy) return;
      var reason = st.reason.trim();
      if (!reason) { P.toast('fail', 'A reason is required.'); return; }
      if (st.type === 'Wipeban' && !P.canWipeban()) { P.toast('fail', 'You do not have the Wipeban permission.'); return; }
      var link = st.link.trim();
      if (link && !P.safeUrl(link)) { P.toast('fail', 'The proof link must start with http:// or https://'); return; }
      var upload = st.files.length ? P.api.uploadProof(st.files.slice()) : Promise.resolve({ urls: [] });
      if (st.files.length) { st.busy = true; redraw(); }
      upload.then(function (up) {
        st.busy = false;
        if (P.modal.current !== m) return;
        if (up.error) { redraw(); P.toast('fail', 'Proof upload failed: ' + up.error); return; }
        var proof = (up.urls || []).slice();
        if (link) proof.push(link);
        var isApproval = approval();
        return P.api.submitAction({ type: st.type, target: st.target, reason: reason, duration: needsDur ? st.duration : null, proof: proof }).then(function (res) {
          res = res || {};
          if (res.protectedBlock) {
            P.closeModal();
            P.toast('fail', String(res.error || '').replace(/^PROTECTED:\s*/, ''));
            return;
          }
          if (res.error) { redraw(); P.toast('fail', 'Could not submit: ' + res.error); return; }
          P.closeModal();
          if (res.approval !== undefined) isApproval = !!res.approval;
          P.toast('info', isApproval
            ? st.type + ' on ' + st.target + ' sent to a higher role for approval.'
            : st.type + ' on ' + st.target + ' queued — waiting for the server plugin…');
        });
      }).catch(function (e) {
        st.busy = false; if (P.modal.current === m) redraw();
        P.toast('fail', 'Could not submit: ' + (e && e.message ? e.message : e));
      });
    }

    var m = P.openModal({
      title: title(), sub: subLine(), avatarName: st.target, html: html(), actions: actions(),
      onAction: function (a, el) {
        if (a === 'cancel') { if (!st.busy) P.closeModal(); return; }
        if (a === 'dur') { st.duration = el.getAttribute('data-v'); redraw(); return; }
        if (a === 'pickFile') { var inp = document.getElementById('punish-files'); if (inp) inp.click(); return; }
        if (a === 'rmFile') { st.files.splice(Number(el.getAttribute('data-i')), 1); redraw(); return; }
        if (a === 'submit') submit();
      },
      onInput: function (f, el) {
        if (f === 'reason') st.reason = el.value;
        else if (f === 'proofLink') st.link = el.value;
        else if (f === 'proofFiles') {
          var picked = Array.prototype.slice.call(el.files || []);
          el.value = '';
          var bad = picked.filter(function (x) { return !FILE_RE.test(x.type); })[0];
          if (bad) { P.toast('fail', bad.name + ' is not a screenshot, mp4 or mp3.'); return; }
          var big = picked.filter(function (x) { return x.size > MAX_BYTES; })[0];
          if (big) { P.toast('fail', big.name + ' is over 50 MB.'); return; }
          var room = MAX_FILES - st.files.length;
          if (picked.length > room) P.toast('fail', 'You can attach up to ' + MAX_FILES + ' files.');
          st.files = st.files.concat(picked.slice(0, Math.max(0, room)));
          redraw();
        }
      },
      // protection / role data can change while the dialog is open
      rerender: function () { redraw(); }
    });
    return m;
  };
})();
