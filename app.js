/* ЗДОИ4You – Дела: платформа на екипа за заявките за съдействие.
 * Вход с Google е задължителен. Данните идват само от API (my/apps-script/Dela.gs), което проверява
 * токена, членството в екипа и сесията (30 мин.). В браузъра се пази единствено токенът (sessionStorage). */
'use strict';

const CONFIG = {
  CLIENT_ID: '838853307992-dv64og2iil0q6fqjgu293006ulc50r5q.apps.googleusercontent.com',
  // същото уеб приложение като My ЗДОИ4You (скриптът на таблицата; кодът на Дела е в my/apps-script/Dela.gs)
  API: 'https://script.google.com/macros/s/AKfycbwJjbM1tzlMJbIxTcwdqV_BeR_tGyrmU0KlYoUJ5_jWdN5Wm9KhmYLKecAwdQQpOVVu/exec',
  WARN_SEC: 120, // предупреждение толкова секунди преди края на сесията
  TZ: 'Europe/Sofia'
};

const ROLE = { 'Суперадминистратор': 4, 'Администратор': 3, 'Юрист': 2, 'Наблюдател': 1 };
const CLOSED = ['Отказана – изпратени насоки', 'Приключена'];
const ERR = {
  auth: 'Входът с Google е изтекъл. Влезте отново.', session: 'Сесията изтече. Влезте отново.',
  forbidden: 'Нямате достъп до платформата.', role: 'Нямате права за това действие.',
  notfound: 'Заявката не е намерена.', status: 'Невалиден статус.', owner: 'Получателят трябва да е активен член на екипа с подходяща роля.',
  email: 'Невалиден имейл.', self: 'Не можете да променяте собствените си права.', lastadmin: 'Трябва да остане поне един активен суперадминистратор.',
  fields: 'Попълнете задължителните полета.', date: 'Невалидна дата.', locked: 'Преписката е заключена от администратор.',
  confirm: 'Номерът за потвърждение не съвпада.', network: 'Няма връзка със сървъра. Опитайте отново.'
};

const S = {
  token: '', exp: 0, me: null, statuses: [], roles: [], kinds: [], items: null, team: [], comments: {}, unread: 0, tc: null,
  sess: 0, skew: 0 // край на сесията (по часовника на сървъра) и разлика сървър − браузър
};
const $ = (sel, el = document) => el.querySelector(sel);
const app = () => $('#app');
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const can = n => S.me && ROLE[S.me.role] >= n;
const now = () => Date.now() + S.skew;

/* ---------- съхранение и Google вход ---------- */

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

/* нов Google токен; onToken се вика след успешен вход */
function googleToken(prompt, onToken, onFail) {
  gis(() => {
    S.tc = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: 'openid email profile',
      callback: r => {
        if (r.error || !r.access_token) return onFail('Входът не беше завършен.');
        S.token = r.access_token;
        S.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        store('dela.tok', JSON.stringify({ token: S.token, exp: S.exp }));
        onToken();
      },
      error_callback: () => onFail('Входът беше прекъснат.')
    });
    S.tc.requestAccessToken({ prompt: prompt });
  });
}

const login = () => googleToken('select_account', () => start(), gate);

function clearSession() {
  const t = S.token;
  Object.assign(S, { token: '', exp: 0, me: null, items: null, team: [], comments: {}, unread: 0, sess: 0 });
  store('dela.tok', null);
  closeDialog();
  if (t && window.google && google.accounts && google.accounts.oauth2) { try { google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignore */ } }
}

function logout(note) {
  clearSession();
  history.replaceState(null, '', location.pathname);
  gate(note);
}

/* изход по желание или при изтекла сесия – записва се в дневника */
async function signOut(auto) {
  if (S.token && S.sess && now() < S.sess) { try { await api('logout', { auto: !!auto }); } catch (e) { /* ignore */ } }
  logout(auto ? 'Сесията от 30 минути изтече и излязохте автоматично.' : 'Излязохте от платформата.');
}

/* ---------- API ---------- */

