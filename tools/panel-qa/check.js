#!/usr/bin/env node
/* check.js — static QA checker for the Instellar panel (no deps).
   usage: node check.js [panelDir]        (default: ../../panel relative to this file)
   Prints FAIL/WARN lines as file:line: message, a summary, exits 1 on any FAIL.
   Skips panel/legacy/ and panel/vendor/. Robust to missing / placeholder screens. */
'use strict';
var fs = require('fs'), path = require('path'), cp = require('child_process');

var PANEL = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'panel'));
var SKIP_DIRS = ['legacy', 'vendor', 'node_modules', '.git'];
var DATAISH = /\.(target|reason|by_name|display_name|username|name|body|text|error|note|what|why|after|title)\b/g;
var SAFE_WRAPPERS = ['esc', 'P.esc', 'P.avatar', 'P.typePill', 'P.statusPill', 'P.rolePill', 'P.proofLinks', 'P.timeAgo',
  'P.fmtDate', 'P.serverName', 'P.safeUrl', 'Number', 'String', 'encodeURIComponent', 'P.pct'];
var GLOBAL_ACTIONS = ['logout']; // handled by shell/core, not by a screen

var fails = [], warns = [], infos = [];
function rel(f) { return path.relative(PANEL, f).split(path.sep).join('/'); }
function fail(file, line, msg) { fails.push(rel(file) + ':' + line + ': ' + msg); }
function warn(file, line, msg) { warns.push(rel(file) + ':' + line + ': ' + msg); }
function info(msg) { infos.push(msg); }

/* ------------------------------------------------------------------ files */
function walk(dir, out) {
  var ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  ents.forEach(function (d) {
    var p = path.join(dir, d.name);
    if (d.isDirectory()) { if (SKIP_DIRS.indexOf(d.name) < 0) walk(p, out); }
    else if (/\.(js|css)$/.test(d.name) || (d.name === 'index.html' && path.dirname(p) === PANEL)) out.push(p);
  });
  return out;
}
if (!fs.existsSync(PANEL)) { console.error('panel dir not found: ' + PANEL); process.exit(2); }
var files = walk(PANEL, []).sort();
var jsFiles = files.filter(function (f) { return /\.js$/.test(f); });
var cssFiles = files.filter(function (f) { return /\.css$/.test(f); });
var htmlFiles = files.filter(function (f) { return /\.html$/.test(f); });
var screenFiles = jsFiles.filter(function (f) { return /[\\/]js[\\/](screens[\\/][^\\/]+|punish|shell)\.js$/.test(f); });
var src = {}; files.forEach(function (f) { src[f] = fs.readFileSync(f, 'utf8'); });

