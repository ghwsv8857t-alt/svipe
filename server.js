'use strict';
/*
 * Svipe: сервер мессенджера без внешних зависимостей (нужен только Node.js 18+).
 *  - вход и регистрация по коду из письма (SMTP);
 *  - сессии в cookie, чаты, сообщения, настройки;
 *  - новые сообщения приходят мгновенно через Server-Sent Events.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const tls = require('tls');

/* ---------- .env ---------- */
try {
  const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  txt.split(/\r?\n/).forEach((line) => {
    if (/^\s*#/.test(line)) return;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
} catch (e) { /* .env не обязателен */ }

const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
const smtpPort = Number(process.env.SMTP_PORT) || 587;
const cfg = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '127.0.0.1',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  trustProxy: process.env.TRUST_PROXY === '1',
  cookieSecure: process.env.COOKIE_SECURE === '1',
  mailFrom: oneLine(process.env.MAIL_FROM || 'Svipe <no-reply@localhost>'),
  smtp: process.env.SMTP_HOST
    ? {
        host: oneLine(process.env.SMTP_HOST),
        port: smtpPort,
        secure: smtpPort === 465 || process.env.SMTP_SECURE === '1',
        user: process.env.SMTP_USER ? oneLine(process.env.SMTP_USER) : '',
        pass: process.env.SMTP_PASS || '',
      }
    : null,
};

const CODE_TTL = 10 * 60e3;
const RESEND_MS = 60e3;
const MAX_ATTEMPTS = 5;
const SESSION_TTL = 30 * 24 * 3600e3;
const SYS_ID = 'u_svipe';
const PUBLIC_DIR = path.join(__dirname, 'public');
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/;
const RESERVED = new Set(['svipe', 'admin', 'support', 'help', 'root', 'system', 'moderator', 'api']);
const ACCENTS = ['blue', 'cyan', 'violet', 'mint'];
const DEFAULT_SETTINGS = { accent: 'blue', blur: 50, sound: true, orbs: true };

/* ---------- хранилище (JSON-файл) ---------- */
const DB_FILE = path.join(cfg.dataDir, 'db.json');
let db = { secret: '', users: {}, sessions: {}, codes: {}, chats: {}, messages: {}, reads: {} };
try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (e) { /* первый запуск */ }

let saveTimer = null;
function writeNow() {
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('Не удалось сохранить данные:', e.message);
  }
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 250);
}
function flushAndExit() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeNow();
  process.exit(0);
}
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);

if (!db.secret) { db.secret = crypto.randomBytes(32).toString('hex'); writeNow(); }

const emailIdx = new Map();
const nameIdx = new Map();
const userChats = new Map();
function indexUser(u) {
  if (u.email) emailIdx.set(u.email, u.id);
  nameIdx.set(u.username, u.id);
}
function indexChat(c) {
  c.members.forEach((uid) => {
    if (!userChats.has(uid)) userChats.set(uid, new Set());
    userChats.get(uid).add(c.id);
  });
}
function addChat(c) {
  db.chats[c.id] = c;
  if (!db.messages[c.id]) db.messages[c.id] = [];
  indexChat(c);
  return c;
}
if (!db.users[SYS_ID]) {
  db.users[SYS_ID] = { id: SYS_ID, email: '', name: 'Svipe', username: 'svipe', bio: 'Официальный аккаунт', system: true, createdAt: Date.now(), settings: { ...DEFAULT_SETTINGS } };
  save();
}
Object.values(db.users).forEach(indexUser);
Object.values(db.chats).forEach(indexChat);

/* ---------- утилиты ---------- */
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}
const fail = (status, msg, extra) => { throw new HttpError(status, msg, extra); };