async function api(action, data) {
  let j;
  try {
    const r = await fetch(CONFIG.API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: S.token, action: 'dela.' + action, data: data || {} })
    });
    j = await r.json();
  } catch (e) { throw new Error('network'); }
  if (!j.ok) {
    if (j.error === 'auth' || j.error === 'session') { if (action !== 'logout') logout(ERR[j.error]); }
    else if (j.error === 'forbidden') { denied(j.email); }
    throw new Error(j.error || 'error');
  }
  if (j.session) { S.sess = j.session; S.skew = j.now - Date.now(); }
  return j;
}

const msg = e => ERR[e && e.message] || 'Грешка: ' + (e && e.message || e);

function toast(t) {
  const el = $('#toast');
  el.textContent = t; el.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 3200);
}

/* ---------- диалог ---------- */

function dialog(html) {
  closeDialog();
  const d = document.createElement('dialog');
  d.id = 'dlg'; d.className = 'card';
  d.innerHTML = html;
  document.body.appendChild(d);
  d.addEventListener('cancel', e => e.preventDefault());
  d.showModal();
  return d;
}
function closeDialog() { const d = $('#dlg'); if (d) { d.close(); d.remove(); } }

/* ---------- часовник и таймер на сесията ---------- */

const CLOCK = new Intl.DateTimeFormat('bg-BG', { timeZone: CONFIG.TZ, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const mmss = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

function tick() {
  const c = $('#clock');
  if (c) {
    const t = today(), r = reason(t);
    c.innerHTML = `<span class="mono">${esc(CLOCK.format(new Date()))}</span><br><span class="${r ? 'off' : 'muted'}">${r ? '● неработен ден – ' + esc(r) : 'работен ден'}</span>`;
  }
  if (!S.me || !S.sess) return;
  const left = Math.max(0, Math.round((S.sess - now()) / 1000));
  const t = $('#stimer');
  if (t) { t.textContent = mmss(left); t.parentElement.classList.toggle('warn', left <= CONFIG.WARN_SEC); }
  if (left <= 0) return signOut(true);
  if (left <= CONFIG.WARN_SEC && !$('#dlg')) askExtend();
  const dl = $('#dlg-left');
  if (dl) dl.textContent = mmss(left);
}
setInterval(tick, 1000);

function askExtend() {
  const d = dialog(`<h2>Сесията изтича</h2>
    <p>Ще излезете автоматично след <b class="mono" id="dlg-left"></b>.</p>
    <p class="small muted">Всяка сесия е 30 минути. Потвърдете, че продължавате работа, за да я удължите с още 30 минути.</p>
    <div class="row" style="justify-content:flex-end;margin-top:16px">
      <button class="btn" id="dlg-out">Изход</button><button class="btn primary" id="dlg-ext">Удължи с 30 мин.</button></div>`);
  $('#dlg-out', d).onclick = () => signOut(false);
  $('#dlg-ext', d).onclick = extend;
  tick();
}

/* удължаване: ако Google токенът изтича преди края на новата сесия, се взема нов (потвърждение в Google) */
async function extend() {
  const b = $('#dlg-ext') || $('#sext');
  if (b) b.disabled = true;
  const done = () => { closeDialog(); toast('Сесията е удължена с 30 минути.'); tick(); };
  const fail = e => { if (b) b.disabled = false; toast(typeof e === 'string' ? e : msg(e)); };
  if (S.exp - Date.now() > 31 * 60e3) {
    try { await api('extend'); done(); } catch (e) { fail(e); }
  } else {
    googleToken('', async () => { try { await api('me', { renew: true }); done(); } catch (e) { fail(e); } }, fail);
  }
}

/* ---------- екрани без вход ---------- */

const G_ICON = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function gate(note) {
  app().innerHTML = `<div class="gate"><div class="card gate-card">
    <img src="assets/logo-icon.png" alt="">
    <h1>Дела</h1>
    <p class="muted">Платформа на екипа на ЗДОИ4You за заявките за съдействие. Достъпът е само за членове на екипа.</p>
    <button class="btn google" id="login">${G_ICON}Вход с Google</button>
    <p class="note muted">Сесията е 30 минути и може да се удължи с потвърждение.</p>
    ${note ? `<p class="note muted">${esc(note)}</p>` : ''}
  </div></div>`;
  $('#login').onclick = login;
}

function denied(email) {
  clearSession();
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
    shell();
    await refresh();
    route();
  } catch (e) {
    if (!['auth', 'session', 'forbidden'].includes(e.message)) gate(msg(e));
  }
}

async function refresh() {
  const j = await api('list');
  S.items = j.items.slice().sort((a, b) => b.at.localeCompare(a.at));
  S.team = j.team; S.comments = j.comments || {};
  setUnread(j.unread || 0);
}

function setUnread(n) {
  S.unread = n;
  const b = $('#unread');
  if (b) { b.textContent = n; b.hidden = !n; }
}

function shell() {
  const me = S.me;
  app().innerHTML = `<header class="top"><div class="bar">
    <a class="brand" href="#/"><img src="assets/logo-icon.png" alt="">Дела</a>
    <nav class="tabs" aria-label="Раздели">
      <a href="#/" data-v="home">Табло</a>
      <a href="#/requests" data-v="requests">Заявки</a>
      ${can(2) ? '<a href="#/new" data-v="new">+ Нова заявка</a>' : ''}
      <a href="#/messages" data-v="messages">Съобщения <span class="badge b-bad" id="unread" hidden></span></a>
      <a href="#/calendar" data-v="calendar">Календар</a>
      ${can(3) ? '<a href="#/team" data-v="team">Екип</a><a href="#/log" data-v="log">Дневник</a>' : ''}
    </nav>
    <div class="clock small" id="clock"></div>
    <div class="user">
      <div class="sess" title="Оставащо време на сесията"><span>⏱</span> <b class="mono" id="stimer">–:––</b>
        <button class="btn ghost small" id="sext" title="Удължи сесията с 30 минути">Удължи</button></div>
      <div class="who"><b>${esc(me.name || me.email)}</b><br><span class="muted">${esc(me.role)}</span></div>
      <button class="btn" id="out">Изход</button></div>
  </div></header><main id="view"></main>`;
  $('#out').onclick = () => signOut(false);
  $('#sext').onclick = () => {
    const d = dialog(`<h2>Удължаване на сесията</h2><p>Да удължа ли сесията с още 30 минути от този момент?</p>
      <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" id="dlg-no">Отказ</button><button class="btn primary" id="dlg-ext">Удължи</button></div>`);
    $('#dlg-no', d).onclick = closeDialog;
    $('#dlg-ext', d).onclick = extend;
  };
  setUnread(S.unread);
  tick();
}

addEventListener('hashchange', () => S.me && route());

function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '').split('?')[0]);
  const [v, ...rest] = h.split('/');
  const view = { '': 'home', requests: 'requests', r: 'requests', new: 'new', messages: 'messages', calendar: 'calendar', team: 'team', log: 'log' }[v] || 'home';
  document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('on', a.dataset.v === view));
  window.scrollTo(0, 0);
  if (v === 'r' && rest.length) return detail(rest.join('/'));
  if (v === 'requests') return list();
  if (v === 'new' && can(2)) return createView();
  if (v === 'messages') return messagesView();
  if (v === 'calendar') return calendarView();
  if (v === 'team' && can(3)) return team();
  if (v === 'log' && can(3)) return logView();
  home();
}

