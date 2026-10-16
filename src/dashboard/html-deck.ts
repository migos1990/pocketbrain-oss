// SPDX-License-Identifier: AGPL-3.0-only
// The decision deck page: one card at a time, swiped or tapped, phone first. Standalone document
// (own style and one inline script), no framework, no external resource. Cards are rendered by the
// server as real forms, so every choice works without script; the script adds the swipe, the
// fetch-and-advance, the auto deadline in local time and the undo link.
import type { DeckView, Card, Choice, AutoDone } from "./deck-types";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Direction "Message", the same tokens as the hub (src/dashboard/html.ts): warm greys, one column,
// type carries the hierarchy. The accent is for links, text buttons and focus only; good and bad
// mean state, and show only on the drag cue while a swipe is under way. Every text pairing below
// passes 4.5:1 on its background in both schemes.
const LIGHT = "--bg:#ffffff;--well:#f7f7f5;--hover:#efefed;--line:#e9e9e7;--line-strong:#d3d3d0;--text:#1f1f1e;--text-2:#5f5e5b;--muted:#71706c;--accent:#2a62d4;--accent-text:#1a6dc0;--good:#236b3d;--warn:#9a5b00;--bad:#c2332d;";
const DARK = "--bg:#191919;--well:#202020;--hover:#2a2a2a;--line:#2e2e2e;--line-strong:#444443;--text:#ededec;--text-2:#a6a5a1;--muted:#9b9a96;--accent:#6f9cf0;--accent-text:#6f9cf0;--good:#5db37c;--warn:#d9a246;--bad:#f07f78;";
const FONT = 'ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI","Helvetica Neue",Helvetica,sans-serif';