const limits = new Map();
function hit(key, max, windowMs) {
  const now = Date.now();
  let r = limits.get(key);
  if (!r || r.reset < now) { r = { n: 0, reset: now + windowMs }; limits.set(key, r); }
  r.n++;
  return r.n <= max;
}
setInterval(() => {
  const now = Date.now();
  limits.forEach((r, k) => { if (r.reset < now) limits.delete(k); });
  Object.keys(db.codes).forEach((k) => { if (db.codes[k].expires < now) delete db.codes[k]; });
  Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].created + SESSION_TTL < now) delete db.sessions[k]; });
  save();
}, 10 * 60e3).unref();

const EMAIL_RE = /^[^\s@<>"',;:()\[\]\\]+@[^\s@<>"',;:()\[\]\\]+\.[^\s@<>"',;:()\[\]\\]{2,}$/;
function normEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : '';
}
const cleanName = (v) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
const hashCode = (email, code) => crypto.createHmac('sha256', db.secret).update(email + ':' + code).digest('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function safeEq(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- почта (SMTP без библиотек) ---------- */
function smtpConnect({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: host };
    const s = secure ? tls.connect(opts) : net.connect(opts);
    const t = setTimeout(() => { s.destroy(); reject(new Error('SMTP: сервер не отвечает')); }, 15000);
    s.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}
function smtpReader(sock) {
  let buf = '';
  let waiting = null;
  const pump = () => {
    if (!waiting) return;
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3}( |$)/.test(lines[i])) {
        const resp = lines.slice(0, i + 1);
        buf = lines.slice(i + 1).join('\r\n');
        const w = waiting;
        waiting = null;
        clearTimeout(w.timer);
        return w.resolve({ code: Number(resp[0].slice(0, 3)), lines: resp });
      }
    }
  };
  sock.on('data', (d) => { buf += d.toString('utf8'); pump(); });
  const fin = (err) => { if (waiting) { const w = waiting; waiting = null; clearTimeout(w.timer); w.reject(err); } };
  sock.on('error', fin);
  sock.on('close', () => fin(new Error('SMTP: соединение закрыто')));
  return {
    read: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting = null; reject(new Error('SMTP: нет ответа от сервера')); }, 20000);
      waiting = { resolve, reject, timer };
      pump();
    }),
  };
}
function mimeMessage({ from, to, subject, text, html }) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
  const boundary = 'svipe_' + crypto.randomBytes(12).toString('hex');
  const domain = (from.match(/@([^>\s]+)/) || [])[1] || 'localhost';
  const parts = [
    `From: ${from}`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    `--${boundary}--`,
    '',
  ];
  return parts.join('\r\n');
}
async function smtpSend({ to, subject, text, html }) {
  const c = cfg.smtp;
  const fromAddr = (cfg.mailFrom.match(/<([^>]+)>/) || [null, cfg.mailFrom])[1].trim();
  let sock = await smtpConnect(c);
  let rd = smtpReader(sock);
  const cmd = async (line, ok) => {
    if (line !== null) sock.write(line + '\r\n');
    const r = await rd.read();
    if (!ok.includes(r.code)) throw new Error('SMTP ' + r.lines.join(' | '));
    return r;
  };
  try {
    await cmd(null, [220]);
    let r = await cmd('EHLO svipe.local', [250]);
    if (!c.secure && r.lines.some((l) => /STARTTLS/i.test(l))) {
      await cmd('STARTTLS', [220]);
      sock.removeAllListeners('data');
      sock.removeAllListeners('error');
      sock.removeAllListeners('close');
      const plain = sock;
      sock = tls.connect({ socket: plain, servername: c.host });
      await new Promise((resolve, reject) => { sock.once('secureConnect', resolve); sock.once('error', reject); });
      rd = smtpReader(sock);
      r = await cmd('EHLO svipe.local', [250]);
    }
    if (c.user) {
      const token = Buffer.from('\u0000' + c.user + '\u0000' + c.pass, 'utf8').toString('base64');
      await cmd('AUTH PLAIN ' + token, [235]);
    }
    await cmd(`MAIL FROM:<${fromAddr}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);
    sock.write(mimeMessage({ from: cfg.mailFrom, to, subject, text, html }) + '\r\n.\r\n');
    await cmd(null, [250]);
    try { await cmd('QUIT', [221]); } catch (e) { /* не важно */ }
  } finally {
    sock.destroy();
  }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
async function sendCodeMail(to, code, name) {
  if (!cfg.smtp) {
    console.log(`\n  [Svipe] Почта не настроена. Код для ${to}: ${code}\n`);
    return 'console';
  }
  const hello = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';
  const text = `${hello}\n\nВаш код для входа в Svipe: ${code}\n\nКод действует 10 минут. Если вы не запрашивали код, просто проигнорируйте это письмо.`;
  const html = `<!doctype html><html lang="ru"><body style="margin:0;background:#040c22;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#eef4ff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="420" cellpadding="0" cellspacing="0" style="max-width:420px;background:#0b2250;border-radius:24px;padding:32px">
<tr><td style="font-size:26px;font-weight:700;letter-spacing:-.5px">Svipe</td></tr>
<tr><td style="padding-top:18px;font-size:15px;line-height:1.5;color:#c9d8f5">${esc(hello)}<br>Ваш код для входа:</td></tr>
<tr><td style="padding:18px 0;font-size:38px;font-weight:700;letter-spacing:10px;color:#ffffff">${esc(code)}</td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#9db1d6">Код действует 10 минут. Если вы не запрашивали код, просто проигнорируйте это письмо.</td></tr>
</table></td></tr></table></body></html>`;
  await smtpSend({ to, subject: `Код входа в Svipe: ${code}`, text, html });
  return 'email';
}

/* ---------- пользователи, чаты ---------- */
function pushMessage(chatId, from, text, ts, extra) {
  const list = db.messages[chatId] || (db.messages[chatId] = []);
  const last = list[list.length - 1];
  let t = ts || Date.now();
  if (last && t <= last.ts) t = last.ts + 1;
  const m = { id: 'm_' + crypto.randomBytes(6).toString('hex'), from, text, ts: t };
  if (extra) Object.assign(m, extra);
  list.push(m);
  return m;
}
function createUser(email, name) {
  const id = 'u_' + crypto.randomBytes(6).toString('hex');
  let username;
  do { username = 'user' + crypto.randomInt(100000, 999999); } while (nameIdx.has(username));
  const user = { id, email, name, username, bio: '', createdAt: Date.now(), settings: { ...DEFAULT_SETTINGS } };
  db.users[id] = user;
  indexUser(user);
  addChat({ id: 's_' + id, kind: 'saved', members: [id], createdAt: Date.now() });
  const welcome = addChat({ id: 'd_' + [SYS_ID, id].sort().join('_'), kind: 'direct', members: [SYS_ID, id], createdAt: Date.now(), createdBy: SYS_ID, readonly: true });
  pushMessage(welcome.id, SYS_ID, `Привет, ${name}! Это Svipe, мессенджер на жидком стекле.`);
  pushMessage(welcome.id, SYS_ID, 'Чтобы начать диалог, нажмите «+» вверху и введите e-mail или @username человека, который уже есть в Svipe. Заметки для себя храните в «Избранном». Внешний вид можно поменять в настройках.');
  save();
  return user;
}
function getOrCreateDirect(a, b) {
  const id = 'd_' + [a, b].sort().join('_');
  if (db.chats[id]) return db.chats[id];
  return addChat({ id, kind: 'direct', members: [a, b], createdAt: Date.now(), createdBy: a });
}
function summary(chat, uid) {
  const peerId = chat.members.find((m) => m !== uid) || uid;
  const peer = db.users[peerId] || { name: 'Удалённый аккаунт', username: '', id: peerId };
  const msgs = db.messages[chat.id] || [];
  const last = msgs[msgs.length - 1];
  const readTs = (db.reads[chat.id] && db.reads[chat.id][uid]) || 0;
  let unread = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].ts <= readTs) break;
    if (msgs[i].from !== uid) unread++;
  }
  const saved = chat.kind === 'saved';
  return {
    id: chat.id,
    kind: chat.kind,
    title: saved ? 'Избранное' : peer.name,
    username: saved ? null : peer.username,
    peerId: saved ? null : peer.id,
    system: !saved && !!peer.system,
    readonly: !!chat.readonly,
    last: last ? { text: last.text.slice(0, 140), ts: last.ts, mine: last.from === uid } : null,
    unread,
    updatedAt: last ? last.ts : chat.createdAt,
  };
}
const selfView = (u) => ({ id: u.id, email: u.email, name: u.name, username: u.username, bio: u.bio, settings: u.settings });
function chatFor(user, id) {
  const chat = db.chats[id];
  if (!chat || !chat.members.includes(user.id)) fail(404, 'Чат не найден.');
  return chat;
}

/* ---------- сессии ---------- */
function parseCookies(req) {
  const o = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) { try { o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) { /* пропускаем */ } }
  });
  return o;
}
function sessionUser(req) {
  const token = parseCookies(req).svipe_sid;
  if (!token || token.length > 100) return null;
  const key = sha(token);
  const s = db.sessions[key];
  if (!s || s.created + SESSION_TTL < Date.now()) return null;
  const u = db.users[s.uid];
  if (!u) return null;
  if (Date.now() - s.seen > 3600e3) { s.seen = Date.now(); save(); }
  req.sessionKey = key;
  return u;
}
function setCookie(req, res, token, maxAgeSec) {
  const secure = cfg.cookieSecure || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `svipe_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}
function startSession(req, res, uid) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[sha(token)] = { uid, created: Date.now(), seen: Date.now() };
  save();
  setCookie(req, res, token, SESSION_TTL / 1000);
}

/* ---------- события в реальном времени (SSE) ---------- */
const streams = new Map();
function emit(uid, event, data) {
  const set = streams.get(uid);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  set.forEach((r) => { try { r.write(payload); } catch (e) { /* закрыто */ } });
}
setInterval(() => streams.forEach((set) => set.forEach((r) => { try { r.write(': ping\n\n'); } catch (e) { /* закрыто */ } })), 25e3).unref();

/* ---------- звонки (WebRTC): сервер только передаёт сигналы между двумя людьми ---------- */
const calls = new Map();
const userCall = new Map();
const RING_MS = 45e3;
const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL.split(',').map((x) => x.trim()).filter(Boolean),
    username: process.env.TURN_USER || '',
    credential: process.env.TURN_PASS || '',
  });
}
const fmtDur = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
const sendCall = (uid, payload) => emit(uid, 'call', payload);

