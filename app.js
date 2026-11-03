/* ЗДОИ4You – Дела: платформа на екипа за заявките за съдействие.
 * Вход с Google е задължителен. Данните идват само от API (apps-script/Code.gs), което проверява
 * токена и членството в екипа. В браузъра се пази единствено токенът (sessionStorage, до 1 час). */
'use strict';

const CONFIG = {
  CLIENT_ID: '838853307992-dv64og2iil0q6fqjgu293006ulc50r5q.apps.googleusercontent.com',
  // същото уеб приложение като My ЗДОИ4You (скриптът на таблицата; кодът на Дела е в my/apps-script/Dela.gs)
  API: 'https://script.google.com/macros/s/AKfycbwJjbM1tzlMJbIxTcwdqV_BeR_tGyrmU0KlYoUJ5_jWdN5Wm9KhmYLKecAwdQQpOVVu/exec',
  IDLE_MIN: 30 // автоматичен изход след толкова минути бездействие
};

const ROLE = { 'Суперадминистратор': 4, 'Администратор': 3, 'Юрист': 2, 'Наблюдател': 1 };
const CLOSED = ['Отказана – изпратени насоки', 'Приключена'];
const ERR = {
  auth: 'Сесията изтече. Влезте отново.', forbidden: 'Нямате достъп до платформата.', role: 'Нямате права за това действие.',
  notfound: 'Заявката не е намерена.', status: 'Невалиден статус.', owner: 'Отговорникът трябва да е активен юрист или администратор.',
  email: 'Невалиден имейл.', self: 'Не можете да променяте собствените си права.', lastadmin: 'Трябва да остане поне един активен суперадминистратор.',
  fields: 'Попълнете задължителните полета.', date: 'Невалидна дата.', locked: 'Преписката е заключена от администратор.',
  confirm: 'Номерът за потвърждение не съвпада.', network: 'Няма връзка със сървъра. Опитайте отново.'
};

const S = { token: '', exp: 0, me: null, statuses: [], roles: [], kinds: [], items: null, team: [], comments: {}, tc: null };
const $ = (sel, el = document) => el.querySelector(sel);
const app = () => $('#app');
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const can = n => S.me && ROLE[S.me.role] >= n;

/* ---------- сесия ---------- */

function store(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) { /* без хранилище */ } }
function load(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }

function restore() {
  try {
    const t = JSON.parse(load('dela.tok') || 'null');
    if (t && t.exp > Date.now() + 60e3) { S.token = t.token; S.exp = t.exp; }
  } catch (e) { /* ignore */ }
}

function gis(cb, tries = 0) {
  if (window.google && google.accounts && google.accounts.oauth2) return cb();
  if (tries > 100) return gate('Неуспешно зареждане на Google вход. Проверете връзката или блокиращи разширения.');
  setTimeout(() => gis(cb, tries + 1), 100);
}

function login() {
  gis(() => {
    if (!S.tc) {
      S.tc = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.CLIENT_ID,
        scope: 'openid email profile',
        callback: r => {
          if (r.error || !r.access_token) return gate('Входът не беше завършен.');
          S.token = r.access_token;
          S.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
          store('dela.tok', JSON.stringify({ token: S.token, exp: S.exp }));
          start();
        },
        error_callback: () => gate('Входът беше прекъснат.')
      });
    }
    S.tc.requestAccessToken({ prompt: 'select_account' });
  });
}

function logout(msg) {
  const t = S.token;
  Object.assign(S, { token: '', exp: 0, me: null, items: null, team: [], comments: {} });
  store('dela.tok', null);
  if (t && window.google && google.accounts && google.accounts.oauth2) { try { google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignore */ } }
  history.replaceState(null, '', location.pathname);
  gate(msg);
}

let idleT;
function idle() {
  clearTimeout(idleT);
  if (S.token) idleT = setTimeout(() => logout('Излязохте автоматично след ' + CONFIG.IDLE_MIN + ' минути бездействие.'), CONFIG.IDLE_MIN * 60e3);
}
['click', 'keydown', 'pointermove', 'scroll'].forEach(ev => addEventListener(ev, () => S.token && idle(), { passive: true }));