const view = () => $('#view');

/* ---------- календар: официални празници в България и срокове (чл. 60 ГПК) ---------- */

const DAY = 864e5;
const mk = (y, m, d) => new Date(Date.UTC(y, m, d));
const key = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
function addMonths(d, n) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  return mk(y, m, Math.min(d.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate()));
}
const parseISO = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? mk(+m[1], m[2] - 1, +m[3]) : null; };
const today = () => parseISO(new Date().toLocaleDateString('en-CA', { timeZone: CONFIG.TZ }));
const WD = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];
const wd = d => WD[d.getUTCDay()];

function orthodoxEaster(y) { // юлиански Великден + 13 дни (1900–2099)
  const a = y % 4, b = y % 7, c = y % 19, d = (19 * c + 15) % 30, e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31), day = ((d + e + 114) % 31) + 1;
  return addDays(mk(y, month - 1, day), 13);
}
const FIXED = [[0, 1, 'Нова година'], [2, 3, 'Ден на Освобождението'], [4, 1, 'Ден на труда'], [4, 6, 'Гергьовден, Ден на храбростта'],
  [4, 24, 'Ден на светите Кирил и Методий'], [8, 6, 'Ден на Съединението'], [8, 22, 'Ден на Независимостта'],
  [11, 24, 'Бъдни вечер'], [11, 25, 'Рождество Христово'], [11, 26, 'Рождество Христово']];