function endCall(call, status, by) {
  if (call.state === 'ended') return;
  call.state = 'ended';
  clearTimeout(call.timer);
  calls.delete(call.id);
  if (userCall.get(call.caller) === call.id) userCall.delete(call.caller);
  if (userCall.get(call.callee) === call.id) userCall.delete(call.callee);
  const duration = call.answeredAt ? Math.max(0, Math.round((Date.now() - call.answeredAt) / 1000)) : 0;
  const chat = db.chats[call.chatId];
  if (chat) {
    const kind = call.video ? 'видеозвонок' : 'звонок';
    const text = status === 'ended'
      ? (call.video ? 'Видеозвонок' : 'Голосовой звонок') + ', ' + fmtDur(duration)
      : (status === 'declined' ? 'Отклонённый ' : 'Пропущенный ') + kind;
    const m = pushMessage(chat.id, call.caller, text, undefined, { call: { video: call.video, status, duration } });
    const rd = db.reads[chat.id] || (db.reads[chat.id] = {});
    rd[call.caller] = m.ts;
    if (status !== 'missed') rd[call.callee] = m.ts;
    save();
    chat.members.forEach((uid) => emit(uid, 'msg', { chatId: chat.id, message: m, chat: summary(chat, uid) }));
  }
  [call.caller, call.callee].forEach((uid) => sendCall(uid, { type: 'end', callId: call.id, status, duration, by: by || null }));
}