/* ---------- API ---------- */

async function api(action, data) {
  if (S.exp && Date.now() > S.exp - 30e3) { logout(ERR.auth); throw new Error('auth'); }
  let j;
  try {
    const r = await fetch(CONFIG.API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: S.token, action: 'dela.' + action, data: data || {} })
    });
    j = await r.json();
  } catch (e) { throw new Error('network'); }
  if (!j.ok) {
    if (j.error === 'auth') { logout(ERR.auth); }
    else if (j.error === 'forbidden') { denied(j.email); }
    throw new Error(j.error || 'error');
  }
  return j;
}

const msg = e => ERR[e && e.message] || 'Грешка: ' + (e && e.message || e);

function toast(t) {
  const el = $('#toast');
  el.textContent = t; el.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 3200);
}

/* ---------- екрани без вход ---------- */

const G_ICON = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function gate(note) {
  clearTimeout(idleT);
  app().innerHTML = `<div class="gate"><div class="card gate-card">
    <img src="assets/logo-icon.png" alt="">
    <h1>Дела</h1>
    <p class="muted">Платформа на екипа на ЗДОИ4You за заявките за съдействие. Достъпът е само за членове на екипа.</p>
    ${CONFIG.API ? `<button class="btn google" id="login">${G_ICON}Вход с Google</button>`
      : '<div class="banner bad">Платформата още не е свързана със сървъра (CONFIG.API в app.js).</div>'}
    ${note ? `<p class="note muted">${esc(note)}</p>` : ''}
  </div></div>`;
  const b = $('#login');
  if (b) b.onclick = login;
}

function denied(email) {
  const t = S.token;
  Object.assign(S, { token: '', exp: 0, me: null });
  store('dela.tok', null);
  if (t && window.google) { try { google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignore */ } }
  app().innerHTML = `<div class="gate"><div class="card gate-card">
    <img src="assets/logo-icon.png" alt="">
    <h1>Нямате достъп</h1>
    <p class="muted">Акаунтът <b>${esc(email || '')}</b> не е член на екипа или е деактивиран. Помолете администратор да ви добави.</p>
    <button class="btn" id="login">Вход с друг акаунт</button>
  </div></div>`;
  $('#login').onclick = login;
}

/* ---------- стартиране ---------- */

async function start() {
  app().innerHTML = '<div class="gate"><div class="card gate-card"><span class="spin"></span> <span class="muted">Проверка на достъпа…</span></div></div>';
  try {
    const j = await api('me');
    S.me = j.me; S.statuses = j.statuses; S.roles = j.roles; S.kinds = j.kinds || [];
    idle();
    shell();
    await refresh();
    route();
  } catch (e) {
    if (e.message !== 'auth' && e.message !== 'forbidden') gate(msg(e));
  }
}

async function refresh() {
  const j = await api('list');
  S.items = j.items.slice().sort((a, b) => b.at.localeCompare(a.at));
  S.team = j.team; S.comments = j.comments || {};
}

function shell() {
  const me = S.me;
  app().innerHTML = `<header class="top"><div class="bar">
    <a class="brand" href="#/"><img src="assets/logo-icon.png" alt="">Дела</a>
    <nav class="tabs" aria-label="Раздели">
      <a href="#/" data-v="home">Табло</a>
      <a href="#/requests" data-v="requests">Заявки</a>
      ${can(3) ? '<a href="#/team" data-v="team">Екип</a><a href="#/log" data-v="log">Дневник</a>' : ''}
    </nav>
    <div class="user"><div class="who"><b>${esc(me.name || me.email)}</b><br><span class="muted">${esc(me.role)}</span></div>
      <button class="btn" id="out">Изход</button></div>
  </div></header><main id="view"></main>`;
  $('#out').onclick = () => logout('Излязохте от платформата.');
}

addEventListener('hashchange', () => S.me && route());

function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '').split('?')[0]);
  const [v, ...rest] = h.split('/');
  const view = { '': 'home', requests: 'requests', r: 'requests', team: 'team', log: 'log' }[v] || 'home';
  document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('on', a.dataset.v === view));
  window.scrollTo(0, 0);
  if (v === 'r' && rest.length) return detail(rest.join('/'));
  if (v === 'requests') return list();
  if (v === 'team' && can(3)) return team();
  if (v === 'log' && can(3)) return logView();
  home();
}