const holCache = {};
/* официалните празници по чл. 154 КТ; празник в събота или неделя → следващият работен ден е почивен */
function holidays(y) {
  if (holCache[y]) return holCache[y];
  const map = new Map(), e = orthodoxEaster(y);
  [[-2, 'Велики петък'], [-1, 'Велика събота'], [0, 'Великден'], [1, 'Великден (понеделник)']].forEach(([o, n]) => map.set(key(addDays(e, o)), n));
  const fixed = FIXED.map(([m, d, n]) => ({ d: mk(y, m, d), n }));
  fixed.forEach(f => { const k = key(f.d); map.set(k, map.has(k) ? map.get(k) + ' и ' + f.n : f.n); });
  fixed.forEach(f => {
    const w = f.d.getUTCDay();
    if (w === 0 || w === 6) {
      let x = addDays(f.d, 1);
      while (x.getUTCDay() === 0 || x.getUTCDay() === 6 || map.has(key(x))) x = addDays(x, 1);
      map.set(key(x), 'почивен ден вместо ' + f.n);
    }
  });
  return holCache[y] = map;
}
/* причина денят да е неработен, или null */
function reason(d) {
  const h = holidays(d.getUTCFullYear()).get(key(d));
  if (h) return h;
  const w = d.getUTCDay();
  return w === 6 ? 'събота' : w === 0 ? 'неделя' : null;
}
/* срок: start + n дни/месеца; ако изтича в неработен ден – до първия следващ работен (чл. 60, ал. 6 ГПК) */
function term(start, n, unit) {
  const raw = unit === 'm' ? addMonths(start, n) : addDays(start, n);
  const moved = [];
  let end = raw, r;
  while ((r = reason(end))) { moved.push({ d: end, r }); end = addDays(end, 1); }
  return { start, raw, end, moved };
}
/* работни дни в (a, b] */
function workdays(a, b) {
  let n = 0;
  for (let x = addDays(a, 1); x <= b; x = addDays(x, 1)) if (!reason(x)) n++;
  return n;
}
const dstr = d => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;

/* изчислени срокове по данните на заявката */
function terms(o) {
  const out = [];
  if (o.kind === 'Мълчалив отказ') {
    const reg = parseISO(o.reg);
    if (reg) {
      const dec = term(reg, 14, 'd');
      out.push({ k: 'Срок за произнасяне', basis: 'чл. 28, ал. 1 ЗДОИ – 14 дни от регистриране на заявлението', t: dec });
      out.push({ k: 'Обжалване на мълчалив отказ', basis: 'чл. 149, ал. 2 АПК – 2 месеца след изтичане на срока за произнасяне', t: term(dec.end, 2, 'm'), appeal: true });
    }
  } else if (o.kind) {
    const recv = parseISO(o.recv);
    if (recv) out.push({ k: 'Обжалване на решението', basis: 'чл. 40, ал. 1 ЗДОИ, чл. 149, ал. 1 АПК – 14 дни от получаване на решението', t: term(recv, 14, 'd'), appeal: true });
  }
  return out;
}
const autoAppeal = o => { const a = terms(o).find(x => x.appeal); return a ? key(a.t.end) : ''; };