/* ---------- маршруты API ---------- */
const routes = [];
const route = (method, re, opts, fn) => routes.push({ method, re, auth: opts.auth !== false, fn });

route('POST', /^\/api\/auth\/request$/, { auth: false }, async ({ body, ip }) => {
  const email = normEmail(body.email);
  if (!email) fail(400, 'Введите e-mail полностью, например name@mail.ru.');
  const mode = body.mode === 'login' ? 'login' : 'signup';
  let name = '';
  if (mode === 'signup') {
    name = cleanName(body.name);
    if (name.length < 2) fail(400, 'Введите имя, минимум 2 символа.');
  }
  if (!hit('ip:' + ip, 30, 3600e3) || !hit('em:' + email, 6, 3600e3)) fail(429, 'Слишком много попыток. Подождите немного и попробуйте снова.');
  const exists = emailIdx.has(email);
  if (mode === 'login' && !exists) fail(404, 'Аккаунт с таким e-mail не найден. Создайте новый.', { code: 'no_account' });
  if (mode === 'signup' && exists) fail(409, 'Этот e-mail уже зарегистрирован. Войдите.', { code: 'exists' });
  const prev = db.codes[email];
  if (prev && Date.now() - prev.sentAt < RESEND_MS) {
    const left = Math.ceil((RESEND_MS - (Date.now() - prev.sentAt)) / 1000);
    fail(429, `Новый код можно запросить через ${left} с.`, { retryIn: left });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.codes[email] = { hash: hashCode(email, code), mode, name, expires: Date.now() + CODE_TTL, attempts: 0, sentAt: Date.now() };
  save();
  try {
    const via = await sendCodeMail(email, code, name);
    return { ok: true, via, resendIn: RESEND_MS / 1000 };
  } catch (e) {
    delete db.codes[email];
    console.error('Ошибка отправки письма:', e.message);
    fail(502, 'Не удалось отправить письмо. Проверьте настройки почты на сервере.');
  }
});

route('POST', /^\/api\/auth\/verify$/, { auth: false }, ({ req, res, body, ip }) => {
  const email = normEmail(body.email);
  const code = String(body.code || '').replace(/\D/g, '');
  if (!email || code.length !== 6) fail(400, 'Введите 6 цифр из письма.');
  if (!hit('v:' + ip, 40, 3600e3)) fail(429, 'Слишком много попыток. Подождите немного.');
  const rec = db.codes[email];
  if (!rec || rec.expires < Date.now()) fail(400, 'Код истёк. Запросите новый.', { code: 'expired' });
  if (rec.attempts >= MAX_ATTEMPTS) { delete db.codes[email]; save(); fail(429, 'Слишком много неверных попыток. Запросите новый код.', { code: 'expired' }); }
  rec.attempts++;
  if (!safeEq(rec.hash, hashCode(email, code))) {
    save();
    fail(400, `Неверный код. Осталось попыток: ${MAX_ATTEMPTS - rec.attempts}.`);
  }
  delete db.codes[email];
  let user = db.users[emailIdx.get(email)];
  if (!user) {
    if (rec.mode !== 'signup') fail(404, 'Аккаунт не найден.');
    user = createUser(email, rec.name || 'Новый пользователь');
  }
  startSession(req, res, user.id);
  return { user: selfView(user) };
});

route('POST', /^\/api\/auth\/logout$/, {}, ({ req, res }) => {
  delete db.sessions[req.sessionKey];
  save();
  setCookie(req, res, '', 0);
  return { ok: true };
});
route('POST', /^\/api\/auth\/logout-all$/, {}, ({ req, res, user }) => {
  Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].uid === user.id) delete db.sessions[k]; });
  save();
  setCookie(req, res, '', 0);
  const set = streams.get(user.id);
  if (set) { set.forEach((r) => { try { r.end(); } catch (e) { /* закрыто */ } }); streams.delete(user.id); }
  return { ok: true };
});