const CSS = `
:root{color-scheme:light;${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${DARK}}}
:root[data-theme="dark"]{color-scheme:dark;${DARK}}
*{box-sizing:border-box}
html{height:100%;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:17px/28px ${FONT};-webkit-font-smoothing:antialiased;letter-spacing:-0.004em;font-feature-settings:"kern","liga";min-height:100%;overflow-x:clip;overscroll-behavior-y:contain}
a{color:var(--accent-text);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}
b{font-weight:600}
.num{font-variant-numeric:tabular-nums}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wrap{max-width:680px;margin:0 auto;padding:0 max(20px,env(safe-area-inset-left)) max(32px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-right))}
.top{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding-top:calc(12px + env(safe-area-inset-top));font-size:15px;line-height:24px;color:var(--text-2)}
.top a{color:var(--text-2);display:inline-block;padding:10px 0}.top a:hover{color:var(--text);text-decoration:none}
.top .left{font-weight:500;color:var(--text);padding:10px 0}.top .left.zero{color:var(--muted);font-weight:400}
.bar{height:2px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;width:0;background:var(--muted);transition:width .2s}
.stats{display:flex;gap:4px 20px;flex-wrap:wrap;color:var(--muted);font-size:15px;line-height:24px;margin:12px 0 24px}
.stats b{font-weight:500;color:var(--text-2)}
.wrap:has(.stage.off) .stats{display:none}
.flash{display:flex;gap:4px 24px;align-items:baseline;justify-content:space-between;flex-wrap:wrap;padding:0 0 16px;border-bottom:1px solid var(--line);margin:0 0 24px;color:var(--text)}
.flash.err{color:var(--bad)}.flash.off{display:none}
.flash button{font:inherit;font-size:15px;line-height:24px;font-weight:500;color:var(--accent-text);background:none;border:0;padding:10px 0;margin:-10px 0;cursor:pointer;white-space:nowrap}
.flash button:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}.flash button:disabled{opacity:.4;cursor:default;text-decoration:none}
.stage{position:relative;height:clamp(480px,72vh,700px);margin-bottom:12px}
.stage.off{display:none}
.card{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line-strong);border-radius:8px;padding:20px;touch-action:none;user-select:none;-webkit-user-select:none;transform-origin:50% 100%;will-change:transform}
.card.c0{z-index:3}.card.c1{z-index:2;transform:translateY(8px) scale(.97);pointer-events:none;border-color:var(--line)}.card.cn{display:none}
.card.c1>*{visibility:hidden}
.card.anim{transition:transform .18s ease-out,opacity .18s ease-out}
.card.c0.anim{transition:transform .18s ease-out}
.card.out{opacity:0;pointer-events:none}
.card.drag{cursor:grabbing}
.card-top{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:4px;min-height:24px;font-size:15px;line-height:24px;transition:opacity .12s}.card.drag .card-top{opacity:0}
.tag{color:var(--muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-top a{flex:none;padding:10px 0;margin:-10px 0}
.q{font-size:22px;line-height:32px;font-weight:500;letter-spacing:-0.01em;margin:0 0 8px;overflow-wrap:anywhere}
.auto,.never{color:var(--muted);margin:0 0 8px}
.hair{height:2px;background:var(--line);margin:0 0 12px;overflow:hidden}.hair i{display:block;height:100%;width:100%;background:var(--muted)}
.lines{flex:1;min-height:0;overflow-y:auto;-webkit-mask-image:linear-gradient(#000 calc(100% - 28px),transparent);mask-image:linear-gradient(#000 calc(100% - 28px),transparent);padding-bottom:20px;touch-action:pan-y;user-select:text;-webkit-user-select:text;margin-top:4px;-webkit-overflow-scrolling:touch;scrollbar-width:thin}
.line{display:grid;grid-template-columns:minmax(96px,30%) minmax(0,1fr);gap:0 16px;padding:8px 0;border-bottom:1px solid var(--line)}
.line:first-child{border-top:1px solid var(--line)}.hair+.lines .line:first-child{border-top:0}
.line .l{color:var(--text-2)}.line .v{overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.line .m{grid-column:2;color:var(--muted);font-size:15px;line-height:24px}
.line.quote{display:block}
.line.quote .v{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;color:var(--muted);border-left:2px solid var(--line-strong);padding-left:12px;font-variant-numeric:normal}
.hidden{color:var(--muted);margin:0;padding:8px 0}
.acts{display:grid;grid-template-columns:1fr 1fr;gap:0 16px;align-items:center;margin-top:12px}
.acts form{display:contents}
.acts .btn{display:inline-flex;align-items:flex-start;gap:8px;font:inherit;font-weight:500;line-height:24px;min-height:44px;padding:10px 0;border:0;background:none;color:var(--accent-text);cursor:pointer;text-decoration:none;text-align:left;overflow-wrap:anywhere;max-width:100%}
.acts .btn:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.acts .btn .k{color:var(--muted);font-weight:400}
.acts .btn.more{grid-column:1/-1;font-weight:400}
.cue{position:absolute;top:20px;font-weight:500;line-height:24px;padding:0;opacity:0;pointer-events:none;background:var(--bg);max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cue.r{left:20px}.cue.l{right:20px}.cue.u{top:auto;bottom:88px;left:50%;transform:translateX(-50%)}
.cue.good{color:var(--good)}.cue.bad{color:var(--bad)}.cue.neutral{color:var(--text)}
.hint{color:var(--muted);font-size:15px;line-height:24px;margin:0}
.empty{padding:40px 0 0}.empty.off{display:none}
.empty h2{font-size:28px;line-height:36px;font-weight:500;letter-spacing:-0.014em;margin:0 0 8px}.empty p{margin:0 0 4px;color:var(--text-2)}.empty p.num{color:var(--muted);font-size:15px;line-height:24px}
details{margin-top:56px;border-top:1px solid var(--line);padding-top:8px}
summary{cursor:pointer;color:var(--text-2);font-size:15px;line-height:24px;padding:10px 0;list-style:none;display:flex;justify-content:space-between;gap:16px}summary::-webkit-details-marker{display:none}summary:hover{color:var(--text)}
summary .n{color:var(--muted)}
.done{padding:16px 0;border-bottom:1px solid var(--line);display:grid;gap:0}
.done .dq{font-weight:500}.done .dp{color:var(--text-2)}.done .dm{color:var(--muted);font-size:15px;line-height:24px;display:flex;justify-content:space-between;gap:16px;align-items:baseline;flex-wrap:wrap}
.done .dm form{display:inline}.done .dm button{font:inherit;font-size:15px;line-height:24px;font-weight:500;color:var(--accent-text);background:none;border:0;padding:10px 0;margin:-10px 0;cursor:pointer}
.done .dm button:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.none{color:var(--muted);padding:8px 0;margin:0}
@media (prefers-reduced-motion:reduce){.card.anim,.bar i,.card-top{transition:none}}
@media (min-width:720px){.stage{height:560px}.top{padding-top:28px}}
`;