const view = () => $('#view');

/* ---------- помощни за показване ---------- */

function fmt(s, time) {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(s);
  if (!m) return esc(s);
  return `${m[3]}.${m[2]}.${m[1]}` + (time && m[4] ? ' ' + m[4] : '');
}

function daysLeft(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], m[2] - 1, +m[3]), t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 864e5);
}

function due(it) {
  const n = daysLeft(it.appeal);
  if (n == null) return '<span class="muted">—</span>';
  if (CLOSED.includes(it.status)) return `<span class="muted mono">${fmt(it.appeal)}</span>`;
  const cls = n < 0 ? 'late' : n <= 7 ? 'soon' : '';
  const t = n < 0 ? `изтекъл преди ${-n} дн.` : n === 0 ? 'днес' : `след ${n} дн.`;
  return `<span class="due mono ${cls}">${fmt(it.appeal)}</span><br><span class="small muted">${t}</span>`;
}

function badge(s) {
  const c = s === 'Нова' ? 'b-new' : CLOSED.includes(s) ? (s === 'Приключена' ? 'b-ok' : 'b-bad')
    : ['Одобрена', 'Договор изпратен', 'Заведено дело'].includes(s) ? 'b-ok' : 'b-work';
  return `<span class="badge ${c}">${esc(s || '—')}</span>`;
}

function who(email) {
  if (!email) return '<span class="muted">—</span>';
  const m = S.team.find(t => t.email === email);
  return esc(m && m.name ? m.name : email);
}

const isOpen = it => !CLOSED.includes(it.status);

function rows(items, cols) {
  if (!items.length) return '<div class="empty">Няма заявки.</div>';
  const C = {
    id: ['№', it => `<a class="id" href="#/r/${encodeURIComponent(it.id)}">${esc(it.id)}</a>${it.locked ? ' <span title="Заключена">🔒</span>' : ''}${S.comments[it.id] ? ` <span class="small muted" title="Коментари">💬${S.comments[it.id]}</span>` : ''}`],
    at: ['Получена', it => `<span class="mono">${fmt(it.at, true)}</span>`],
    name: ['Заявител', it => `${esc(it.name)}<br><span class="small muted">${esc(it.city)}</span>`],
    body: ['Задължен субект', it => esc(it.body)],
    kind: ['Вид отказ', it => esc(it.kind)],
    appeal: ['Срок за обжалване', due],
    status: ['Статус', it => badge(it.status)],
    owner: ['Отговорник', it => who(it.owner)]
  };
  cols = cols || Object.keys(C);
  return `<div class="tbl-wrap"><table><thead><tr>${cols.map(c => `<th>${C[c][0]}</th>`).join('')}</tr></thead><tbody>
    ${items.map(it => `<tr class="link" data-id="${esc(it.id)}">${cols.map(c => `<td>${C[c][1](it)}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div>`;
}

function bindRows(el) {
  el.querySelectorAll('tr.link').forEach(tr => tr.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    location.hash = '#/r/' + encodeURIComponent(tr.dataset.id);
  }));
}

function reloadBtn() {
  return '<button class="btn" id="reload" title="Обнови данните">↻ Обнови</button>';
}
function bindReload(fn) {
  const b = $('#reload');
  if (b) b.onclick = async () => {
    b.disabled = true;
    try { await refresh(); fn(); toast('Данните са обновени.'); } catch (e) { toast(msg(e)); b.disabled = false; }
  };
}

/* ---------- табло ---------- */