route('GET', /^\/api\/me$/, {}, ({ user }) => ({ user: selfView(user) }));

route('PATCH', /^\/api\/me$/, {}, ({ user, body }) => {
  const next = {};
  if ('name' in body) {
    const n = cleanName(body.name);
    if (n.length < 2) fail(400, 'Имя: минимум 2 символа.');
    next.name = n;
  }
  if ('username' in body) {
    const un = String(body.username || '').trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(un)) fail(400, 'Имя пользователя: 3–20 символов, латиница, цифры и _, первая буква обязательно.');
    if (RESERVED.has(un) || (nameIdx.has(un) && nameIdx.get(un) !== user.id)) fail(409, 'Это имя пользователя уже занято.');
    next.username = un;
  }
  if ('bio' in body) next.bio = String(body.bio || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140);
  if (body.settings && typeof body.settings === 'object') {
    const s = body.settings;
    const out = { ...user.settings };
    if ('accent' in s) { if (!ACCENTS.includes(s.accent)) fail(400, 'Неизвестный цвет.'); out.accent = s.accent; }
    if ('blur' in s) { const b = Number(s.blur); if (!Number.isFinite(b)) fail(400, 'Неверное значение размытия.'); out.blur = Math.max(0, Math.min(100, Math.round(b))); }
    if ('sound' in s) out.sound = !!s.sound;
    if ('orbs' in s) out.orbs = !!s.orbs;
    next.settings = out;
  }
  if (next.username && next.username !== user.username) { nameIdx.delete(user.username); nameIdx.set(next.username, user.id); }
  Object.assign(user, next);
  save();
  return { user: selfView(user) };
});