const dirKey = (d: Choice["dir"]) => d === "right" ? "→" : d === "left" ? "←" : d === "up" ? "↑" : "";
const order = (c: Choice) => c.dir === "left" ? 0 : c.dir === "right" ? 1 : c.dir === "up" ? 2 : 3; // left | right, then the rest

function choiceButton(c: Choice, csrf: string): string {
  const inner = `${c.dir !== "tap" ? `<span class="k" aria-hidden="true">${dirKey(c.dir)}</span>` : ""}<span>${esc(c.label)}</span>`;
  // A link with no action (Fix it) is not a swipe: a plain link on its own line, after the choices.
  if (c.href) return `<a class="btn${c.action || c.dir !== "tap" ? "" : " more"}" href="${esc(c.href)}" data-choice="${esc(c.id)}">${inner}</a>`;
  return `<form method="post" action="/action/${esc(c.action)}" data-choice="${esc(c.id)}"><input type="hidden" name="csrf" value="${esc(csrf)}">${Object.entries(c.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}<button class="btn" type="submit">${inner}</button></form>`;
}

const shortTime = (iso: string) => esc(String(iso).replace("T", " ").slice(0, 16));

function lineHtml(l: Card["lines"][number]): string {
  if (l.label === "Quote") return `<div class="line quote"><span class="sr">Quote: </span><span class="v">${esc(l.value)}</span>${l.meta ? `<span class="m">${esc(l.meta)}</span>` : ""}</div>`;
  return `<div class="line"><span class="l">${esc(l.label)}</span><span class="v">${esc(l.value)}</span>${l.meta ? `<span class="m">${esc(l.meta)}</span>` : ""}</div>`;
}