function lineIndex(text) { var idx = [0]; for (var i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) idx.push(i + 1); return idx; }
function lineOf(idx, off) { var lo = 0, hi = idx.length - 1; while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (idx[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; }

/* ------------------------------------------------------------ JS tokenizer
   Emits segments in file order:
     {kind:'code'|'comment'|'regex', text, start}
     {kind:'str', text, start}                  '..' or ".." literal (content, unescaped-ish)
     {kind:'tpl', text, start, tplId, depth}    text chunk of a template literal
     {kind:'expr', text, flat, start, tplId}    ${...} source (flat = nested templates blanked)
   Nested template literals inside ${} are tokenized too (their chunks/exprs are emitted). */
function tokenize(text) {
  var segs = [], i = 0, n = text.length, codeStart = 0, tplCounter = 0;
  var tplHtmlish = {}; // tplId -> bool (any text chunk contains a tag)
  function flushCode(end) { if (end > codeStart) segs.push({ kind: 'code', text: text.slice(codeStart, end), start: codeStart }); }
  function lastSig(pos) { // last significant char before pos (skipping whitespace)
    var j = pos - 1; while (j >= 0 && /\s/.test(text[j])) j--; return j >= 0 ? text[j] : '';
  }
  function regexAllowed(pos) {
    var c = lastSig(pos);
    if (c === '' || '(,=:[!&|?{};+-*%<>~^'.indexOf(c) > -1) return true;
    var m = /(return|typeof|case|do|else|in|of|instanceof|new|delete|void|throw)\s*$/.exec(text.slice(Math.max(0, pos - 12), pos));
    return !!m;
  }
  function scanString(pos, q) { // returns end index (after closing quote)
    var j = pos + 1;
    while (j < n) { var c = text[j]; if (c === '\\') { j += 2; continue; } if (c === q || c === '\n') { j++; break; } j++; }
    return j;
  }
  function scanTemplate(pos, depth) { // pos at backtick; returns end index (after closing backtick)
    var id = ++tplCounter, j = pos + 1, chunkStart = j;
    while (j < n) {
      var c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { pushChunk(chunkStart, j); return j + 1; }
      if (c === '$' && text[j + 1] === '{') {
        pushChunk(chunkStart, j);
        var exprStart = j + 2, r = scanExpr(exprStart, depth + 1);
        segs.push({ kind: 'expr', text: text.slice(exprStart, r.end), flat: r.flat, start: exprStart, tplId: id });
        j = r.end + 1; chunkStart = j; continue;
      }
      j++;
    }
    pushChunk(chunkStart, j); return j;
    function pushChunk(a, b) {
      var t = text.slice(a, b);
      segs.push({ kind: 'tpl', text: t, start: a, tplId: id, depth: depth });
      if (/<[a-zA-Z\/!]/.test(t)) tplHtmlish[id] = true;
    }
  }
  function scanExpr(pos, depth) { // scans until matching '}' ; returns {end, flat}
    var j = pos, level = 0, flat = '';
    while (j < n) {
      var c = text[j], c2 = text[j + 1];
      if (c === '/' && c2 === '/') { var e = text.indexOf('\n', j); if (e < 0) e = n; j = e; continue; }
      if (c === '/' && c2 === '*') { var e2 = text.indexOf('*/', j + 2); j = e2 < 0 ? n : e2 + 2; continue; }
      if (c === '"' || c === "'") { var se = scanString(j, c); segs.push({ kind: 'str', text: text.slice(j + 1, se - 1), start: j + 1 }); flat += text.slice(j, se); j = se; continue; }
      if (c === '`') { var te = scanTemplate(j, depth); flat += '`~`'; j = te; continue; }
      if (c === '{') level++;
      else if (c === '}') { if (level === 0) return { end: j, flat: flat }; level--; }
      flat += c; j++;
    }
    return { end: j, flat: flat };
  }
  while (i < n) {
    var c = text[i], c2 = text[i + 1];
    if (c === '/' && c2 === '/') { flushCode(i); var e = text.indexOf('\n', i); if (e < 0) e = n; segs.push({ kind: 'comment', text: text.slice(i, e), start: i }); i = e; codeStart = i; continue; }
    if (c === '/' && c2 === '*') { flushCode(i); var e2 = text.indexOf('*/', i + 2); e2 = e2 < 0 ? n : e2 + 2; segs.push({ kind: 'comment', text: text.slice(i, e2), start: i }); i = e2; codeStart = i; continue; }
    if (c === '"' || c === "'") { flushCode(i); var se = scanString(i, c); segs.push({ kind: 'str', text: text.slice(i + 1, se - 1), start: i + 1 }); i = se; codeStart = i; continue; }
    if (c === '`') { flushCode(i); var te = scanTemplate(i, 0); i = te; codeStart = i; continue; }
    if (c === '/' && regexAllowed(i)) {
      var j = i + 1, inClass = false;
      while (j < n) { var d = text[j]; if (d === '\\') { j += 2; continue; } if (d === '\n') break; if (inClass) { if (d === ']') inClass = false; } else if (d === '[') inClass = true; else if (d === '/') { j++; break; } j++; }
      while (j < n && /[a-z]/i.test(text[j])) j++;
      flushCode(i); segs.push({ kind: 'regex', text: text.slice(i, j), start: i }); i = j; codeStart = i; continue;
    }
    i++;
  }
  flushCode(n);
  segs.forEach(function (s) { if (s.kind === 'expr' || s.kind === 'tpl') s.htmlish = !!tplHtmlish[s.tplId]; });
  return segs;
}

/* Joined "string stream" of a JS file: all str/tpl chunk texts in order, exprs replaced by \u0001,
   with an offset map back to file positions. */
function joinStrings(segs) {
  var out = '', map = [];
  segs.forEach(function (s) {
    if (s.kind === 'str' || s.kind === 'tpl') { map.push({ j: out.length, len: s.text.length, f: s.start }); out += s.text; }
    else if (s.kind === 'expr') { map.push({ j: out.length, len: 1, f: s.start }); out += '\u0001'; }
  });
  return { text: out, map: map };
}
function joinedToFile(joined, off) {
  var m = joined.map, lo = 0, hi = m.length - 1;
  while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (m[mid].j <= off) lo = mid; else hi = mid - 1; }
  if (!m.length) return 0;
  var e = m[lo]; return e.f + Math.min(off - e.j, Math.max(e.len - 1, 0));
}

/* per-file analysis cache */
var analysis = {};
jsFiles.forEach(function (f) {
  var text = src[f], segs = tokenize(text), joined = joinStrings(segs);
  analysis[f] = { text: text, segs: segs, joined: joined, lines: lineIndex(text), kind: 'js' };
});
htmlFiles.forEach(function (f) {
  var text = src[f];
  // html: whole document is "string" material; also tokenize inline <script> bodies as JS
  var map = [{ j: 0, len: text.length, f: 0 }];
  var segs = [], re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi, m;
  while ((m = re.exec(text))) { var off = m.index + m[0].indexOf(m[1]); tokenize(m[1]).forEach(function (s) { s.start += off; segs.push(s); }); }
  analysis[f] = { text: text, segs: segs, joined: { text: text, map: map }, lines: lineIndex(text), kind: 'html' };
});
function lineAtJoined(f, off) { var a = analysis[f]; return lineOf(a.lines, joinedToFile(a.joined, off)); }
function lineAt(f, off) { return lineOf(analysis[f].lines, off); }

/* ------------------------------------------------------ 1. <button type= */
Object.keys(analysis).forEach(function (f) {
  var j = analysis[f].joined.text, re = /<button(?=[\s>\/\u0001])/g, m;
  while ((m = re.exec(j))) {
    var close = j.indexOf('>', m.index);
    var tag = j.slice(m.index, close < 0 || close - m.index > 600 ? m.index + 600 : close + 1);
    if (!/\btype\s*=/.test(tag)) fail(f, lineAtJoined(f, m.index), '<button> without type= : ' + preview(tag));
  }
});
function preview(s) { s = s.replace(/\u0001/g, '${…}').replace(/\s+/g, ' ').trim(); return s.length > 90 ? s.slice(0, 90) + '…' : s; }

/* ---------------------------------------- 2. data-action handled in file */
function countQuoted(text, name) {
  var esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var q = (text.match(new RegExp("(['\"])" + esc + "\\1", 'g')) || []).length;
  var key = new RegExp("[{,\\n]\\s*(?:['\"]?)" + esc + "(?:['\"]?)\\s*:", 'g').test(text);
  var caseK = new RegExp("\\bcase\\s*['\"]" + esc + "['\"]").test(text);
  return { quoted: q, objKey: key, caseK: caseK };
}
screenFiles.forEach(function (f) {
  var a = analysis[f], j = a.joined.text, re = /data-(action|enter)=("|')([^"'\u0001]*)(\u0001?)[^"']*\2/g, m, seen = {};
  var generic = /\w+\s*\[\s*(action|a|act|name)\s*\]/.test(a.text) || /\[action\]/.test(a.text);
  var hasOnAction = /\bonAction\s*[:(=]/.test(a.text);
  while ((m = re.exec(j))) {
    var name = m[3], dyn = !!m[4] || name === '';
    if (dyn) { if (!name) continue; // fully dynamic
      // prefix-style: data-action="del:${id}" -> handled if 'del:' or the prefix appears elsewhere
      var pre = name.replace(/[:\-_]$/, '');
      var c0 = countQuoted(a.text, name), c1 = countQuoted(a.text, pre);
      if (c0.quoted + c1.quoted < 2 && !c0.objKey && !c1.objKey && !new RegExp("indexOf\\(['\"]" + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(a.text) && !new RegExp("startsWith\\(['\"]" + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(a.text))
        warn(f, lineAtJoined(f, m.index), 'dynamic data-action="' + name + '${…}" — no visible prefix handling (' + pre + ')');
      continue;
    }
    if (seen[name]) continue; seen[name] = 1;
    if (GLOBAL_ACTIONS.indexOf(name) > -1) continue;
    var c = countQuoted(a.text, name);
    var handled = c.quoted >= 2 || c.objKey || c.caseK;
    if (!handled) {
      var msg = 'data-action="' + name + '" not visibly handled in this file (quoted refs=' + c.quoted + (hasOnAction ? '' : ', no onAction found') + ')';
      if (generic) warn(f, lineAtJoined(f, m.index), msg + ' [generic dispatcher present]');
      else fail(f, lineAtJoined(f, m.index), msg);
    }
  }
});

/* --------------------------------------------- 3. data-goto -> screen key */
var screenKeys = {};
jsFiles.forEach(function (f) {
  var re = /P\.registerScreen\(\s*(['"])([^'"]+)\1/g, m;
  while ((m = re.exec(src[f]))) screenKeys[m[2]] = rel(f);
  // P.registerScreen(KEY, ...) where KEY is a const/var in the same file
  var rv = /P\.registerScreen\(\s*([A-Za-z_$][\w$]*)\s*,/g;
  while ((m = rv.exec(src[f]))) {
    var dm = new RegExp('\\b' + m[1] + "\\s*=\\s*(['\"])([^'\"]+)\\1").exec(src[f]);
    if (dm) screenKeys[dm[2]] = rel(f); else warn(f, lineOf(lineIndex(src[f]), m.index), 'P.registerScreen(' + m[1] + ') — could not resolve key');
  }
});
info('registered screens: ' + Object.keys(screenKeys).join(', '));
Object.keys(analysis).forEach(function (f) {
  var j = analysis[f].joined.text, re = /data-goto=("|')([^"']*)\1/g, m;
  while ((m = re.exec(j))) {
    var v = m[2], key = v.split('/')[0];
    if (!key || key.indexOf('\u0001') > -1) continue; // dynamic
    if (key.indexOf('#') === 0) key = key.slice(1);
    if (!screenKeys[key]) fail(f, lineAtJoined(f, m.index), 'data-goto="' + preview(v) + '" targets unregistered screen "' + key + '"');
  }
});

/* --------------------------------- 4. ${...} data-ish must be esc()-wrapped */
function localSafe(f) { // functions in this file that are thin esc() wrappers, e.g. function nl2br(t){return esc(t).replace(...)}
  if (analysis[f].localSafe) return analysis[f].localSafe;
  var out = [], t = analysis[f].text, m;
  var r1 = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*return\s+(?:P\.)?esc\(/g; while ((m = r1.exec(t))) out.push(m[1]);
  var r2 = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function\s*\([^)]*\)\s*\{\s*return\s+|\([^)]*\)\s*=>\s*\{?\s*(?:return\s+)?)(?:P\.)?esc\(/g; while ((m = r2.exec(t))) out.push(m[1]);
  var r3 = /([A-Za-z_$][\w$]*)\s*=\s*(?:P\.)?esc\s*[;,)]/g; while ((m = r3.exec(t))) out.push(m[1]); // var esc = P.esc; var e = P.esc
  return (analysis[f].localSafe = out);
}
function safeAt(exprText, pos, extra) { // is position pos inside an open call to a safe wrapper?
  var stack = [], i = 0; extra = extra || [];
  while (i < pos) {
    var c = exprText[i];
    if (c === '"' || c === "'" || c === '`') { var q = c; i++; while (i < pos && exprText[i] !== q) { if (exprText[i] === '\\') i++; i++; } i++; continue; }
    if (c === '(') { var m = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/.exec(exprText.slice(0, i)); stack.push(m ? m[1] : ''); }
    else if (c === ')') stack.pop();
    i++;
  }
  return stack.some(function (name) { return SAFE_WRAPPERS.indexOf(name) > -1 || extra.indexOf(name) > -1 || /(^|\.)esc$/.test(name); });
}
Object.keys(analysis).forEach(function (f) {
  analysis[f].segs.forEach(function (s) {
    if (s.kind !== 'expr' || !s.htmlish) return;
    var flat = s.flat, m; DATAISH.lastIndex = 0;
    while ((m = DATAISH.exec(flat))) {
      // ignore method-ish uses that are not data: .name( , .length after, comparisons handled by wrapper check
      if (flat[m.index + m[0].length] === '(') continue;
      if (/\.(length|trim|toLowerCase|toUpperCase|slice|split|indexOf|replace|match)\b/.test(flat.slice(m.index + m[0].length, m.index + m[0].length + 14))) continue;
      if (!safeAt(flat, m.index, localSafe(f))) { fail(f, lineAt(f, s.start), 'unescaped ${…} with data field: ${' + preview(s.text) + '}'); break; }
    }
  });
});
/* 4b. '...' + x.name + '...' concatenation (warning only) */
Object.keys(analysis).forEach(function (f) {
  var segs = analysis[f].segs;
  for (var i = 1; i < segs.length - 1; i++) {
    var s = segs[i]; if (s.kind !== 'code') continue;
    var prev = segs[i - 1], next = segs[i + 1];
    if (!(prev.kind === 'str' || prev.kind === 'tpl') || !(next.kind === 'str' || next.kind === 'tpl')) continue;
    var t = s.text.trim(); if (!/^\+/.test(t) || !/\+$/.test(t)) continue;
    if (!/[<>=]/.test(prev.text)) continue; // previous string is not html-ish
    var body = t.slice(1, -1), m; DATAISH.lastIndex = 0;
    while ((m = DATAISH.exec(body))) {
      if (body[m.index + m[0].length] === '(') continue;
      if (/\.(length|trim|toLowerCase|toUpperCase|slice|split|indexOf|replace|match)\b/.test(body.slice(m.index + m[0].length, m.index + m[0].length + 14))) continue;
      if (!safeAt(body, m.index, localSafe(f))) { warn(f, lineAt(f, s.start), 'possibly unescaped concatenation: ' + preview(t)); break; }
    }
  }
});

/* -------------------------- 5. banned patterns (css / html / js) */
function stripComments(text, kind) {
  // replace comment bodies with spaces (keeps offsets)
  var out = text;
  if (kind === 'css') out = out.replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); });
  if (kind === 'html') out = out.replace(/<!--[\s\S]*?-->/g, function (m) { return m.replace(/[^\n]/g, ' '); });
  return out;
}
cssFiles.forEach(function (f) {
  var t = stripComments(src[f], 'css'), li = lineIndex(t), m;
  var re = /100vh\b/g; while ((m = re.exec(t))) fail(f, lineOf(li, m.index), '100vh — use 100dvh');
  var ur = /https?:\/\/[^\s"')]+/g;
  while ((m = ur.exec(t))) { if (/www\.w3\.org\//.test(m[0])) continue; if (/data:[^"')]*$/.test(t.slice(Math.max(0, m.index - 300), m.index))) continue; fail(f, lineOf(li, m.index), 'external URL in css: ' + m[0]); }
});
htmlFiles.forEach(function (f) {
  var t = stripComments(src[f], 'html'), li = lineIndex(t), m;
  var ur = /https?:\/\/[^\s"'<>)]+/g;
  while ((m = ur.exec(t))) { if (/www\.w3\.org\//.test(m[0])) continue; if (/data:[^"')]*$/.test(t.slice(Math.max(0, m.index - 300), m.index))) continue; fail(f, lineOf(li, m.index), 'external URL in html: ' + m[0]); }
  var ir = /\bon(click|input|change|keyup|keydown|keypress|submit|load|focus|blur|mouseover)\s*=/gi;
  while ((m = ir.exec(t))) fail(f, lineOf(li, m.index), 'inline handler ' + m[0].trim());
  var dw = /document\.write\s*\(/g; while ((m = dw.exec(t))) fail(f, lineOf(li, m.index), 'document.write');
  var ev = /\beval\s*\(/g; while ((m = ev.exec(t))) fail(f, lineOf(li, m.index), 'eval(');
  var vh = /100vh\b/g; while ((m = vh.exec(t))) fail(f, lineOf(li, m.index), '100vh — use 100dvh');
});
jsFiles.forEach(function (f) {
  var a = analysis[f];
  a.segs.forEach(function (s) {
    if (s.kind === 'comment' || s.kind === 'regex') return;
    var t = s.text, m;
    if (s.kind === 'str' || s.kind === 'tpl') {
      var ir = /\bon(click|input|change|keyup|keydown|keypress|submit|load|focus|blur|mouseover)\s*=/gi;
      while ((m = ir.exec(t))) fail(f, lineAt(f, s.start + m.index), 'inline handler in string: ' + m[0].trim());
      var vh = /100vh\b/g; while ((m = vh.exec(t))) fail(f, lineAt(f, s.start + m.index), '100vh in js string — use 100dvh');
    } else if (s.kind === 'code' || s.kind === 'expr') {
      var ir2 = /\.on(click|input|change|keyup|keydown|submit)\s*=[^=]/g;
      while ((m = ir2.exec(t))) fail(f, lineAt(f, s.start + m.index), 'inline handler assignment ' + m[0].trim());
      var dw = /document\.write\s*\(/g; while ((m = dw.exec(t))) fail(f, lineAt(f, s.start + m.index), 'document.write');
      var ev = /\beval\s*\(/g; while ((m = ev.exec(t))) fail(f, lineAt(f, s.start + m.index), 'eval(');
      var nf = /new\s+Function\s*\(/g; while ((m = nf.exec(t))) fail(f, lineAt(f, s.start + m.index), 'new Function(');
    }
  });
});

/* ------------------------------------------- 6. duplicate id= (warn) */
(function () {
  var seen = {};
  screenFiles.concat(htmlFiles).forEach(function (f) {
    var j = analysis[f].joined.text, re = /\bid=("|')([^"'\u0001]+)\1/g, m;
    while ((m = re.exec(j))) {
      var id = m[2], line = lineAtJoined(f, m.index), where = rel(f) + ':' + line;
      if (!seen[id]) seen[id] = []; seen[id].push(where);
    }
  });
  Object.keys(seen).forEach(function (id) {
    var locs = seen[id]; if (locs.length < 2) return;
    // duplicates within the same html file at different lines are also suspicious; ids in js screens vs index.html too
    var w = locs[0].split(':'); warn(path.join(PANEL, w[0]), w[1], 'duplicate id="' + id + '" also at ' + locs.slice(1).join(', '));
  });
})();

/* ------------------------------------------- 7. contrast --gl-ink-3/-4 */
(function () {
  var f = path.join(PANEL, 'css', 'app.css');
  var css = src[f] || (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  if (!css) { warn(f, 1, 'css/app.css missing — contrast check skipped'); return; }
  var stripped = stripComments(css, 'css'), li = lineIndex(stripped);
  function lum(rgb) { var a = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; }
  var bg = [0x0f, 0x0f, 0x13], Lbg = lum(bg);
  ['--gl-ink-3', '--gl-ink-4'].forEach(function (name) {
    var re = new RegExp(name + '\\s*:\\s*rgba?\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*(?:,\\s*([\\d.]+))?\\s*\\)', 'g'), m, found = false;
    while ((m = re.exec(stripped))) {
      found = true;
      var a = m[4] === undefined ? 1 : parseFloat(m[4]), fg = [+m[1], +m[2], +m[3]];
      var comp = fg.map(function (v, i) { return a * v + (1 - a) * bg[i]; });
      var L1 = lum(comp), ratio = (Math.max(L1, Lbg) + 0.05) / (Math.min(L1, Lbg) + 0.05);
      var line = lineOf(li, m.index), txt = name + ' = ' + m[0].slice(m[0].indexOf(':') + 1).trim() + ' on #0f0f13 -> ' + ratio.toFixed(2) + ':1';
      if (ratio < 4.5) fail(f, line, 'contrast too low: ' + txt); else info('contrast ok: ' + txt);
    }
    if (!found) warn(f, 1, name + ' not defined as rgb/rgba in css/app.css — contrast not computed');
  });
})();

/* ------------------------------------------- 8. node --check */
jsFiles.forEach(function (f) {
  var r = cp.spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    var err = (r.stderr || '').split('\n').filter(Boolean);
    var lm = /:(\d+)/.exec(err[0] || ''), line = lm ? +lm[1] : 1;
    fail(f, line, 'node --check failed: ' + (err.slice(0, 4).join(' | ') || 'unknown').slice(0, 300));
  }
});

/* ------------------------------------------- report */
var placeholders = screenFiles.filter(function (f) { return /Placeholder|Coming up/.test(src[f]) && src[f].length < 600; }).map(rel);
if (placeholders.length) info('placeholder screens (tiny files): ' + placeholders.join(', '));
info('checked ' + jsFiles.length + ' js, ' + cssFiles.length + ' css, ' + htmlFiles.length + ' html under ' + PANEL);

fails.sort().forEach(function (l) { console.log('FAIL ' + l); });
warns.sort().forEach(function (l) { console.log('WARN ' + l); });
infos.forEach(function (l) { console.log('info ' + l); });
console.log('\n' + fails.length + ' failure(s), ' + warns.length + ' warning(s)');
process.exit(fails.length ? 1 : 0);