route('GET', /^\/api\/chats$/, {}, ({ user }) => {
  const ids = userChats.get(user.id) || new Set();
  const list = [];
  ids.forEach((id) => {
    const c = db.chats[id];
    if (!c) return;
    const has = (db.messages[id] || []).length > 0;
    if (c.kind === 'saved' || has || c.createdBy === user.id) list.push(summary(c, user.id));
  });
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return { chats: list };
});

route('POST', /^\/api\/chats$/, {}, ({ user, body }) => {
  if (!hit('nc:' + user.id, 30, 3600e3)) fail(429, 'Слишком много поисков. Подождите немного.');
  const q = String(body.query || '').trim().toLowerCase();
  if (!q || q.length > 254) fail(400, 'Введите e-mail или @username.');
  let target = null;
  if (q.startsWith('@')) target = db.users[nameIdx.get(q.slice(1))];
  else if (q.includes('@')) target = db.users[emailIdx.get(normEmail(q))];
  else target = db.users[nameIdx.get(q)];
  if (!target) fail(404, 'Пользователь не найден. Он должен сначала зарегистрироваться в Svipe.');
  const chat = target.id === user.id ? db.chats['s_' + user.id] : getOrCreateDirect(user.id, target.id);
  save();
  return { chat: summary(chat, user.id) };
});

route('GET', /^\/api\/chats\/([^/]+)\/messages$/, {}, ({ user, params, url }) => {
  const chat = chatFor(user, params[0]);
  const before = Number(url.searchParams.get('before')) || Infinity;
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 100));
  const all = db.messages[chat.id] || [];
  const eligible = before === Infinity ? all : all.filter((m) => m.ts < before);
  const slice = eligible.slice(-limit);
  return { messages: slice, hasMore: eligible.length > slice.length };
});