function cardHtml(c: Card, i: number, csrf: string): string {
  const auto = c.auto ? c.choices.find((x) => x.id === c.auto!.choice) : undefined;
  const cues = c.choices.filter((x) => x.dir !== "tap").map((x) => `<span class="cue ${x.dir === "right" ? "r" : x.dir === "left" ? "l" : "u"} ${x.tone}" data-dir="${x.dir}">${esc(x.label)}</span>`).join("");
  const body = c.hidden
    ? `<div class="lines"><p class="hidden">${esc(c.hidden)}</p></div>`
    : `<div class="lines">${c.lines.map(lineHtml).join("")}</div>`;
  return `<article class="card ${i === 0 ? "c0" : i === 1 ? "c1" : "cn"}" data-key="${esc(c.key)}" aria-hidden="${i === 0 ? "false" : "true"}">
<div class="card-top"><span class="tag">${esc(c.tag)}</span>${c.href ? `<a href="${esc(c.href)}">Open</a>` : ""}</div>
<h2 class="q">${esc(c.question)}</h2>
${c.auto && auto ? `<p class="auto" data-at="${esc(c.auto.at)}">If you don't answer by <time datetime="${esc(c.auto.at)}">${shortTime(c.auto.at)}</time>, pocketBrain goes with “${esc(auto.label)}”: ${esc(c.auto.why)}</p><div class="hair" aria-hidden="true"><i></i></div>` : ""}
${c.never_auto ? `<p class="never">Only you decide this: ${esc(c.never_auto)}</p>` : ""}
${body}
<div class="acts">${[...c.choices].sort((a, b) => order(a) - order(b)).map((x) => choiceButton(x, csrf)).join("")}</div>
${cues}
</article>`;
}

function autoRow(r: AutoDone, csrf: string): string {
  return `<div class="done"><span class="dq">${esc(r.question)}</span><span class="dp">${esc(r.picked)} — ${esc(r.why)}</span><span class="dm"><time datetime="${esc(r.at)}">${shortTime(r.at)}</time>${r.undone ? `<span>undone</span>` : `<form method="post" action="/action/owner-undo-auto"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="key" value="${esc(r.key)}"><button type="submit">Undo</button></form>`}</span></div>`;
}

export const minutes = (s: number) => s < 60 ? `${Math.max(0, Math.round(s))} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;

export function deckPage(v: DeckView, csrf: string, flash?: { msg: string; err?: boolean }): string {
  const left = v.cards.length;
  const total = v.cleared_today + left;
  const pct = total ? Math.round((v.cleared_today / total) * 100) : 100;
  const data = { csrf, cleared: v.cleared_today, seconds: v.seconds_today, streak: v.streak, cards: v.cards.map((c) => ({ key: c.key, choices: c.choices, auto: c.auto })) };
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, "");
  const stats = `<span class="num">Cleared today <b id="st-cleared">${v.cleared_today}</b> · <span id="st-min">${esc(minutes(v.seconds_today))}</span></span><span class="num">Streak ${v.streak} day${v.streak === 1 ? "" : "s"}</span>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Decisions</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top"><a href="/">← Dashboard</a><span class="left num${left ? "" : " zero"}" id="left">${left ? `${left} left` : "All clear"}</span></header>
<div class="bar" aria-hidden="true"><i id="bar" style="width:${pct}%"></i></div>
<div class="stats" id="stats">${stats}</div>
<div class="flash${flash ? (flash.err ? " err" : "") : " off"}" id="flash" role="status"><span id="flash-msg">${flash ? esc(flash.msg) : ""}</span></div>
<section class="stage${left ? "" : " off"}" id="stage" aria-label="Decisions">
${v.cards.map((c, i) => cardHtml(c, i, csrf)).join("\n")}
</section>
${left ? `<p class="hint" id="hint">Swipe, tap a choice or use the arrow keys.</p>` : ""}
<section class="empty${left ? " off" : ""}" id="empty"><h2>Nothing needs you.</h2><p class="num" id="empty-stats">Cleared today <span id="e-cleared">${v.cleared_today}</span> · <span id="e-min">${esc(minutes(v.seconds_today))}</span> · Streak ${v.streak} day${v.streak === 1 ? "" : "s"}</p><p>New cards appear here when a source disagrees, a fact needs checking, or an agent asks.</p></section>
<details${left ? "" : " open"}><summary><span>Decided for you</span><span class="n num">${v.auto.length ? `${v.auto.length} in 7 days` : "none"}</span></summary>
${v.auto.length ? v.auto.map((r) => autoRow(r, csrf)).join("") : `<p class="none">No decision was taken for you in the last 7 days. When a card's deadline passes unanswered, the pick lands here with an Undo.</p>`}
</details>
</div>
<script type="application/json" id="deck-data">${json}</script>
<script>
(function () {
  var dataEl = document.getElementById('deck-data');
  var data = JSON.parse(dataEl.textContent);
  var csrf = data.csrf;
  var byKey = {};
  data.cards.forEach(function (c) { byKey[c.key] = c; });
  var stage = document.getElementById('stage');
  var cards = Array.prototype.slice.call(stage.querySelectorAll('.card'));
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var cleared = data.cleared, seconds = data.seconds, total = cleared + cards.length;
  var shownAt = Date.now();
  var busy = false;

  // --- dates in the browser's locale -------------------------------------------------------
  function fmtWhen(iso) {
    var d = new Date(iso); if (isNaN(d)) return iso;
    var now = new Date(), far = Math.abs(d - now) > 6 * 86400000;
    var o = far ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' };
    try { return new Intl.DateTimeFormat(undefined, o).format(d); } catch (e) { return iso; }
  }
  Array.prototype.forEach.call(document.querySelectorAll('time[datetime]'), function (t) { t.textContent = fmtWhen(t.getAttribute('datetime')); });
  // Time left as a hairline, over a 72 h window: full at 3 days out, empty at the deadline.
  function hairlines() {
    Array.prototype.forEach.call(document.querySelectorAll('.auto[data-at]'), function (p) {
      var at = Date.parse(p.getAttribute('data-at')); if (isNaN(at)) return;
      var frac = Math.max(0, Math.min(1, (at - Date.now()) / (72 * 3600000)));
      var h = p.nextElementSibling; if (h && h.firstElementChild) h.firstElementChild.style.width = (frac * 100).toFixed(1) + '%';
    });
  }
  hairlines(); setInterval(hairlines, 60000);

  // --- layout: top card, one peeking behind ------------------------------------------------
  function layout() {
    cards.forEach(function (el, i) {
      el.classList.remove('c0', 'c1', 'cn', 'out');
      el.classList.add(i === 0 ? 'c0' : i === 1 ? 'c1' : 'cn');
      el.setAttribute('aria-hidden', i === 0 ? 'false' : 'true');
      if (i !== 0) el.style.transform = '';
    });
    var left = document.getElementById('left');
    left.textContent = cards.length ? cards.length + ' left' : 'All clear';
    left.classList.toggle('zero', !cards.length);
    document.getElementById('bar').style.width = (total ? Math.round(cleared / total * 100) : 100) + '%';
    document.getElementById('st-cleared').textContent = cleared;
    document.getElementById('st-min').textContent = minutes(seconds);
    document.getElementById('e-cleared').textContent = cleared;
    document.getElementById('e-min').textContent = minutes(seconds);
    var hint = document.getElementById('hint');
    if (!cards.length) { stage.classList.add('off'); document.getElementById('empty').classList.remove('off'); if (hint) hint.remove(); }
  }
  function minutes(s) { return s < 60 ? Math.round(s) + ' s' : s < 3600 ? Math.round(s / 60) + ' min' : Math.floor(s / 3600) + ' h ' + Math.round((s % 3600) / 60) + ' min'; }

  // --- flash line -----------------------------------------------------------------------
  var flash = document.getElementById('flash'), flashMsg = document.getElementById('flash-msg');
  function say(msg, err, undo) {
    flashMsg.textContent = msg;
    flash.classList.toggle('err', !!err); flash.classList.remove('off');
    var old = flash.querySelector('button'); if (old) old.remove();
    if (undo) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Undo';
      b.addEventListener('click', function () {
        b.disabled = true;
        post('owner-undo', { hash: undo }).then(function (r) {
          if (r.err) { say(r.err, true); return; }
          location.replace(location.pathname + '?ok=' + encodeURIComponent(r.ok || 'Undone'));
        });
      });
      flash.appendChild(b);
    }
  }
  function post(action, fields) {
    var body = new URLSearchParams(); body.set('csrf', csrf);
    Object.keys(fields).forEach(function (k) { body.set(k, fields[k]); });
    return fetch('/action/' + encodeURIComponent(action), { method: 'POST', body: body, credentials: 'same-origin', redirect: 'follow', headers: { 'accept': 'text/html' } })
      .then(function (res) {
        var q = new URL(res.url, location.href).searchParams;
        if (q.has('err')) return { err: q.get('err') || 'That did not work.' };
        if (q.has('ok')) return { ok: q.get('ok') || '', undo: q.get('undo') || '' };
        if (!res.ok) return { err: 'The hub answered ' + res.status + '.' };
        return { ok: '' };
      }, function () { return { err: 'No answer from the hub. The card is back.' }; });
  }

  // --- taking a choice ------------------------------------------------------------------
  function take(el, choice, dir) {
    if (busy) return; busy = true;
    var ms = Date.now() - shownAt;
    if (choice.href) { location.href = choice.href; return; }
    var idx = cards.indexOf(el); if (idx < 0) { busy = false; return; }
    cards.splice(idx, 1);
    var go = function () {
      el.classList.remove('c0', 'anim', 'drag'); el.classList.add('cn'); el.style.transform = '';
      cards.slice(0, 1).forEach(function (n) { n.classList.add('anim'); });
      layout(); shownAt = Date.now(); busy = false;
    };
    if (reduced || !dir) go();
    else {
      el.classList.add('anim', 'out');
      var w = el.offsetWidth;
      el.style.transform = dir === 'right' ? 'translate(' + (w * 1.3) + 'px,-24px) rotate(6deg)' : dir === 'left' ? 'translate(' + (-w * 1.3) + 'px,-24px) rotate(-6deg)' : 'translate(0,' + (-el.offsetHeight * 1.2) + 'px)';
      var done = false; var fin = function () { if (!done) { done = true; go(); } };
      el.addEventListener('transitionend', fin, { once: true }); setTimeout(fin, 220);
    }
    var fields = {}; Object.keys(choice.fields || {}).forEach(function (k) { fields[k] = choice.fields[k]; });
    fields.deck_ms = String(ms);
    post(choice.action, fields).then(function (r) {
      if (r.err) {
        // put the card back on top
        cards.unshift(el); el.classList.remove('out', 'anim'); el.style.transform = '';
        stage.classList.remove('off'); document.getElementById('empty').classList.add('off');
        layout(); shownAt = Date.now();
        say(r.err, true);
      } else {
        cleared += 1; seconds += ms / 1000; layout();
        say(r.ok || choice.label, false, r.undo);
      }
    });
  }
  function choiceFor(el, pred) {
    var c = byKey[el.getAttribute('data-key')]; if (!c) return null;
    for (var i = 0; i < c.choices.length; i++) if (pred(c.choices[i])) return c.choices[i];
    return null;
  }

  // buttons: intercept the forms, post with fetch and advance
  stage.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-choice]'); if (!form) return;
    e.preventDefault();
    var el = form.closest('.card'); var id = form.getAttribute('data-choice');
    var ch = choiceFor(el, function (c) { return c.id === id; }); if (!ch) { form.submit(); return; }
    take(el, ch, ch.dir === 'tap' ? '' : ch.dir);
  });

  // keyboard
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    var dir = e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowUp' ? 'up' : '';
    if (!dir || !cards.length) return;
    var el = cards[0]; var ch = choiceFor(el, function (c) { return c.dir === dir; }); if (!ch) return;
    e.preventDefault(); showCue(el, dir, 1); setTimeout(function () { take(el, ch, dir); }, 60);
  });

  // --- swipe ------------------------------------------------------------------------------
  var TH = 88; // px before a swipe counts
  var drag = null;
  function showCue(el, dir, k) {
    Array.prototype.forEach.call(el.querySelectorAll('.cue'), function (c) { c.style.opacity = c.getAttribute('data-dir') === dir ? String(Math.max(0, Math.min(1, k))) : '0'; });
  }
  function dirOf(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
    return dy < 0 ? 'up' : '';
  }
  stage.addEventListener('pointerdown', function (e) {
    if (busy || drag) return;
    var el = e.target.closest('.card'); if (!el || el !== cards[0]) return;
    if (e.target.closest('button, a, form, input')) return;
    if (e.button !== 0) return;
    var inLines = !!e.target.closest('.lines');
    drag = { el: el, id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, on: false, inLines: inLines, t0: Date.now() };
  });
  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.on) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // Inside the evidence list a vertical move is a scroll, not a swipe.
      if (drag.inLines && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
      drag.on = true; drag.el.classList.add('drag'); drag.el.classList.remove('anim');
      try { drag.el.setPointerCapture(drag.id); } catch (err) {}
    }
    drag.dx = dx; drag.dy = dy;
    var el = drag.el, dir = dirOf(dx, dy);
    var has = !!choiceFor(el, function (c) { return c.dir === dir; });
    var rot = reduced ? 0 : Math.max(-6, Math.min(6, dx * 0.03));
    var ty = dir === 'up' ? dy : dy * 0.25;
    el.style.transform = 'translate(' + dx + 'px,' + ty + 'px) rotate(' + rot + 'deg)';
    var k = (dir === 'up' ? -dy : Math.abs(dx)) / TH;
    showCue(el, has ? dir : '', k);
    if (e.cancelable) e.preventDefault();
  }
  function end(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag; drag = null;
    if (!d.on) return;
    var el = d.el; el.classList.remove('drag');
    var dir = dirOf(d.dx, d.dy);
    var dist = dir === 'up' ? -d.dy : Math.abs(d.dx);
    var dt = Math.max(1, Date.now() - d.t0), fast = dist / dt > 0.9 && dist > 40;
    var ch = (dist > TH || fast) && dir ? choiceFor(el, function (c) { return c.dir === dir; }) : null;
    if (ch) { showCue(el, dir, 1); take(el, ch, dir); return; }
    showCue(el, '', 0);
    el.classList.add('anim'); el.style.transform = '';
  }
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('lostpointercapture', end);

  layout();
})();
</script>
</body>
</html>`;
}