function termHtml(x, entered) {
  const t = x.t, td = today(), n = Math.round((t.end - td) / DAY);
  const left = n < 0 ? `<span class="due late">изтекъл преди ${-n} дн.</span>`
    : n === 0 ? '<span class="due soon">изтича днес</span>'
    : `<span class="due ${n <= 7 ? 'soon' : ''}">остават ${n} дн., от тях ${workdays(td, t.end)} работни</span>`;
  const mv = t.moved.length ? `<div class="small muted">${dstr(t.raw)} е неработен ден (${t.moved.map(m => esc(m.r)).join('; ')}) – срокът се премества на първия работен ден.</div>` : '';
  const diff = x.appeal && entered && entered !== key(t.end)
    ? `<div class="small" style="color:var(--warn)">⚠ Въведеният срок (${fmt(entered)}) се различава от изчисления.</div>` : '';
  return `<li><div class="row" style="justify-content:space-between"><b>${esc(x.k)}</b><span class="mono">${dstr(t.end)} (${wd(t.end)})</span></div>
    <div class="small muted">${esc(x.basis)}</div>${mv}<div class="small">${left}</div>${diff}</li>`;
}

/* ---------- помощни за показване ---------- */

function fmt(s, time) {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2})(:\d{2})?)?/.exec(s);
  if (!m) return esc(s);
  return `${m[3]}.${m[2]}.${m[1]}` + (time && m[4] ? ' ' + m[4] + (m[5] || '') : '');
}

function daysLeft(s) {
  const d = parseISO(s);
  return d ? Math.round((d - today()) / DAY) : null;
}

function due(it) {
  const d = parseISO(it.appeal);
  if (!d) return '<span class="muted">—</span>';
  if (CLOSED.includes(it.status)) return `<span class="muted mono">${dstr(d)}</span>`;
  const td = today(), n = Math.round((d - td) / DAY), r = reason(d);
  const cls = n < 0 ? 'late' : n <= 7 ? 'soon' : '';
  const t = n < 0 ? `изтекъл преди ${-n} дн.` : n === 0 ? 'днес' : `след ${n} дн., ${workdays(td, d)} работни`;
  return `<span class="due mono ${cls}">${dstr(d)}</span>${r ? ` <span class="small" style="color:var(--warn)" title="Неработен ден: ${esc(r)}">⚠</span>` : ''}<br><span class="small muted">${t}</span>`;
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
  ].concat(it.src ? [['Източник', esc(it.src)]] : []);
  const ts = terms(it);
  const kinds = S.kinds.includes(it.kind) || !it.kind ? S.kinds : [it.kind].concat(S.kinds);
  const dataForm = `<p class="small muted" style="margin:0 0 12px">Коригирайте данните, ако не съответстват на документите. Всяка промяна се записва в историята.</p>
    ${DATA_F.map(([k, l, t, n]) => `<div class="field"><label for="d-${k}">${l}</label>${
      t === 'kind' ? `<select id="d-${k}">${kinds.map(x => `<option${x === it.kind ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`
      : t === 'date' ? `<input id="d-${k}" type="date" value="${/^\d{4}-\d{2}-\d{2}$/.test(it[k]) ? esc(it[k]) : ''}">`
      : t === 'area' ? `<textarea id="d-${k}" maxlength="${n}" style="min-height:140px">${esc(it[k])}</textarea>`
      : `<input id="d-${k}" maxlength="${n}" value="${esc(it[k])}">`}</div>`).join('')}
    <div class="row" style="margin-bottom:10px"><button class="btn" id="dcalc" type="button">Изчисли срока за обжалване</button></div>
    <div class="row"><button class="btn primary" id="dsave">Запази корекциите</button><button class="btn ghost" id="dcancel">Откажи</button></div>`;

  view().innerHTML = `
    <p><a href="#/requests">← Заявки</a></p>
    <div class="head"><div class="row"><h1>${esc(it.id)}</h1>${badge(it.status)}${it.locked ? '<span class="badge b-bad">🔒 Заключена</span>' : ''}</div>
      <div class="row">
        ${files ? `<a class="btn" href="${esc(files)}" target="_blank" rel="noopener noreferrer">📁 Документи в Drive</a>` : ''}
        <a class="btn" href="#/messages?case=${encodeURIComponent(it.id)}">✉ Съобщение</a>
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
        <section class="card"><h2 style="margin-bottom:8px">Изчислени срокове</h2>
          <ul class="feed">${ts.length ? ts.map(x => termHtml(x, it.appeal)).join('') : '<li class="muted small">Няма достатъчно дати за изчисляване.</li>'}</ul>
          <p class="small muted" style="margin:6px 0 0">С отчитане на официалните празници и почивните дни.</p>
        </section>
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
  if ($('#dcalc')) $('#dcalc').onclick = () => {
    const o = Object.fromEntries(DATA_F.map(([k]) => [k, $('#d-' + k).value.trim()]));
    const a = autoAppeal(o);
    if (!a) return toast(o.kind === 'Мълчалив отказ' ? 'Въведете датата на регистриране.' : 'Въведете датата на получаване на решението.');
    $('#d-appeal').value = a; toast('Срокът е изчислен: ' + fmt(a));
  };
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