route('POST', /^\/api\/chats\/([^/]+)\/messages$/, {}, ({ user, params, body }) => {
  const chat = chatFor(user, params[0]);
  if (chat.readonly) fail(403, 'В этот чат нельзя писать.');
  const text = String(body.text || '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!text) fail(400, 'Сообщение пустое.');
  if (text.length > 4000) fail(400, 'Сообщение слишком длинное, максимум 4000 символов.');
  if (!hit('msg:' + user.id, 60, 60e3)) fail(429, 'Вы отправляете сообщения слишком часто. Подождите немного.');
  const m = pushMessage(chat.id, user.id, text);
  (db.reads[chat.id] || (db.reads[chat.id] = {}))[user.id] = m.ts;
  save();
  chat.members.forEach((uid) => emit(uid, 'msg', { chatId: chat.id, message: m, chat: summary(chat, uid) }));
  return { message: m, chat: summary(chat, user.id) };
});

route('POST', /^\/api\/chats\/([^/]+)\/read$/, {}, ({ user, params }) => {
  const chat = chatFor(user, params[0]);
  (db.reads[chat.id] || (db.reads[chat.id] = {}))[user.id] = Date.now() + 1;
  save();
  emit(user.id, 'read', { chatId: chat.id });
  return { ok: true };
});

route('GET', /^\/api\/calls\/config$/, {}, () => ({ iceServers }));

route('POST', /^\/api\/calls\/invite$/, {}, ({ user, body }) => {
  const chat = chatFor(user, String(body.chatId || ''));
  if (chat.kind !== 'direct') fail(400, 'Звонки доступны только в личных чатах.');
  const peerId = chat.members.find((m) => m !== user.id);
  const peer = db.users[peerId];
  if (!peer || peer.system) fail(400, 'Этому аккаунту нельзя позвонить.');
  if (!hit('call:' + user.id, 40, 3600e3)) fail(429, 'Слишком много звонков. Подождите немного.');
  if (userCall.has(user.id)) fail(409, 'У вас уже идёт звонок.', { code: 'busy_self' });
  if (userCall.has(peerId)) fail(409, 'Абонент занят другим звонком.', { code: 'busy' });
  if (!streams.has(peerId)) fail(409, 'Пользователь сейчас не в сети.', { code: 'offline' });
  const call = {
    id: 'c_' + crypto.randomBytes(8).toString('hex'), chatId: chat.id, caller: user.id, callee: peerId,
    video: !!body.video, state: 'ringing', createdAt: Date.now(), answeredAt: 0, timer: null,
  };
  call.timer = setTimeout(() => endCall(call, 'missed', null), RING_MS);
  calls.set(call.id, call);
  userCall.set(user.id, call.id);
  userCall.set(peerId, call.id);
  sendCall(peerId, { type: 'invite', callId: call.id, chatId: chat.id, video: call.video, from: { id: user.id, name: user.name, username: user.username } });
  return { callId: call.id, ringMs: RING_MS };
});

route('POST', /^\/api\/calls\/([^/]+)\/signal$/, {}, ({ user, params, body }) => {
  if (!hit('sig:' + user.id, 900, 60e3)) fail(429, 'Слишком много сигналов.');
  const call = calls.get(params[0]);
  if (!call || (call.caller !== user.id && call.callee !== user.id)) fail(404, 'Звонок не найден.');
  const type = String(body.type || '');
  const isCaller = call.caller === user.id;
  const other = isCaller ? call.callee : call.caller;
  const data = body.data;
  if (data !== undefined && (typeof data !== 'object' || data === null || JSON.stringify(data).length > 20000)) fail(400, 'Некорректные данные.');
  const ringing = call.state === 'ringing';
  const active = call.state === 'active';
  switch (type) {
    case 'accept':
      if (isCaller || !ringing) fail(409, 'Нельзя принять этот звонок.');
      call.state = 'active';
      call.answeredAt = Date.now();
      clearTimeout(call.timer);
      sendCall(other, { type: 'accept', callId: call.id });
      sendCall(user.id, { type: 'taken', callId: call.id });
      break;
    case 'decline':
      if (isCaller || !ringing) fail(409, 'Нельзя отклонить этот звонок.');
      sendCall(user.id, { type: 'taken', callId: call.id });
      endCall(call, 'declined', user.id);
      break;
    case 'cancel':
      if (!isCaller || !ringing) fail(409, 'Нельзя отменить этот звонок.');
      endCall(call, 'missed', user.id);
      break;
    case 'hangup':
      if (ringing) endCall(call, isCaller ? 'missed' : 'declined', user.id);
      else endCall(call, 'ended', user.id);
      break;
    case 'offer':
      if (!isCaller || !active || !data) fail(409, 'Лишний сигнал.');
      sendCall(other, { type: 'offer', callId: call.id, data });
      break;
    case 'answer':
      if (isCaller || !active || !data) fail(409, 'Лишний сигнал.');
      sendCall(other, { type: 'answer', callId: call.id, data });
      break;
    case 'candidate':
      if (!active || !data) fail(409, 'Лишний сигнал.');
      sendCall(other, { type: 'candidate', callId: call.id, data });
      break;
    default:
      fail(400, 'Неизвестный сигнал.');
  }
  return { ok: true };
});

route('GET', /^\/api\/events$/, {}, ({ req, res, user }) => {
  const set = streams.get(user.id) || new Set();
  if (set.size >= 10) fail(429, 'Слишком много открытых вкладок.');
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  res.write('event: ready\ndata: {}\n\n');
  set.add(res);
  streams.set(user.id, set);
  req.on('close', () => {
    set.delete(res);
    if (set.size) return;
    streams.delete(user.id);
    const cid = userCall.get(user.id);
    if (cid) {
      setTimeout(() => {
        const c = calls.get(cid);
        if (!c || streams.has(user.id)) return;
        endCall(c, c.state === 'active' ? 'ended' : (c.caller === user.id ? 'missed' : 'declined'), user.id);
      }, 12e3).unref();
    }
  });
  return null;
});

/* ---------- HTTP ---------- */
function clientIp(req) {
  if (cfg.trustProxy) {
    const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f;
  }
  return req.socket.remoteAddress || 'unknown';
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new HttpError(413, 'Запрос слишком большой.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      if (!/^application\/json/i.test(String(req.headers['content-type'] || ''))) return reject(new HttpError(415, 'Нужен JSON.'));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch (e) { reject(new HttpError(400, 'Некорректный запрос.')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
async function handleApi(req, res, url) {
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch (e) { ok = false; }
      if (!ok) return sendJson(res, 403, { error: 'Запрещено.' });
    }
  }
  const r = routes.find((x) => x.method === method && x.re.test(url.pathname));
  if (!r) return sendJson(res, 404, { error: 'Не найдено.' });
  const ctx = { req, res, url, ip: clientIp(req), params: url.pathname.match(r.re).slice(1), body: {}, user: null };
  if (r.auth) {
    ctx.user = sessionUser(req);
    if (!ctx.user) return sendJson(res, 401, { error: 'Нужно войти.' });
  }
  if (method === 'POST' || method === 'PATCH') ctx.body = await readJson(req);
  const out = await r.fn(ctx);
  if (out !== null && out !== undefined) sendJson(res, 200, out);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) {
      if (!res.headersSent) sendJson(res, e.status, { error: e.message, ...e.extra });
    } else {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера.' });
    }
  }
});
server.listen(cfg.port, cfg.host, () => {
  console.log(`\n  Svipe запущен: http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
  console.log(cfg.smtp ? `  Почта: SMTP ${cfg.smtp.host}:${cfg.smtp.port}` : '  Почта не настроена: коды будут выводиться здесь, в консоли.');
  console.log(`  Данные: ${DB_FILE}\n`);
});
