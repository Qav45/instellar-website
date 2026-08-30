/* Deterministic fixture data for the mock. Password for every account: "test". */
(function () {
  var M = window.MOCK = window.MOCK || {};
  var NOW = Date.now();
  var H = 3600000, D = 86400000;
  function ago(ms) { return new Date(NOW - ms).toISOString(); }
  var seed = 7; function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
  function pick(a) { return a[Math.floor(rnd() * a.length)]; }

  var staff = [
    { id: 'u-qav45', username: 'qav45', display_name: 'qav45', role: 'Supervisor', perms: ['All permissions'], server: 'instellar1', created_at: ago(200 * D), last_seen_at: ago(2 * 60000) },
    { id: 'u-ash', username: 'ash.vellum', display_name: 'Ash Vellum', role: 'Sr Admin', perms: ['Ban', 'Unban', 'Mute', 'Kick', 'Warn', 'Staff management', 'Server config', 'Wipeban'], server: 'instellar1', created_at: ago(180 * D), last_seen_at: ago(12 * 60000) },
    { id: 'u-arcade', username: 'arcadeash', display_name: 'ArcadeAsh', role: 'Admin', perms: ['Ban', 'Unban', 'Mute', 'Kick', 'Warn', 'Staff management'], server: 'instellar1', created_at: ago(150 * D), last_seen_at: ago(1 * H) },
    { id: 'u-kai', username: 'kai.mod', display_name: 'Kai F.', role: 'Moderator', perms: ['Ban', 'Mute', 'Kick', 'Warn'], server: 'instellar1', created_at: ago(90 * D), last_seen_at: ago(2 * 60000) },
    { id: 'u-nova', username: 'nova.hex', display_name: 'Nova_Hex', role: 'Moderator', perms: ['Ban', 'Mute', 'Kick', 'Warn', 'Guides'], server: 'instellar1', created_at: ago(80 * D), last_seen_at: ago(3 * H) },
    { id: 'u-rin', username: 'rin.helper', display_name: 'Rin M.', role: 'Helper', perms: ['Mute', 'Kick', 'Warn'], server: 'instellar1', created_at: ago(40 * D), last_seen_at: ago(25 * 60000) },
    { id: 'u-milo', username: 'milo.t', display_name: 'Milo T.', role: 'Jr Moderator', perms: ['Mute', 'Kick', 'Warn'], server: 'instellar1', created_at: ago(30 * D), last_seen_at: ago(6 * H) },
    { id: 'u-sky', username: 'sky.vale', display_name: 'Sky_Vale', role: 'Helper', perms: ['Mute', 'Kick', 'Warn'], server: 'instellar1', created_at: ago(20 * D), last_seen_at: ago(2 * D) },
    { id: 'u-pixel', username: 'pixel.fern', display_name: 'Pixel_Fern', role: 'Trainee', perms: ['Mute', 'Kick'], server: 'instellar1', created_at: ago(10 * D), last_seen_at: ago(4 * D) },
    { id: 'u-owner', username: 'instellarowner2', display_name: 'Instellar', role: 'Owner', perms: ['All permissions'], server: 'instellar1', created_at: ago(300 * D), last_seen_at: ago(40 * D) },
    { id: 'u-old', username: 'old.helper', display_name: 'Toby_R', role: 'Helper', perms: ['Mute', 'Kick'], server: 'instellar1', created_at: ago(120 * D), last_seen_at: ago(45 * D) },
    // instellar2 team
    { id: 'u-jun', username: 'jun.mod', display_name: 'Jun K.', role: 'Sr Moderator', perms: ['Ban', 'Mute', 'Kick', 'Warn'], server: 'instellar2', created_at: ago(70 * D), last_seen_at: ago(50 * 60000) },
    { id: 'u-lia', username: 'lia.admin', display_name: 'Lia', role: 'Admin', perms: ['Ban', 'Unban', 'Mute', 'Kick', 'Warn', 'Staff management'], server: 'instellar2', created_at: ago(100 * D), last_seen_at: ago(5 * H) },
    { id: 'u-bo', username: 'bo.helper', display_name: 'Bo', role: 'Helper', perms: ['Mute', 'Kick', 'Warn'], server: 'instellar2', created_at: ago(15 * D), last_seen_at: ago(1 * D) }
  ];
  var players = ['Sn0wF0x_', 'brickbybrick', 'Nova_Tide', 'xX_grief_Xx', 'pixelpaws', 'emberlily', 'tinyquartz', 'ghast_kid', 'void_runner', 'Instellar_Dev', 'creeper_dan', 'lunar_ly', 'Mossy_Bee', 'Kestrel99', 'iron_ivy', 'quartz_qt', 'blocky_bill', 'RedstoneRae', 'nether_nat', 'Zed_Zero'];
  var reasons = { Ban: ['Cheating / Hacking', 'Exploiting / Bug abuse', 'Map abuse / Exploiting', 'Doxing / DDoSing'], Mute: ['Spamming', 'Toxicity', 'Racism', 'Advertising', 'Flooding chat', 'Slurs (excessive / NSFW / sexualisation)'], Warn: ['Toxicity', 'Spamming', 'Map abuse / Exploiting'], Kick: ['AFK farming', 'Spamming', 'Toxicity'], Unban: ['Appeal accepted', 'False positive'], Wipeban: ['Cheating / Hacking', 'Doxing / DDoSing'] };
  var durs = { Ban: ['7 days', '14 days', '30 days', 'Permanent'], Mute: ['30 minutes', '3 hours', '1 day', '3 days', '7 days'] };
  var proofs = ['https://mock.local/storage/v1/object/public/proof/instellar1/1-a-clip.mp4', 'https://mock.local/storage/v1/object/public/proof/instellar1/2-b-shot.png', 'https://discord.com/channels/1/2/3'];

  var actions = [], id = 1000;
  function act(o) { o.id = ++id; o.proof = o.proof === undefined ? null : o.proof; o.error = o.error || null; actions.push(o); return o; }
  var s1 = staff.filter(function (s) { return s.server === 'instellar1' && s.role !== 'Owner' && s.username !== 'old.helper'; });
  var s2 = staff.filter(function (s) { return s.server === 'instellar2'; });
  for (var i = 0; i < 150; i++) {
    var server = i % 4 === 3 ? 'instellar2' : 'instellar1';
    var by = pick(server === 'instellar1' ? s1 : s2);
    var type = pick(['Ban', 'Ban', 'Mute', 'Mute', 'Mute', 'Warn', 'Warn', 'Kick', 'Unban', 'Wipeban']);
    if (type === 'Wipeban' && !(by.perms.indexOf('Wipeban') > -1 || by.role === 'Supervisor')) type = 'Ban';
    var dur = type === 'Ban' || type === 'Mute' ? pick(durs[type]) : type === 'Wipeban' ? 'Permanent' : null;
    var status = 'Executed';
    var r = rnd();
    if (r < 0.06) status = 'Failed'; else if (r < 0.10) status = 'Denied';
    var when = rnd() * 30 * D;
    act({ server: server, type: type, target: pick(players), reason: pick(reasons[type]), duration: dur, by_id: by.id, by_name: by.display_name, status: status,
      proof: rnd() < 0.55 ? [pick(proofs)] : null, error: status === 'Failed' ? 'Player not found on this server' : null, created_at: ago(when) });
  }
  // deliberate rows: pending queue, approvals, protected block, today's items
  act({ server: 'instellar1', type: 'Ban', target: 'Sn0wF0x_', reason: 'Cheating / Hacking', duration: '7 days', by_id: 'u-kai', by_name: 'Kai F.', status: 'Executed', proof: [proofs[0]], created_at: ago(2 * H) });
  act({ server: 'instellar1', type: 'Ban', target: 'xX_grief_Xx', reason: 'Cheating / Hacking', duration: 'Permanent', by_id: 'u-kai', by_name: 'Kai F.', status: 'Approval', proof: null, created_at: ago(2 * H + 15 * 60000) });
  act({ server: 'instellar1', type: 'Wipeban', target: 'ghast_kid', reason: 'Doxing / DDoSing', duration: 'Permanent', by_id: 'u-nova', by_name: 'Nova_Hex', status: 'Approval', proof: [proofs[1]], created_at: ago(5 * H) });
  act({ server: 'instellar1', type: 'Unban', target: 'tinyquartz', reason: 'Appeal accepted', duration: null, by_id: 'u-rin', by_name: 'Rin M.', status: 'Approval', proof: null, created_at: ago(9 * H) });
  act({ server: 'instellar1', type: 'Ban', target: 'pixelpaws', reason: 'Exploiting / Bug abuse', duration: '14 days', by_id: 'u-rin', by_name: 'Rin M.', status: 'Approval', proof: null, created_at: ago(40 * 60000) });
  act({ server: 'instellar1', type: 'Mute', target: 'brickbybrick', reason: 'Spamming', duration: '3 hours', by_id: 'u-arcade', by_name: 'ArcadeAsh', status: 'Pending', proof: null, created_at: ago(3 * 60000) });
  act({ server: 'instellar1', type: 'Kick', target: 'creeper_dan', reason: 'AFK farming', duration: null, by_id: 'u-milo', by_name: 'Milo T.', status: 'Failed', error: 'Player not online', created_at: ago(30 * 60000) });
  act({ server: 'instellar1', type: 'Ban', target: 'Nova_Tide', reason: 'Cheating / Hacking', duration: '7 days', by_id: 'u-rin', by_name: 'Rin M.', status: 'Denied', error: 'PROTECTED: Nova_Tide is protected (Content creator) - ask a Supervisor.', created_at: ago(2 * H) });
  act({ server: 'instellar1', type: 'Ban', target: 'lunar_ly', reason: 'Cheating / Hacking', duration: 'Permanent', by_id: 'u-ash', by_name: 'Ash Vellum', status: 'Executed', proof: null, created_at: ago(1 * H) });
  act({ server: 'instellar1', type: 'Ban', target: 'Zed_Zero', reason: 'Doxing / DDoSing', duration: 'Permanent', by_id: 'u-kai', by_name: 'Kai F.', status: 'Executed', proof: null, created_at: ago(4 * H) });
  // rin (Helper) with many bans -> flagged
  for (var k = 0; k < 6; k++) act({ server: 'instellar1', type: 'Ban', target: pick(players), reason: 'Cheating / Hacking', duration: '7 days', by_id: 'u-rin', by_name: 'Rin M.', status: 'Executed', proof: k % 2 ? [proofs[1]] : null, created_at: ago((k + 1) * D * 0.9) });
  actions.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });

  // The punishment ledger the game server publishes. Derived from the executed mod_actions above so
  // the two agree wherever the panel queued something, PLUS a handful of punishments that were
  // typed in game and exist in no mod_actions row at all -- which is the whole point of the ledger
  // and the case the panel used to render as "No punishments yet".
  var LEDGER_TYPE = { Ban: 'ban', Wipeban: 'ban', Mute: 'mute', Kick: 'kick', Warn: 'warn' };
  var punishments = [], pid = 0;
  function publicId() {
    var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', out = '';
    for (var q = 0; q < 8; q++) out += abc[Math.floor(rnd() * abc.length)];
    return out;
  }
  function ledger(o) {
    o.public_id = publicId();
    o.player_uuid = 'p-' + (pid++) + '-0000-4000-8000-00000000' + (1000 + pid);
    o.silent = o.silent || false;
    o.wiped = o.wiped || false;
    o.revoked_at = o.revoked_at || null;
    o.revoked_by = o.revoked_by || null;
    o.revoked_reason = o.revoked_reason || null;
    o.expires_at = o.expires_at === undefined ? null : o.expires_at;
    o.synced_at = o.created_at;
    punishments.push(o);
    return o;
  }
  var DUR_MS = { '30 minutes': 30 * 60000, '3 hours': 3 * H, '1 day': D, '3 days': 3 * D, '7 days': 7 * D, '14 days': 14 * D, '30 days': 30 * D };
  actions.forEach(function (a) {
    if (a.status !== 'Executed' || a.type === 'Unban') return;
    var span = DUR_MS[a.duration];
    ledger({
      server: a.server, type: LEDGER_TYPE[a.type] || 'warn', player_name: a.target, reason: a.reason,
      staff_name: a.by_name, created_at: a.created_at, active: a.type === 'Ban' || a.type === 'Wipeban' || a.type === 'Mute',
      wiped: a.type === 'Wipeban',
      expires_at: span ? new Date(new Date(a.created_at).getTime() + span).toISOString() : null
    });
  });
  // Issued in game with /ban and /mute: no mod_actions row exists for any of these.
  ledger({ server: 'instellar1', type: 'ban', player_name: 'iron_ivy', reason: 'X-ray (freecam)', staff_name: 'Ash Vellum', created_at: ago(6 * H), active: true });
  ledger({ server: 'instellar1', type: 'ipban', player_name: 'nether_nat', reason: 'Ban evasion', staff_name: 'Kai F.', created_at: ago(30 * H), active: true });
  ledger({ server: 'instellar1', type: 'mute', player_name: 'Mossy_Bee', reason: 'AutoMute: excessive caps', staff_name: 'AutoMute', created_at: ago(45 * 60000), active: true, expires_at: new Date(NOW + 2 * H).toISOString() });
  ledger({ server: 'instellar1', type: 'ban', player_name: 'quartz_qt', reason: 'Cheating / Hacking', staff_name: 'Nova_Hex', created_at: ago(20 * D), active: false, revoked_at: ago(3 * D), revoked_by: 'qav45', revoked_reason: 'Appeal accepted' });
  ledger({ server: 'instellar1', type: 'warn', player_name: 'iron_ivy', reason: 'Toxicity', staff_name: 'Rin M.', created_at: ago(40 * D), active: false });
  ledger({ server: 'instellar1', type: 'ban', player_name: 'blocky_bill', reason: 'Doxing / DDoSing', staff_name: 'qav45', created_at: ago(9 * D), active: true, silent: true });
  ledger({ server: 'instellar2', type: 'ban', player_name: 'Kestrel99', reason: 'Exploiting / Bug abuse', staff_name: 'Lia', created_at: ago(11 * D), active: true });
  punishments.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });

  var presence = [];
  players.forEach(function (p, i) {
    var online = i % 3 !== 0;
    presence.push({ uuid: 'p-' + i + '-0000-4000-8000-000000000' + (100 + i), name: p, server: i % 5 === 4 ? 'instellar2' : 'instellar1', last_seen: online ? ago(20000) : ago((i + 1) * 3 * H) });
  });

  M.db = {
    staff: staff,
    mod_actions: actions,
    punishments: punishments,
    player_notes: [
      { id: 1, server: 'instellar1', target: 'Sn0wF0x_', text: 'Second account of xX_grief_Xx? Watch for cheating.', by_id: 'u-ash', by_name: 'Ash Vellum', created_at: ago(3 * D) },
      { id: 2, server: 'instellar1', target: 'Sn0wF0x_', text: 'Warned in Discord too.', by_id: 'u-kai', by_name: 'Kai F.', created_at: ago(2 * H) },
      { id: 3, server: 'instellar1', target: 'brickbybrick', text: 'Nice player, sometimes spammy.', by_id: 'u-rin', by_name: 'Rin M.', created_at: ago(5 * D) }
    ],
    player_presence: presence,
    staff_logs: [
      { id: 1, server: 'instellar1', what: 'Cleared the spawn area of griefing blocks', why: 'Players reported lag near spawn', after: 'Spawn is clean, no more lag', by_id: 'u-kai', by_name: 'Kai F.', status: 'Approved', created_at: ago(1 * D) },
      { id: 2, server: 'instellar1', what: 'Talked to Nova_Tide about chat rules', why: 'Two reports of toxic language', after: 'They apologised, no punishment yet', by_id: 'u-rin', by_name: 'Rin M.', status: 'Pending', created_at: ago(3 * H) }
    ],
    guides: [
      { id: 1, server: 'instellar1', title: 'Handling appeals', body: 'Read the appeal fully.\nCheck the proof on the original punishment.\nAsk an Admin before unbanning permanent bans.\nReply in the ticket, not in public chat.', by_id: 'u-ash', by_name: 'Ash Vellum', created_at: ago(20 * D) },
      { id: 2, server: 'instellar1', title: 'Discord etiquette', body: 'Keep staff chat professional. No screenshots of the panel outside the staff server.', by_id: 'u-arcade', by_name: 'ArcadeAsh', created_at: ago(9 * D) }
    ],
    announcements: [
      { id: 1, server: 'instellar1', body: 'Season 4 starts Friday — expect a lot of new players, be patient with first-timers.', by_id: 'u-ash', by_name: 'Ash Vellum', created_at: ago(5 * H) },
      { id: 2, server: 'instellar1', body: 'Reminder: attach proof to every ban.', by_id: 'u-qav45', by_name: 'qav45', created_at: ago(2 * D) }
    ],
    punishment_blacklist: [
      { id: 1, name: 'Instellar_Dev', by_id: 'u-qav45', by_name: 'qav45', created_at: ago(30 * D) },
      { id: 2, name: 'Sky_Vale', by_id: 'u-ash', by_name: 'Ash Vellum', created_at: ago(12 * D) }
    ],
    punish_templates: [
      { id: 1, server: 'instellar1', name: 'AFK farming', type: 'Warn', steps: ['Warn'], note: 'Warn first, kick if they keep doing it.', by_id: 'u-ash', by_name: 'Ash Vellum', created_at: ago(15 * D) },
      { id: 2, server: 'instellar1', name: 'Griefing builds', type: 'Ban', steps: ['3 days', '14 days', 'Permanent'], note: null, by_id: 'u-arcade', by_name: 'ArcadeAsh', created_at: ago(8 * D) }
    ],
    protected_players: [
      { id: 1, name: 'Nova_Tide', name_lc: 'nova_tide', reason: 'Content creator', blocks: ['Ban', 'Wipeban'], added_by: 'u-qav45', added_by_name: 'qav45', expires_at: null, created_at: ago(20 * D) },
      { id: 2, name: 'brickbybrick', name_lc: 'brickbybrick', reason: "Owner's alt", blocks: ['Ban', 'Wipeban', 'Mute', 'Kick'], added_by: 'u-qav45', added_by_name: 'qav45', expires_at: null, created_at: ago(60 * D) },
      { id: 3, name: 'pixelpaws', name_lc: 'pixelpaws', reason: "Under investigation — don't touch", blocks: ['Ban', 'Wipeban'], added_by: 'u-qav45', added_by_name: 'qav45', expires_at: ago(-13 * D), created_at: ago(2 * D) },
      { id: 4, name: 'Sky_Vale', name_lc: 'sky_vale', reason: 'Staff test account', blocks: ['Ban', 'Wipeban', 'Kick'], added_by: 'u-qav45', added_by_name: 'qav45', expires_at: null, created_at: ago(40 * D) }
    ],
    protection_blocks: [
      { id: 1, target: 'Nova_Tide', type: 'Ban', reason: 'Cheating / Hacking', by_id: 'u-rin', by_name: 'Rin M.', server: 'instellar1', created_at: ago(2 * H) },
      { id: 2, target: 'brickbybrick', type: 'Mute', reason: 'Spamming', by_id: 'u-milo', by_name: 'Milo T.', server: 'instellar1', created_at: ago(1 * D) },
      { id: 3, target: 'Sky_Vale', type: 'Kick', reason: 'Testing', by_id: 'u-jun', by_name: 'Jun K.', server: 'instellar2', created_at: ago(3 * D) }
    ],
    staff_audit: [
      { id: 1, staff_id: 'u-kai', username: 'kai.mod', display_name: 'Kai F.', action: 'role_changed', old_role: 'Jr Moderator', new_role: 'Moderator', old_perms: ['Mute', 'Kick', 'Warn'], new_perms: ['Ban', 'Mute', 'Kick', 'Warn'], server: 'instellar1', by_id: 'u-ash', by_name: 'Ash Vellum', created_at: ago(3 * H) },
      { id: 2, staff_id: 'u-pixel', username: 'pixel.fern', display_name: 'Pixel_Fern', action: 'invited', old_role: null, new_role: 'Trainee', old_perms: null, new_perms: ['Mute', 'Kick'], server: 'instellar1', by_id: 'u-qav45', by_name: 'qav45', created_at: ago(10 * D) },
      { id: 3, staff_id: 'u-nova', username: 'nova.hex', display_name: 'Nova_Hex', action: 'perms_changed', old_role: 'Moderator', new_role: 'Moderator', old_perms: ['Ban', 'Mute', 'Kick', 'Warn'], new_perms: ['Ban', 'Mute', 'Kick', 'Warn', 'Guides'], server: 'instellar1', by_id: 'u-ash', by_name: 'Ash Vellum', created_at: ago(1 * D) },
      { id: 4, staff_id: 'u-gone', username: 'toby.r', display_name: 'Toby_R', action: 'removed', old_role: 'Helper', new_role: null, old_perms: ['Mute'], new_perms: null, server: 'instellar1', by_id: 'u-qav45', by_name: 'qav45', created_at: ago(2 * D) }
    ],
    server_status: [
      { server: 'instellar1', last_seen: ago(12000), players_online: 12, tps: 19.9 },
      { server: 'instellar2', last_seen: ago(4 * 60000), players_online: 4, tps: 19.6 }
    ]
  };
  M.NOW = NOW;
})();