/* ---------- нова заявка (юрист и нагоре) ---------- */

function createView() {
  const f = (k, l, input) => `<div class="field"><label for="n-${k}">${l}</label>${input}</div>`;
  view().innerHTML = `
    <div class="head"><h1>Нова заявка</h1></div>
    <p class="muted" style="margin-top:-8px">Ръчно въвеждане на заявка, получена по имейл, телефон или на място. Получава № ЗС-… от общия брояч, папка в Drive и статус „Нова“.</p>
    <div class="grid cols-2">
      <section class="card">
        <h2 style="margin-bottom:12px">Заявител</h2>
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 14px">
          ${f('name', 'Име *', '<input id="n-name" maxlength="120" required>')}
          ${f('email', 'Имейл', '<input id="n-email" type="email" maxlength="200" placeholder="за връзка и уведомления">')}
          ${f('phone', 'Телефон', '<input id="n-phone" maxlength="40">')}
          ${f('city', 'Населено място', '<input id="n-city" maxlength="120">')}
        </div>
        <h2 style="margin:8px 0 12px">Отказ</h2>
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 14px">
          ${f('body', 'Задължен субект *', '<input id="n-body" maxlength="200" required>')}
          ${f('kind', 'Вид отказ *', `<select id="n-kind">${S.kinds.map(k => `<option>${esc(k)}</option>`).join('')}</select>`)}
          ${f('no', 'Вх. № на заявлението', '<input id="n-no" maxlength="60">')}
          ${f('reg', 'Дата на регистриране', '<input id="n-reg" type="date">')}
          ${f('dec', 'Дата на решението', '<input id="n-dec" type="date">')}
          ${f('recv', 'Решението е получено на', '<input id="n-recv" type="date">')}
        </div>
        ${f('desc', 'Описание', '<textarea id="n-desc" maxlength="4000" style="min-height:140px"></textarea>')}
      </section>
      <section class="card" style="align-self:start">
        <h2 style="margin-bottom:12px">Срокове</h2>
        <ul class="feed" id="n-terms"></ul>
        ${f('appeal', 'Срок за обжалване', '<input id="n-appeal" type="date">')}
        <label class="check field"><input type="checkbox" id="n-auto" checked> Изчислявай автоматично (с празниците)</label>
        <label class="check field"><input type="checkbox" id="n-notify" checked> Изпрати потвърждение на заявителя по имейл</label>
        <button class="btn primary" id="n-save">Създай заявката</button>
      </section>
    </div>`;
  const K = ['name', 'phone', 'city', 'body', 'kind', 'no', 'reg', 'dec', 'recv', 'appeal', 'desc'];
  const val = () => Object.fromEntries(K.map(k => [k, $('#n-' + k).value.trim()]));
  const recalc = () => {
    const o = val(), ts = terms(o);
    $('#n-terms').innerHTML = ts.length ? ts.map(x => termHtml(x)).join('')
      : `<li class="muted small">Въведете ${o.kind === 'Мълчалив отказ' ? 'датата на регистриране' : 'датата на получаване на решението'}, за да се изчислят сроковете.</li>`;
    if ($('#n-auto').checked) $('#n-appeal').value = autoAppeal(o);
  };
  ['kind', 'reg', 'recv'].forEach(k => $('#n-' + k).addEventListener('change', recalc));
  $('#n-auto').onchange = recalc;
  $('#n-appeal').addEventListener('input', () => { $('#n-auto').checked = false; });
  recalc();
  $('#n-save').onclick = async () => {
    const fields = val();
    if (!fields.name || !fields.body) return toast(ERR.fields);
    const b = $('#n-save'); b.disabled = true;
    try {
      const r = await api('create', { fields, email: $('#n-email').value.trim(), notify: $('#n-notify').checked });
      toast(`Заявка ${r.id} е създадена.`);
      await refresh();
      location.hash = '#/r/' + encodeURIComponent(r.id);
    } catch (e) { toast(msg(e)); b.disabled = false; }
  };
}