function home() {
  const all = S.items, open = all.filter(isOpen);
  const urgent = open.filter(it => { const n = daysLeft(it.appeal); return n != null && n <= 7; })
    .sort((a, b) => a.appeal.localeCompare(b.appeal));
  const mine = open.filter(it => it.owner === S.me.email);
  const free = open.filter(it => !it.owner);
  const cnt = s => all.filter(it => it.status === s).length;
  view().innerHTML = `
    <div class="head"><h1>Табло</h1>${reloadBtn()}</div>
    <div class="stats">
      <a class="card stat" href="#/requests?st=open"><b>${open.length}</b><span>Отворени</span></a>
      ${S.statuses.map(s => `<a class="card stat" href="#/requests?st=${encodeURIComponent(s)}"><b>${cnt(s)}</b><span>${esc(s)}</span></a>`).join('')}
    </div>
    <div class="grid">
      <section class="card"><div class="head"><h2>Изтичащ срок за обжалване (до 7 дни)</h2></div>
        ${rows(urgent, ['id', 'name', 'body', 'appeal', 'status', 'owner'])}</section>
      <div class="grid cols-2" style="grid-template-columns:1fr 1fr">
        <section class="card"><div class="head"><h2>Възложени на мен</h2><a href="#/requests?own=me" class="small">Всички</a></div>
          ${rows(mine.slice(0, 8), ['id', 'body', 'appeal', 'status'])}</section>
        <section class="card"><div class="head"><h2>Без отговорник</h2><a href="#/requests?own=none" class="small">Всички</a></div>
          ${rows(free.slice(0, 8), ['id', 'body', 'appeal', 'status'])}</section>
      </div>
    </div>`;
  if (innerWidth < 900) view().querySelectorAll('.cols-2').forEach(e => e.style.gridTemplateColumns = '1fr');
  bindRows(view());
  bindReload(home);
}

/* ---------- списък със заявки ---------- */

function listParams() {
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  let saved = {};
  try { saved = JSON.parse(load('dela.f') || '{}'); } catch (e) { /* ignore */ }
  if (q.toString()) saved = { q: '', st: q.get('st') || '', own: q.get('own') || '', kind: '' };
  return Object.assign({ q: '', st: 'open', own: '', kind: '' }, saved);
}

function list() {
  const f = listParams();
  const kinds = [...new Set(S.items.map(it => it.kind).filter(Boolean))];
  view().innerHTML = `
    <div class="head"><h1>Заявки</h1>${reloadBtn()}</div>
    <div class="filters">
      <div class="q"><label for="fq">Търсене</label><input id="fq" type="search" placeholder="№, име, имейл, субект, населено място" value="${esc(f.q)}"></div>
      <div><label for="fst">Статус</label><select id="fst">
        <option value="">Всички</option><option value="open">Отворени</option>
        ${S.statuses.map(s => `<option>${esc(s)}</option>`).join('')}</select></div>
      <div><label for="fown">Отговорник</label><select id="fown">
        <option value="">Всички</option><option value="me">Моите</option><option value="none">Без отговорник</option>
        ${S.team.map(m => `<option value="${esc(m.email)}">${esc(m.name || m.email)}</option>`).join('')}</select></div>
      <div><label for="fkind">Вид отказ</label><select id="fkind"><option value="">Всички</option>
        ${kinds.map(k => `<option>${esc(k)}</option>`).join('')}</select></div>
    </div>
    <p class="small muted" id="cnt"></p>
    <div id="res"></div>`;
  $('#fst').value = f.st; $('#fown').value = f.own; $('#fkind').value = f.kind;
  const draw = () => {
    const c = { q: $('#fq').value.trim(), st: $('#fst').value, own: $('#fown').value, kind: $('#fkind').value };
    store('dela.f', JSON.stringify(c));
    const q = c.q.toLowerCase();
    const res = S.items.filter(it =>
      (!c.st || (c.st === 'open' ? isOpen(it) : it.status === c.st)) &&
      (!c.own || (c.own === 'me' ? it.owner === S.me.email : c.own === 'none' ? !it.owner : it.owner === c.own)) &&
      (!c.kind || it.kind === c.kind) &&
      (!q || [it.id, it.name, it.email, it.body, it.city].some(x => String(x).toLowerCase().includes(q))));
    $('#cnt').textContent = `${res.length} от ${S.items.length} заявки`;
    $('#res').innerHTML = rows(res);
    bindRows($('#res'));
  };
  ['fq', 'fst', 'fown', 'fkind'].forEach(id => $('#' + id).addEventListener(id === 'fq' ? 'input' : 'change', draw));
  draw();
  bindReload(list);
}