/* ---------- съобщения ---------- */

async function messagesView(prefill) {
  view().innerHTML = '<p class="muted"><span class="spin"></span> Зареждане…</p>';
  let list;
  try { list = (await api('msgList')).messages; } catch (e) { view().innerHTML = `<div class="banner bad">${esc(msg(e))}</div>`; return; }
  const adm = can(3);
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const pre = Object.assign({ to: q.get('to') || 'admins', case: q.get('case') || '' }, prefill || {});
  const toName = t => t === 'admins' ? 'Администраторите' : who(t);
  view().innerHTML = `
    <div class="head"><h1>Съобщения</h1>${reloadBtn()}</div>
    <div class="grid cols-2">
      <section class="card">
        <ul class="feed">${list.length ? list.map(m => `<li${m.read ? '' : ' class="unread"'}>
          <div class="meta">${m.read ? '' : '<span class="badge b-new">ново</span> '}<b>${who(m.from)}</b> → ${toName(m.to)} · <span class="mono">${fmt(m.at, true)}</span>
            ${m.case ? ` · <a href="#/r/${encodeURIComponent(m.case)}">${esc(m.case)}</a>` : ''}</div>
          <div class="txt">${esc(m.text)}</div>
          ${adm && m.from !== S.me.email ? `<button class="btn ghost small" data-re="${esc(m.from)}" data-case="${esc(m.case)}">↩ Отговори</button>` : ''}
        </li>`).join('') : '<li class="muted">Няма съобщения.</li>'}</ul>
      </section>
      <section class="card" style="align-self:start"><h2 style="margin-bottom:12px">Ново съобщение</h2>
        <div class="field"><label for="m-to">До</label><select id="m-to" ${adm ? '' : 'disabled'}>
          <option value="admins">Администраторите</option>
          ${adm ? S.team.filter(m => m.email !== S.me.email).map(m => `<option value="${esc(m.email)}">${esc(m.name || m.email)} · ${esc(m.role)}</option>`).join('') : ''}
        </select></div>
        <div class="field"><label for="m-case">Преписка (по желание)</label><input id="m-case" list="m-cases" placeholder="ЗС-…" value="${esc(pre.case)}">
          <datalist id="m-cases">${S.items.slice(0, 300).map(it => `<option value="${esc(it.id)}">${esc(it.body)}</option>`).join('')}</datalist></div>
        <div class="field"><label for="m-text">Съобщение</label><textarea id="m-text" maxlength="4000" style="min-height:140px"></textarea></div>
        <button class="btn primary" id="m-send">Изпрати</button>
        <p class="small muted" style="margin-top:10px">${adm ? 'Можете да пишете до всички администратори или до конкретен член на екипа.' : 'Съобщението отива до всички администратори и те получават имейл.'}</p>
      </section>
    </div>`;
  if (adm) $('#m-to').value = S.team.some(m => m.email === pre.to) ? pre.to : 'admins';
  view().querySelectorAll('[data-re]').forEach(b => b.onclick = () => {
    $('#m-to').value = S.team.some(m => m.email === b.dataset.re) ? b.dataset.re : 'admins';
    $('#m-case').value = b.dataset.case || '';
    $('#m-text').focus();
  });
  $('#m-send').onclick = async () => {
    const text = $('#m-text').value.trim();
    if (!text) return toast(ERR.fields);
    const b = $('#m-send'); b.disabled = true;
    try {
      await api('msgSend', { to: adm ? $('#m-to').value : 'admins', case: $('#m-case').value.trim(), text });
      toast('Съобщението е изпратено.');
      history.replaceState(null, '', '#/messages');
      messagesView();
    } catch (e) { toast(msg(e)); b.disabled = false; }
  };
  bindReload(() => messagesView());
  const unread = list.filter(m => !m.read).map(m => m.id);
  if (unread.length) { try { await api('msgRead', { ids: unread }); } catch (e) { /* ignore */ } }
  setUnread(0);
}