/* ---------- заявка ---------- */

/* полета от подадената заявка: [ключ, етикет, вид] */
const DATA_F = [
  ['name', 'Заявител', 'text', 120], ['phone', 'Телефон', 'text', 40], ['city', 'Населено място', 'text', 120],
  ['body', 'Задължен субект', 'text', 200], ['kind', 'Вид отказ', 'kind'], ['no', 'Вх. № на заявлението', 'text', 60],
  ['reg', 'Дата на регистриране', 'date'], ['dec', 'Дата на решението', 'date'], ['recv', 'Решението е получено на', 'date'],
  ['appeal', 'Срок за обжалване', 'date'], ['desc', 'Описание', 'area', 4000]
];

async function detail(id, editing) {
  view().innerHTML = '<p class="muted"><span class="spin"></span> Зареждане…</p>';
  let j;
  try { j = await api('get', { id }); } catch (e) {
    view().innerHTML = `<p><a href="#/requests">← Заявки</a></p><div class="banner bad">${esc(msg(e))}</div>`;
    return;
  }
  const it = j.item;
  const adm = can(3), edit = can(2) && (!it.locked || adm);
  const files = /^https:\/\/drive\.google\.com\//.test(it.files) ? it.files : '';
  const shown = [
    ['Получена', fmt(it.at, true)],
    ['Заявител', esc(it.name)],
    ['Имейл (Google)', it.email ? `<a href="mailto:${esc(it.email)}">${esc(it.email)}</a>` : '—'],
    ['Телефон', it.phone ? `<a href="tel:${esc(it.phone.replace(/[^\d+]/g, ''))}">${esc(it.phone)}</a>` : '—'],
    ['Населено място', esc(it.city) || '—'],
    ['Задължен субект', esc(it.body)],
    ['Вид отказ', esc(it.kind)],
    ['Вх. № на заявлението', esc(it.no) || '—'],
    ['Дата на регистриране', fmt(it.reg)],
    ['Дата на решението', fmt(it.dec)],
    ['Решението е получено на', fmt(it.recv)],
    ['Срок за обжалване', due(it)]
  ];
  const kinds = S.kinds.includes(it.kind) || !it.kind ? S.kinds : [it.kind].concat(S.kinds);
  const dataForm = `<p class="small muted" style="margin:0 0 12px">Коригирайте данните, ако не съответстват на документите. Всяка промяна се записва в историята.</p>
    ${DATA_F.map(([k, l, t, n]) => `<div class="field"><label for="d-${k}">${l}</label>${
      t === 'kind' ? `<select id="d-${k}">${kinds.map(x => `<option${x === it.kind ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`
      : t === 'date' ? `<input id="d-${k}" type="date" value="${/^\d{4}-\d{2}-\d{2}$/.test(it[k]) ? esc(it[k]) : ''}">`
      : t === 'area' ? `<textarea id="d-${k}" maxlength="${n}" style="min-height:140px">${esc(it[k])}</textarea>`
      : `<input id="d-${k}" maxlength="${n}" value="${esc(it[k])}">`}</div>`).join('')}
    <div class="row"><button class="btn primary" id="dsave">Запази корекциите</button><button class="btn ghost" id="dcancel">Откажи</button></div>`;

  view().innerHTML = `
    <p><a href="#/requests">← Заявки</a></p>
    <div class="head"><div class="row"><h1>${esc(it.id)}</h1>${badge(it.status)}${it.locked ? '<span class="badge b-bad">🔒 Заключена</span>' : ''}</div>
      <div class="row">
        ${files ? `<a class="btn" href="${esc(files)}" target="_blank" rel="noopener noreferrer">📁 Документи в Drive</a>` : ''}
        ${adm ? `<button class="btn" id="lock">${it.locked ? '🔓 Отключи' : '🔒 Заключи'}</button>` : ''}
        ${can(4) ? '<button class="btn" id="del" style="color:var(--bad)">Изтрий</button>' : ''}
      </div></div>
    ${it.locked ? `<div class="banner">Преписката е заключена. ${adm ? 'Юристите и наблюдателите не могат да я редактират и коментират.' : 'Само администратор може да я редактира и коментира.'}</div>` : ''}
    <div class="grid cols-2">
      <div class="grid" style="align-content:start">
        <section class="card"><div class="head" style="margin-bottom:12px"><h2>Данни от заявката</h2>
            ${edit && !editing ? '<button class="btn" id="dedit">✎ Коригирай</button>' : ''}</div>
          ${editing && edit ? dataForm : `<dl class="fields">${shown.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
          ${it.desc ? `<h3 style="margin-top:16px">Описание</h3><div class="desc">${esc(it.desc)}</div>` : ''}`}
        </section>
        <section class="card"><h2 style="margin-bottom:8px">Вътрешни коментари</h2>
          <p class="small muted" style="margin:0 0 8px">Видими само за екипа.</p>
          <ul class="feed">${j.comments.length ? j.comments.map(c => `<li><div class="meta">${who(c.author)} · ${fmt(c.at, true)}</div><div class="txt">${esc(c.text)}</div></li>`).join('') : '<li class="muted">Няма коментари.</li>'}</ul>
          ${edit ? `<div class="sec"><label for="ctext">Нов коментар</label><textarea id="ctext" maxlength="4000"></textarea>
            <div class="row" style="margin-top:8px"><button class="btn primary" id="csend">Добави</button></div></div>` : ''}
        </section>
      </div>
      <div class="grid" style="align-content:start">
        <section class="card"><h2 style="margin-bottom:12px">Обработка</h2>
          <div class="field"><label for="est">Статус</label><select id="est" ${edit ? '' : 'disabled'}>
            ${S.statuses.map(s => `<option${s === it.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
          <div class="field"><label for="eown">Отговорник</label><select id="eown" ${edit && adm ? '' : 'disabled'}>
            <option value="">— без отговорник —</option>
            ${S.team.filter(m => ROLE[m.role] >= 2 || m.email === it.owner).map(m => `<option value="${esc(m.email)}"${m.email === it.owner ? ' selected' : ''}>${esc(m.name || m.email)} · ${esc(m.role)}</option>`).join('')}
            ${it.owner && !S.team.some(m => m.email === it.owner) ? `<option value="${esc(it.owner)}" selected>${esc(it.owner)}</option>` : ''}
          </select>${!adm ? '<p class="small muted" style="margin:4px 0 0">Към отговорник насочва администратор.</p>' : ''}</div>
          <div class="field"><label for="enote">Бележка към заявителя</label><textarea id="enote" maxlength="2000" ${edit ? '' : 'disabled'}>${esc(it.note)}</textarea></div>
          ${edit ? `<label class="check field"><input type="checkbox" id="enotify" checked> Уведоми заявителя по имейл при смяна на статуса или бележката</label>
            <button class="btn primary" id="esave">Запази</button>`
            : `<p class="small muted">${it.locked ? 'Преписката е заключена.' : 'Ролята „Наблюдател“ е само за преглед.'}</p>`}
        </section>
        <section class="card"><h2 style="margin-bottom:8px">История</h2>
          <ul class="feed">${j.history.length ? j.history.map(h => `<li><div class="meta">${who(h.user)} · ${fmt(h.at, true)}</div><div class="txt">${esc(h.action)}${h.details ? ': ' + esc(h.details) : ''}</div></li>`).join('') : '<li class="muted">Няма промени през платформата.</li>'}</ul>
        </section>
      </div>
    </div>`;

  const save = async (btn, data, ok) => {
    btn.disabled = true;
    try {
      const r = await api('update', Object.assign({ id: it.id }, data));
      toast(!r.changed ? 'Няма промени.' : r.mailed ? 'Запазено. Заявителят е уведомен.' : ok || 'Запазено.');
      if (r.changed) { await refresh(); detail(it.id); } else btn.disabled = false;
    } catch (e) { toast(msg(e)); btn.disabled = false; }
  };

  if ($('#lock')) $('#lock').onclick = async () => {
    const b = $('#lock'); b.disabled = true;
    try { await api('lock', { id: it.id, locked: !it.locked }); toast(it.locked ? 'Преписката е отключена.' : 'Преписката е заключена.'); await refresh(); detail(it.id); }
    catch (e) { toast(msg(e)); b.disabled = false; }
  };
  if ($('#del')) $('#del').onclick = async () => {
    const c = prompt(`Изтриване на преписка ${it.id}\n\nРедът в таблицата и коментарите се изтриват окончателно. Папката с документите отива в кошчето на Drive (30 дни).\n\nЗа потвърждение въведете номера ${it.id}:`);
    if (c == null) return;
    if (c.trim() !== it.id) return toast(ERR.confirm);
    const b = $('#del'); b.disabled = true;
    try { await api('remove', { id: it.id, confirm: c.trim() }); toast(`Преписка ${it.id} е изтрита.`); await refresh(); location.hash = '#/requests'; }
    catch (e) { toast(msg(e)); b.disabled = false; }
  };
  if (!edit) return;
  if ($('#dedit')) $('#dedit').onclick = () => detail(it.id, true);
  if ($('#dcancel')) $('#dcancel').onclick = () => detail(it.id);
  if ($('#dsave')) $('#dsave').onclick = () => {
    const fields = {};
    DATA_F.forEach(([k]) => { const v = $('#d-' + k).value.trim(); if (v !== (it[k] || '')) fields[k] = v; });
    if (!Object.keys(fields).length) return detail(it.id);
    if (fields.name === '' || fields.body === '') return toast(ERR.fields);
    save($('#dsave'), { fields }, 'Корекциите са запазени.');
  };
  $('#esave').onclick = () => save($('#esave'), Object.assign(
    { status: $('#est').value, note: $('#enote').value, notify: $('#enotify').checked }, adm ? { owner: $('#eown').value } : {}));
  $('#csend').onclick = async () => {
    const t = $('#ctext').value.trim();
    if (!t) return toast(ERR.fields);
    const b = $('#csend'); b.disabled = true;
    try { await api('comment', { id: it.id, text: t }); S.comments[it.id] = (S.comments[it.id] || 0) + 1; toast('Коментарът е добавен.'); detail(it.id); }
    catch (e) { toast(msg(e)); b.disabled = false; }
  };
}

/* ---------- екип (администратор) ---------- */

/* администраторът управлява юристи и наблюдатели; суперадминистраторът – всички */
const manages = role => can(4) || ROLE[role] < 3;

async function team() {
  view().innerHTML = '<p class="muted"><span class="spin"></span> Зареждане…</p>';
  let list;
  try { list = (await api('team')).team; } catch (e) { view().innerHTML = `<div class="banner bad">${esc(msg(e))}</div>`; return; }
  const roles = S.roles.filter(manages);
  const sync = () => { S.team = list.filter(m => m.active).map(m => ({ email: m.email, name: m.name, role: m.role })); };
  const draw = () => {
    view().innerHTML = `
      <div class="head"><h1>Екип</h1></div>
      <div class="grid cols-2">
        <div class="tbl-wrap"><table><thead><tr><th>Член</th><th>Роля</th><th>Състояние</th><th>Добавен</th><th></th></tr></thead><tbody>
          ${list.map(m => `<tr><td><b>${esc(m.name || '—')}</b><br><span class="small muted">${esc(m.email)}</span></td>
            <td>${esc(m.role)}</td><td>${m.active ? '<span class="badge b-ok">Активен</span>' : '<span class="badge">Деактивиран</span>'}</td>
            <td class="small muted">${fmt(m.added, true)}${m.by ? '<br>' + esc(m.by) : ''}</td>
            <td><div class="row" style="flex-wrap:nowrap">
              ${manages(m.role) && m.email !== S.me.email ? `<button class="btn" data-e="${esc(m.email)}">Промени</button>` : ''}
              ${can(4) && m.email !== S.me.email ? `<button class="btn" data-x="${esc(m.email)}" style="color:var(--bad)" title="Изтрий">✕</button>` : ''}
            </div></td></tr>`).join('')}
        </tbody></table></div>
        <section class="card" style="align-self:start"><h2 id="tf-h" style="margin-bottom:12px">Добави член</h2>
          <div class="field"><label for="tem">Google имейл</label><input id="tem" type="email" autocomplete="off" placeholder="name@gmail.com"></div>
          <div class="field"><label for="tnm">Име</label><input id="tnm" maxlength="120"></div>
          <div class="field"><label for="trl">Роля</label><select id="trl">${roles.map(r => `<option>${esc(r)}</option>`).join('')}</select></div>
          <label class="check field"><input type="checkbox" id="tac" checked> Активен</label>
          <div class="row"><button class="btn primary" id="tsave">Запази</button><button class="btn ghost" id="tnew">Нов</button></div>
          <ul class="small muted" style="margin:14px 0 0;padding-left:18px">
            <li><b>Суперадминистратор</b> – всичко; трие преписки и членове на екипа; управлява администраторите.</li>
            <li><b>Администратор</b> – член на екипа на ЗДОИ4You: администрира преписките, заключва ги и ги насочва към отговорник; добавя юристи и наблюдатели.</li>
            <li><b>Юрист</b> – обработва незаключените преписки: статус, бележка, корекция на данните, коментари.</li>
            <li><b>Наблюдател</b> – само преглед.</li>
          </ul>
          <p class="small muted" style="margin-top:8px">Деактивираният член губи достъп при следващото си действие в платформата.</p>
        </section>
      </div>`;
    $('#trl').value = 'Юрист';
    const fill = m => {
      $('#tf-h').textContent = m ? 'Промени член' : 'Добави член';
      $('#tem').value = m ? m.email : ''; $('#tem').readOnly = !!m;
      $('#tnm').value = m ? m.name : ''; $('#trl').value = m ? m.role : 'Юрист'; $('#tac').checked = m ? m.active : true;
    };
    view().querySelectorAll('[data-e]').forEach(b => b.onclick = () => { fill(list.find(m => m.email === b.dataset.e)); $('#tnm').focus(); });
    view().querySelectorAll('[data-x]').forEach(b => b.onclick = async () => {
      const m = list.find(x => x.email === b.dataset.x);
      if (!confirm(`Да изтрия ли ${m.name || m.email} (${m.email}, ${m.role}) от екипа?\n\nДостъпът спира веднага. Ако искате само временно да спрете достъпа, използвайте „Промени“ → „Активен“.`)) return;
      b.disabled = true;
      try { list = (await api('teamRemove', { email: m.email })).team; sync(); toast('Членът е изтрит.'); draw(); }
      catch (e) { toast(msg(e)); b.disabled = false; }
    });
    $('#tnew').onclick = () => fill(null);
    $('#tsave').onclick = async () => {
      const b = $('#tsave'); b.disabled = true;
      try {
        list = (await api('teamSave', { email: $('#tem').value, name: $('#tnm').value, role: $('#trl').value, active: $('#tac').checked })).team;
        sync(); toast('Екипът е обновен.'); draw();
      } catch (e) { toast(msg(e)); b.disabled = false; }
    };
  };
  draw();
}

/* ---------- дневник (администратор) ---------- */

async function logView() {
  view().innerHTML = '<p class="muted"><span class="spin"></span> Зареждане…</p>';
  let log;
  try { log = (await api('log')).log; } catch (e) { view().innerHTML = `<div class="banner bad">${esc(msg(e))}</div>`; return; }
  view().innerHTML = `<div class="head"><h1>Дневник</h1><span class="small muted">последните ${log.length} действия</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Време</th><th>Потребител</th><th>Действие</th><th>№</th><th>Подробности</th></tr></thead><tbody>
    ${log.length ? log.map(l => `<tr><td class="mono small">${fmt(l.at, true)}</td><td>${esc(l.user)}</td>
      <td>${l.action === 'Отказан достъп' ? '<span class="badge b-bad">Отказан достъп</span>' : esc(l.action)}</td>
      <td>${l.id ? `<a class="id" href="#/r/${encodeURIComponent(l.id)}">${esc(l.id)}</a>` : ''}</td><td>${esc(l.details)}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">Няма записи.</td></tr>'}
    </tbody></table></div>`;
}

/* ---------- старт ---------- */

restore();
if (S.token && CONFIG.API) start(); else gate();