/* ---------- календар ---------- */

function calendarView() {
  const y0 = today().getUTCFullYear();
  const y = +(new URLSearchParams(location.hash.split('?')[1] || '').get('y')) || y0;
  const td = today();
  const hol = [...holidays(y).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const start = mk(y, 0, 1), end = mk(y, 11, 31);
  const work = workdays(addDays(start, -1), end);
  const next = [...holidays(y0).entries(), ...holidays(y0 + 1).entries()].map(([k, n]) => [parseISO(k), n]).filter(([d]) => d >= td).sort((a, b) => a[0] - b[0])[0];
  view().innerHTML = `
    <div class="head"><h1>Календар</h1>
      <div class="row"><a class="btn" href="#/calendar?y=${y - 1}">← ${y - 1}</a><b style="padding:0 6px">${y}</b><a class="btn" href="#/calendar?y=${y + 1}">${y + 1} →</a></div></div>
    <div class="stats">
      <div class="card stat"><b>${work}</b><span>работни дни през ${y}</span></div>
      <div class="card stat"><b>${hol.length}</b><span>празнични и почивни дни (без съботи и недели)</span></div>
      ${next ? `<div class="card stat"><b style="font-size:20px">${dstr(next[0])}</b><span>следващ празник: ${esc(next[1])}${+next[0] === +td ? ' (днес)' : ` – след ${Math.round((next[0] - td) / DAY)} дн.`}</span></div>` : ''}
    </div>
    <div class="grid cols-2">
      <div class="tbl-wrap"><table><thead><tr><th>Дата</th><th>Ден</th><th>Празник</th></tr></thead><tbody>
        ${hol.map(([k, n]) => { const d = parseISO(k); return `<tr${d < td ? ' class="past"' : ''}${+d === +td ? ' style="font-weight:600"' : ''}>
          <td class="mono">${dstr(d)}</td><td>${wd(d)}</td><td>${esc(n)}</td></tr>`; }).join('')}
      </tbody></table></div>
      <section class="card" style="align-self:start"><h2 style="margin-bottom:12px">Изчисляване на срок</h2>
        <div class="field"><label for="c-from">Начална дата (събитието)</label><input id="c-from" type="date" value="${key(td)}"></div>
        <div class="row" style="align-items:flex-end">
          <div class="field" style="flex:1"><label for="c-n">Срок</label><input id="c-n" type="number" min="1" max="999" value="14"></div>
          <div class="field" style="flex:1"><label for="c-u">&nbsp;</label><select id="c-u"><option value="d">дни</option><option value="m">месеца</option></select></div>
        </div>
        <div id="c-out"></div>
        <p class="small muted" style="margin-top:10px">Денят на събитието не се брои. Срок, който изтича в неработен ден, изтича в първия следващ работен ден (чл. 60, ал. 6 ГПК, чл. 1 ГПК вр. чл. 144 АПК).
          Празниците са по чл. 154 КТ. Допълнителните неработни дни, обявени с решение на Министерския съвет, не са включени.</p>
      </section>
    </div>`;
  const calc = () => {
    const d = parseISO($('#c-from').value), n = Math.max(1, Math.min(999, +$('#c-n').value || 0));
    if (!d) { $('#c-out').innerHTML = ''; return; }
    $('#c-out').innerHTML = `<ul class="feed">${termHtml({ k: 'Срокът изтича', basis: `${dstr(d)} + ${n} ${$('#c-u').value === 'm' ? 'месеца' : 'дни'}`, t: term(d, n, $('#c-u').value) })}</ul>`;
  };
  ['c-from', 'c-n', 'c-u'].forEach(id => $('#' + id).addEventListener('input', calc));
  calc();
}

/* ---------- старт ---------- */

restore();
if (S.token) start(); else gate();
