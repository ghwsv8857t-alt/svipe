(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var root = document.documentElement;
  var body = document.body;
  var mailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  var state = { me: null, chats: [], active: null, msgs: {}, tab: 'chats', filter: '', es: null, hadReady: false };

  /* ---------- помощники ---------- */
  function el(tag, props) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') n.className = props[k];
        else if (k === 'text') n.textContent = props[k];
        else n.setAttribute(k, props[k]);
      });
    }
    var add = function (c) {
      if (c == null) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      n.append(c.nodeType ? c : document.createTextNode(c));
    };
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return n;
  }

  var onFile = location.protocol === 'file:';
  var FILE_MSG = 'Svipe нужно открывать через сервер: запустите «node server.js» в папке проекта и перейдите на http://localhost:3000';

  function api(path, opts) {
    opts = opts || {};
    if (onFile) { var e0 = new Error(FILE_MSG); e0.network = true; return Promise.reject(e0); }
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok) {
          var err = new Error((data && data.error) || 'Ошибка сервера (' + r.status + ').');
          err.status = r.status;
          err.data = data || {};
          throw err;
        }
        return data;
      });
    }, function () {
      var err = new Error('Нет связи с сервером. Проверьте интернет.');
      err.network = true;
      throw err;
    });
  }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    requestAnimationFrame(function () { t.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.hidden = true; }, 350);
    }, 3400);
  }

  function fmtTime(ts) { return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
  function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
  function fmtShort(ts) {
    var d = new Date(ts), n = new Date();
    if (sameDay(d, n)) return fmtTime(ts);
    if (sameDay(d, new Date(n.getTime() - 86400000))) return 'Вчера';
    var o = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== n.getFullYear()) o.year = '2-digit';
    return d.toLocaleDateString('ru-RU', o);
  }
  function fmtDay(ts) {
    var d = new Date(ts), n = new Date();
    if (sameDay(d, n)) return 'Сегодня';
    if (sameDay(d, new Date(n.getTime() - 86400000))) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() !== n.getFullYear() ? 'numeric' : undefined });
  }
  function hue(id) { var h = 0, s = String(id); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function isMobile() { return window.matchMedia('(max-width: 859px)').matches; }

  function avatar(chat, size) {
    var a = el('div', { class: 'avatar' + (size ? ' ' + size : ''), 'aria-hidden': 'true' });
    if (chat.kind === 'saved') {
      a.classList.add('saved');
      a.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h12v17l-6-4-6 4Z"/></svg>';
    } else if (chat.system) {
      a.classList.add('sys');
      a.append(el('img', { src: 'logo.svg', alt: '' }));
    } else {
      var h = hue(chat.peerId || chat.id);
      a.style.background = 'linear-gradient(145deg, hsl(' + h + ' 78% 58%), hsl(' + ((h + 45) % 360) + ' 70% 34%))';
      a.textContent = (Array.from(chat.title.trim())[0] || '?').toUpperCase();
    }
    return a;
  }

  /* ---------- свет за курсором на стекле ---------- */
  var raf = 0, px = 0, py = 0;
  function light() {
    raf = 0;
    $$('.glass').forEach(function (g) {
      var r = g.getBoundingClientRect();
      if (!r.width) return;
      var x = px - r.left, y = py - r.top;
      g.style.setProperty('--mx', x + 'px');
      g.style.setProperty('--my', y + 'px');
      g.style.setProperty('--lit', (x > -120 && x < r.width + 120 && y > -120 && y < r.height + 120) ? '1' : '.4');
    });
  }
  function track(e) { px = e.clientX; py = e.clientY; if (!raf) raf = requestAnimationFrame(light); }
  addEventListener('pointermove', track, { passive: true });
  addEventListener('pointerdown', track, { passive: true });

  /* ---------- шторки ---------- */
  var sheets = [];
  function makeSheet(wrap) {
    var s = {
      wrap: wrap, isOpen: false, last: null,
      open: function (focusSel) {
        s.last = document.activeElement;
        wrap.hidden = false;
        body.classList.add('lock');
        s.isOpen = true;
        requestAnimationFrame(function () { requestAnimationFrame(function () { wrap.classList.add('open'); }); });
        setTimeout(function () { var f = focusSel && $(focusSel, wrap); if (f) f.focus(); }, 380);
      },
      close: function (done) {
        if (!s.isOpen) return;
        s.isOpen = false;
        wrap.classList.remove('open');
        setTimeout(function () {
          wrap.hidden = true;
          if (!sheets.some(function (x) { return x.isOpen; })) body.classList.remove('lock');
          if (s.last && s.last.focus && document.contains(s.last) && s.last.offsetParent !== null) s.last.focus();
          if (done) done();
        }, 420);
      }
    };
    $('.scrim', wrap).addEventListener('click', function () { s.close(); });
    $('.x', wrap).addEventListener('click', function () { s.close(); });
    sheets.push(s);
    return s;
  }
  addEventListener('keydown', function (e) {
    var open = sheets.filter(function (s) { return s.isOpen; }).pop();
    if (!open) return;
    if (e.key === 'Escape') { open.close(); return; }
    if (e.key !== 'Tab') return;
    var items = $$('button, input', open.wrap).filter(function (n) { return n.offsetParent !== null && !n.disabled; });
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ---------- стартовый экран ---------- */
  $$('time[data-now]').forEach(function (t) {
    try { t.textContent = fmtTime(Date.now() + Number(t.dataset.now) * 60000); } catch (e) { /* оставляем как есть */ }
  });

  var authSheet = makeSheet($('#authWrap'));
  var newSheet = makeSheet($('#newWrap'));
  var slider = $('#slider'), handle = $('#handle');
  var dragging = false, downX = 0, moved = 0, sx = 0, smax = 0;
  function metrics() { smax = Math.max(0, slider.clientWidth - handle.offsetWidth - 12); }
  function setX(v) {
    sx = Math.max(0, Math.min(smax, v));
    slider.style.setProperty('--x', sx + 'px');
    slider.style.setProperty('--p', smax ? (sx / smax).toFixed(3) : 0);
  }
  function sliderDone() { metrics(); setX(smax); setTimeout(function () { openAuth('signup'); }, 220); }
  handle.addEventListener('pointerdown', function (e) {
    metrics(); dragging = true; moved = 0; downX = e.clientX - sx;
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
    slider.classList.add('drag');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    moved = Math.max(moved, Math.abs(e.clientX - downX - sx));
    setX(e.clientX - downX);
  });
  function release(cancel) {
    if (!dragging) return;
    dragging = false;
    slider.classList.remove('drag');
    if (cancel) { setX(0); return; }
    if (moved < 6 || sx >= smax * 0.82) sliderDone(); else setX(0);
  }
  handle.addEventListener('pointerup', function () { release(false); });
  handle.addEventListener('pointercancel', function () { release(true); });
  slider.addEventListener('click', function (e) { if (e.target === slider || e.target.classList.contains('lbl')) sliderDone(); });
  slider.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); sliderDone(); }
  });
  addEventListener('resize', function () { if (!dragging && !authSheet.isOpen) { metrics(); setX(0); } });
  $('#loginBtn').addEventListener('click', function () { openAuth('login'); });

  /* ---------- вход и регистрация ---------- */
  var mode = 'signup', pendingEmail = '', busy = false, resendTimer = null;
  var stepEmail = $('#stepEmail'), stepCode = $('#stepCode');
  var nameIn = $('#name'), emailIn = $('#email'), err = $('#err');
  var codeIns = $$('#code input');

  function showStep(s) { stepEmail.hidden = s !== stepEmail; stepCode.hidden = s !== stepCode; }
  function setMode(m) {
    mode = m;
    var signup = m === 'signup';
    $('#authTitle').textContent = signup ? 'Создайте аккаунт' : 'С возвращением';
    $('#authSub').textContent = signup ? 'Укажите имя и e-mail, мы отправим на него код подтверждения.' : 'Укажите e-mail, мы отправим на него код для входа.';
    $('#nameField').hidden = !signup;
    $('#switchMode').textContent = signup ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Создать';
    err.textContent = '';
  }
  function openAuth(m) {
    setMode(m);
    showStep(stepEmail);
    authSheet.open(m === 'signup' ? '#name' : '#email');
  }
  $('#switchMode').addEventListener('click', function () {
    setMode(mode === 'signup' ? 'login' : 'signup');
    (mode === 'signup' ? nameIn : emailIn).focus();
  });
  nameIn.addEventListener('input', function () { err.textContent = ''; });
  emailIn.addEventListener('input', function () { err.textContent = ''; });

  function startResend(sec) {
    var btn = $('#resend');
    clearInterval(resendTimer);
    var left = sec;
    function tick() {
      if (left > 0) { btn.disabled = true; btn.textContent = 'Отправить код ещё раз (' + left + ' с)'; left--; }
      else { btn.disabled = false; btn.textContent = 'Отправить код ещё раз'; clearInterval(resendTimer); }
    }
    tick();
    resendTimer = setInterval(tick, 1000);
  }
  function showCode(r) {
    $('#codeFor').textContent = pendingEmail;
    $('#codeHint').textContent = r.via === 'console'
      ? 'Почта на сервере не настроена: код выведен в консоль, где запущен сервер.'
      : 'Код действует 10 минут. Если письма нет, проверьте папку «Спам».';
    $('#codeErr').textContent = '';
    codeIns.forEach(function (i) { i.value = ''; i.disabled = false; });
    showStep(stepCode);
    startResend(r.resendIn || 60);
    codeIns[0].focus();
  }
  function requestCode(email, name) {
    return api('/api/auth/request', { method: 'POST', body: { email: email, name: name, mode: mode } });
  }
  $('#authForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var email = emailIn.value.trim().toLowerCase(), name = nameIn.value.trim();
    if (mode === 'signup' && name.length < 2) { err.textContent = 'Введите имя, минимум 2 символа.'; nameIn.focus(); return; }
    if (!mailRe.test(email)) { err.textContent = 'Введите e-mail полностью, например name@mail.ru.'; emailIn.focus(); return; }
    busy = true;
    var btn = $('#sendBtn');
    btn.disabled = true; btn.textContent = 'Отправляем…';
    requestCode(email, name).then(function (r) {
      pendingEmail = email;
      showCode(r);
    }, function (ex) {
      err.textContent = ex.message;
      if (ex.data && ex.data.code === 'no_account') $('#switchMode').focus();
      if (ex.data && ex.data.code === 'exists') $('#switchMode').focus();
    }).then(function () {
      busy = false; btn.disabled = false; btn.textContent = 'Получить код';
    });
  });
  $('#resend').addEventListener('click', function () {
    if (busy) return;
    busy = true;
    $('#resend').disabled = true;
    requestCode(pendingEmail, nameIn.value.trim()).then(function (r) {
      $('#codeErr').textContent = '';
      startResend(r.resendIn || 60);
      toast('Новый код отправлен.');
    }, function (ex) {
      $('#codeErr').textContent = ex.message;
      startResend((ex.data && ex.data.retryIn) || 10);
    }).then(function () { busy = false; });
  });
  $('#back').addEventListener('click', function () { clearInterval(resendTimer); showStep(stepEmail); emailIn.focus(); });

  function submitCode() {
    var code = codeIns.map(function (i) { return i.value; }).join('');
    if (code.length !== 6 || busy) return;
    busy = true;
    codeIns.forEach(function (i) { i.disabled = true; });
    api('/api/auth/verify', { method: 'POST', body: { email: pendingEmail, code: code } }).then(function (r) {
      clearInterval(resendTimer);
      authSheet.close();
      return enterApp(r.user);
    }, function (ex) {
      $('#codeErr').textContent = ex.message;
      codeIns.forEach(function (i) { i.value = ''; i.disabled = false; });
      var box = $('#code');
      box.classList.remove('shake');
      void box.offsetWidth;
      box.classList.add('shake');
      codeIns[0].focus();
    }).then(function () { busy = false; });
  }
  codeIns.forEach(function (inp, i) {
    inp.addEventListener('input', function () {
      inp.value = inp.value.replace(/\D/g, '').slice(-1);
      $('#codeErr').textContent = '';
      if (inp.value && codeIns[i + 1]) codeIns[i + 1].focus();
      submitCode();
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !inp.value && codeIns[i - 1]) codeIns[i - 1].focus();
      if (e.key === 'ArrowLeft' && codeIns[i - 1]) codeIns[i - 1].focus();
      if (e.key === 'ArrowRight' && codeIns[i + 1]) codeIns[i + 1].focus();
    });
    inp.addEventListener('paste', function (e) {
      var text = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if (!text) return;
      e.preventDefault();
      text.split('').forEach(function (ch, k) { if (codeIns[k]) codeIns[k].value = ch; });
      codeIns[Math.min(text.length, 5)].focus();
      submitCode();
    });
    inp.addEventListener('focus', function () { inp.select(); });
  });

  /* ---------- вход в приложение ---------- */
  function showStart() {
    $('#start').hidden = false;
    metrics(); setX(0);
  }
  function applySettings(s) {
    s = s || {};
    root.dataset.accent = s.accent || 'blue';
    root.style.setProperty('--blur', (8 + (s.blur == null ? 50 : s.blur) * 0.32).toFixed(1) + 'px');
    body.classList.toggle('no-orbs', s.orbs === false);
  }

  function enterApp(user) {
    state.me = user;
    applySettings(user.settings);
    fillSettings();
    $('#start').hidden = true;
    $('#app').hidden = false;
    return loadChats().then(function () {
      connect();
      if (!isMobile() && state.chats.length) openChat(state.chats[0].id);
    });
  }

  /* ---------- список чатов ---------- */
  function loadChats() {
    return api('/api/chats').then(function (r) { state.chats = r.chats; renderChats(); });
  }
  function upsertChat(c, keepUnread) {
    var i = state.chats.findIndex(function (x) { return x.id === c.id; });
    if (i >= 0) {
      if (keepUnread === 0) c.unread = 0;
      state.chats[i] = c;
    } else state.chats.push(c);
  }
  function renderChats() {
    var list = $('#list');
    var q = state.filter.trim().toLowerCase();
    var items = state.chats.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; }).filter(function (c) {
      if (!q) return true;
      return c.title.toLowerCase().indexOf(q) >= 0 || (c.username || '').toLowerCase().indexOf(q) >= 0 || (c.last && c.last.text.toLowerCase().indexOf(q) >= 0);
    });
    list.replaceChildren();
    if (!items.length) {
      list.append(el('li', { class: 'none', text: q ? 'Ничего не найдено.' : 'Чатов пока нет. Нажмите «+», чтобы начать.' }));
    }
    items.forEach(function (c) {
      var pv = c.last ? (c.last.mine ? [el('b', { text: 'Вы: ' }), c.last.text] : [c.last.text]) : ['Нет сообщений'];
      var btn = el('button', { class: 'item' + (c.id === state.active ? ' on' : ''), type: 'button', 'data-id': c.id },
        avatar(c),
        el('span', { class: 'meta' },
          el('span', { class: 'l1' }, el('span', { class: 'nm', text: c.title }), el('span', { class: 'tm', text: c.last ? fmtShort(c.last.ts) : '' })),
          el('span', { class: 'l2' }, el('span', { class: 'pv' }, pv), c.unread ? el('span', { class: 'badge', text: c.unread > 99 ? '99+' : String(c.unread) }) : null)
        ));
      btn.addEventListener('click', function () { openChat(c.id); });
      list.append(el('li', null, btn));
    });
    var total = state.chats.reduce(function (n, c) { return n + (c.unread || 0); }, 0);
    $('#tabDot').hidden = total === 0;
    document.title = total ? '(' + total + ') Svipe' : 'Svipe';
  }
  $('#search').addEventListener('input', function (e) { state.filter = e.target.value; renderChats(); });

  /* ---------- переписка ---------- */
  var msgsBox = $('#msgs'), input = $('#msgInput');
  function chatById(id) { return state.chats.find(function (c) { return c.id === id; }); }

  function openChat(id) {
    var chat = chatById(id);
    if (!chat) return Promise.resolve();
    state.active = id;
    $('#empty').hidden = true;
    $('#chatView').hidden = false;
    $('#app').classList.add('chat-open');
    var av = avatar(chat);
    $('#chAvatar').replaceChildren(av);
    $('#chTitle').textContent = chat.title;
    $('#chSub').textContent = chat.kind === 'saved' ? 'Заметки для себя' : (chat.system ? 'Официальный аккаунт' : (chat.username ? '@' + chat.username : ''));
    $('#composer').hidden = chat.readonly;
    updateHeadButtons();
    $('#roNote').hidden = !chat.readonly;
    msgsBox.replaceChildren();
    renderChats();
    var data = state.msgs[id];
    var load = data ? Promise.resolve(data) : api('/api/chats/' + encodeURIComponent(id) + '/messages').then(function (r) {
      state.msgs[id] = { list: r.messages, hasMore: r.hasMore };
      return state.msgs[id];
    });
    return load.then(function () {
      if (state.active !== id) return;
      renderMessages(true);
      markRead(id);
      if (!isMobile() && !chat.readonly) input.focus();
    }, function (ex) { toast(ex.message); });
  }
  function closeChat() {
    state.active = null;
    $('#app').classList.remove('chat-open');
    $('#chatView').hidden = true;
    $('#empty').hidden = false;
    renderChats();
  }
  $('#backBtn').addEventListener('click', closeChat);

  function msgEl(m) {
    if (m.call) {
      var node = el('div', { class: 'msg callmsg' + (m.call.status !== 'ended' ? ' bad' : '') });
      var ico = el('span', { class: 'ic' });
      ico.innerHTML = m.call.video ? CAM_SVG : PHONE_SVG;
      node.append(ico, el('span', { text: m.text }), el('time', { text: fmtTime(m.ts) }));
      return node;
    }
    var mine = m.from === state.me.id;
    return el('div', { class: 'msg ' + (mine ? 'mine' : 'theirs'), 'data-id': m.id }, el('p', { text: m.text }), el('time', { text: fmtTime(m.ts) }));
  }
  function renderMessages(toBottom, keepOffset) {
    var d = state.msgs[state.active];
    if (!d) return;
    var prevH = msgsBox.scrollHeight;
    msgsBox.replaceChildren();
    if (d.hasMore) {
      var more = el('button', { class: 'more', type: 'button', text: 'Показать более ранние' });
      more.addEventListener('click', loadOlder);
      msgsBox.append(more);
    }
    var lastDay = null;
    d.list.forEach(function (m) {
      var day = new Date(m.ts).toDateString();
      if (day !== lastDay) { msgsBox.append(el('div', { class: 'day', text: fmtDay(m.ts) })); lastDay = day; }
      msgsBox.append(msgEl(m));
    });
    msgsBox.dataset.lastDay = lastDay || '';
    msgsBox.style.scrollBehavior = 'auto';
    if (keepOffset) msgsBox.scrollTop = msgsBox.scrollHeight - prevH;
    else if (toBottom) msgsBox.scrollTop = msgsBox.scrollHeight;
    msgsBox.style.scrollBehavior = '';
  }
  function loadOlder() {
    var id = state.active, d = state.msgs[id];
    if (!d || !d.list.length) return;
    api('/api/chats/' + encodeURIComponent(id) + '/messages?before=' + d.list[0].ts).then(function (r) {
      d.list = r.messages.concat(d.list);
      d.hasMore = r.hasMore;
      if (state.active === id) renderMessages(false, true);
    }, function (ex) { toast(ex.message); });
  }
  function appendMessage(m) {
    var nearBottom = msgsBox.scrollHeight - msgsBox.scrollTop - msgsBox.clientHeight < 120;
    var day = new Date(m.ts).toDateString();
    if (msgsBox.dataset.lastDay !== day) { msgsBox.append(el('div', { class: 'day', text: fmtDay(m.ts) })); msgsBox.dataset.lastDay = day; }
    msgsBox.append(msgEl(m));
    if (nearBottom || m.from === state.me.id) msgsBox.scrollTop = msgsBox.scrollHeight;
  }
  function markRead(id) {
    var c = chatById(id);
    if (c && c.unread > 0 && !document.hidden) {
      c.unread = 0;
      renderChats();
      api('/api/chats/' + encodeURIComponent(id) + '/read', { method: 'POST', body: {} }).catch(function () { /* не критично */ });
    }
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && state.active) markRead(state.active); });

  function addMessage(chatId, message, chatSummary) {
    var d = state.msgs[chatId];
    var isNew = !d || !d.list.some(function (x) { return x.id === message.id; });
    if (d && isNew) d.list.push(message);
    if (chatSummary) {
      var activeNow = chatId === state.active && !document.hidden;
      upsertChat(chatSummary, activeNow && message.from !== state.me.id ? 0 : undefined);
    }
    if (!isNew) { renderChats(); return; }
    var fromOther = message.from !== state.me.id;
    if (chatId === state.active) {
      appendMessage(message);
      if (fromOther) markRead(chatId);
    }
    if (fromOther && (document.hidden || chatId !== state.active)) { if (state.me.settings.sound) beep(); }
    renderChats();
    var node = $('.item[data-id="' + chatId + '"]');
    if (node) node.classList.add('fresh');
  }

  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim(), id = state.active;
    if (!text || !id) return;
    input.value = '';
    autosize();
    api('/api/chats/' + encodeURIComponent(id) + '/messages', { method: 'POST', body: { text: text } }).then(function (r) {
      addMessage(id, r.message, r.chat);
    }, function (ex) {
      if (!input.value) { input.value = text; autosize(); }
      toast(ex.message);
    });
    if (!isMobile()) input.focus();
  });

  /* ---------- новые сообщения в реальном времени ---------- */
  function connect() {
    if (state.es) state.es.close();
    var es = new EventSource('/api/events');
    state.es = es;
    es.addEventListener('ready', function () {
      if (state.hadReady) resync();
      state.hadReady = true;
    });
    es.addEventListener('msg', function (ev) {
      var d = JSON.parse(ev.data);
      addMessage(d.chatId, d.message, d.chat);
    });
    es.addEventListener('read', function (ev) {
      var d = JSON.parse(ev.data), c = chatById(d.chatId);
      if (c && c.unread) { c.unread = 0; renderChats(); }
    });
    es.addEventListener('call', function (ev) { onCallEvent(JSON.parse(ev.data)); });
    es.onerror = function () {
      if (es.readyState === EventSource.CLOSED) {
        api('/api/me').catch(function (ex) { if (ex.status === 401) location.reload(); });
      }
    };
  }
  function resync() {
    var id = state.active;
    state.msgs = {};
    loadChats().then(function () { if (id && chatById(id)) openChat(id); });
  }

  var actx = null;
  function unlockAudio() {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { /* без звука */ }
  }
  addEventListener('pointerdown', unlockAudio, { once: true });
  addEventListener('keydown', unlockAudio, { once: true });
  function beep() {
    try {
      unlockAudio();
      if (!actx) return;
      var t = actx.currentTime;
      [660, 880].forEach(function (f, i) {
        var o = actx.createOscillator(), g = actx.createGain(), s = t + i * 0.09;
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.12, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.18);
        o.connect(g); g.connect(actx.destination);
        o.start(s); o.stop(s + 0.2);
      });
    } catch (e) { /* без звука */ }
  }

  /* ---------- новый чат ---------- */
  $('#newChatBtn').addEventListener('click', function () {
    $('#ncQuery').value = '';
    $('#ncErr').textContent = '';
    newSheet.open('#ncQuery');
  });
  $('#ncQuery').addEventListener('input', function () { $('#ncErr').textContent = ''; });
  $('#ncForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('#ncQuery').value.trim();
    if (!q) { $('#ncErr').textContent = 'Введите e-mail или @username.'; return; }
    api('/api/chats', { method: 'POST', body: { query: q } }).then(function (r) {
      upsertChat(r.chat);
      setTab('chats');
      newSheet.close(function () { openChat(r.chat.id); });
    }, function (ex) { $('#ncErr').textContent = ex.message; });
  });

  /* ---------- вкладки ---------- */
  function setTab(t) {
    state.tab = t;
    $('#tabbar').dataset.tab = t;
    $$('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === t); });
    $('#paneChats').hidden = t !== 'chats';
    $('#paneSettings').hidden = t !== 'settings';
    $('#sideTitle').textContent = t === 'chats' ? 'Чаты' : 'Настройки';
    $('#newChatBtn').hidden = t !== 'chats';
  }
  $$('.tab').forEach(function (b) { b.addEventListener('click', function () { setTab(b.dataset.tab); }); });

  /* ---------- настройки ---------- */
  function setSwitch(btn, on) { btn.setAttribute('aria-checked', on ? 'true' : 'false'); }
  function fillSettings() {
    var me = state.me, s = me.settings;
    $('#setAvatar').replaceChildren(avatar({ kind: 'direct', title: me.name, peerId: me.id, id: me.id }, 'big'));
    $('#setName').textContent = me.name;
    $('#setEmail').textContent = me.email;
    $('#pfName').value = me.name;
    $('#pfUser').value = me.username;
    $('#pfBio').value = me.bio || '';
    $$('.sw').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.accent === s.accent ? 'true' : 'false'); });
    $('#blur').value = s.blur;
    $('#blurOut').textContent = s.blur + '%';
    setSwitch($('#swOrbs'), s.orbs !== false);
    setSwitch($('#swSound'), s.sound !== false);
  }
  var saveT;
  function saveSettings() {
    clearTimeout(saveT);
    saveT = setTimeout(function () {
      api('/api/me', { method: 'PATCH', body: { settings: state.me.settings } }).catch(function (ex) { toast(ex.message); });
    }, 500);
  }
  function changeSetting(key, value) {
    state.me.settings[key] = value;
    applySettings(state.me.settings);
    saveSettings();
  }
  $$('.sw').forEach(function (b) {
    b.addEventListener('click', function () {
      changeSetting('accent', b.dataset.accent);
      $$('.sw').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    });
  });
  $('#blur').addEventListener('input', function (e) {
    var v = Number(e.target.value);
    $('#blurOut').textContent = v + '%';
    changeSetting('blur', v);
  });
  $('#swOrbs').addEventListener('click', function (e) {
    var on = e.currentTarget.getAttribute('aria-checked') !== 'true';
    setSwitch(e.currentTarget, on);
    changeSetting('orbs', on);
  });
  $('#swSound').addEventListener('click', function (e) {
    var on = e.currentTarget.getAttribute('aria-checked') !== 'true';
    setSwitch(e.currentTarget, on);
    changeSetting('sound', on);
    if (on) beep();
  });
  $('#profileForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = $('#pfMsg');
    msg.className = 'err';
    msg.textContent = '';
    api('/api/me', { method: 'PATCH', body: { name: $('#pfName').value, username: $('#pfUser').value, bio: $('#pfBio').value } }).then(function (r) {
      state.me = r.user;
      fillSettings();
      msg.className = 'err ok';
      msg.textContent = 'Сохранено.';
      setTimeout(function () { if (msg.textContent === 'Сохранено.') msg.textContent = ''; }, 2500);
    }, function (ex) { msg.textContent = ex.message; });
  });
  ['pfName', 'pfUser', 'pfBio'].forEach(function (id) { $('#' + id).addEventListener('input', function () { $('#pfMsg').textContent = ''; }); });
  function leave(path) {
    api(path, { method: 'POST', body: {} }).catch(function () { /* всё равно выходим */ }).then(function () { location.reload(); });
  }
  $('#logout').addEventListener('click', function () { leave('/api/auth/logout'); });
  $('#logoutAll').addEventListener('click', function () { leave('/api/auth/logout-all'); });

  /* ---------- звонки ---------- */
  var PHONE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/></svg>';
  var CAM_SVG = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6.5" width="13" height="11" rx="3"/><path d="m15.5 11 6-3.5v9l-6-3.5"/></svg>';
  var call = null, iceCfg = null, sigQ = Promise.resolve(), ringT = null, tickT = null;
  var callBox = $('#call'), remoteV = $('#remoteV'), localV = $('#localV');

  function callsOk() { return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection); }
  function canCall(c) { return !!(c && c.kind === 'direct' && c.peerId && !c.system); }
  function updateHeadButtons() {
    var c = chatById(state.active);
    var box = $('#headCall');
    box.hidden = !canCall(c);
    $('#callVoice').disabled = $('#callVideo').disabled = !!call;
  }
  function sigTo(id, type, data) {
    sigQ = sigQ.then(function () {
      return api('/api/calls/' + encodeURIComponent(id) + '/signal', { method: 'POST', body: { type: type, data: data } });
    }).catch(function () { /* звонок мог уже закончиться */ });
    return sigQ;
  }
  function loadIce() {
    if (iceCfg) return Promise.resolve(iceCfg);
    return api('/api/calls/config').then(function (r) { iceCfg = r; return r; }, function () { iceCfg = { iceServers: [] }; return iceCfg; });
  }
  function getMedia(video) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
    }).catch(function (e) {
      var m = 'Не удалось включить ' + (video ? 'камеру и микрофон.' : 'микрофон.');
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) m = 'Нет доступа к ' + (video ? 'камере или микрофону' : 'микрофону') + '. Разрешите его в настройках браузера.';
      else if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) m = video ? 'Камера или микрофон не найдены.' : 'Микрофон не найден.';
      else if (e && e.name === 'NotReadableError') m = 'Устройство занято другой программой.';
      throw new Error(m);
    });
  }

  /* мелодии */
  function tone(freqs, start, dur, vol) {
    try {
      unlockAudio();
      if (!actx) return;
      var t = actx.currentTime + start;
      freqs.forEach(function (f) {
        var o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
        g.gain.setValueAtTime(vol, t + Math.max(0.04, dur - 0.08));
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(actx.destination);
        o.start(t); o.stop(t + dur + 0.03);
      });
    } catch (e) { /* без звука */ }
  }
  function ringOnce(kind) {
    if (kind === 'in') { tone([523.25, 659.25], 0, 0.32, 0.07); tone([523.25, 659.25], 0.45, 0.32, 0.07); tone([783.99], 0.9, 0.45, 0.05); }
    else tone([440], 0, 1.0, 0.045);
  }
  function startRing(kind) { stopRing(); ringOnce(kind); ringT = setInterval(function () { ringOnce(kind); }, kind === 'in' ? 3000 : 3500); }
  function stopRing() { if (ringT) { clearInterval(ringT); ringT = null; } }
  function endTone() { tone([392], 0, 0.18, 0.06); tone([294], 0.2, 0.3, 0.06); }

  /* окно звонка */
  function newCall(o) {
    return Object.assign({ id: null, state: 'starting', local: null, remote: null, pc: null, pending: [], early: [], muted: false, camOff: false, t0: 0, accepted: false, weak: false, dead: false, closing: false, endText: '' }, o);
  }
  function timerText(c) {
    var s = Math.max(0, Math.floor((Date.now() - c.t0) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function paint() {
    var c = call;
    if (!c) return;
    var inc = c.dir === 'in' && c.state === 'ringing';
    var map = {
      starting: 'Подключаем…', calling: 'Вызываем…', connecting: 'Соединяем…', ended: c.endText || 'Звонок завершён',
      ringing: c.video ? 'Входящий видеозвонок' : 'Входящий звонок', active: c.weak ? 'Связь нестабильна…' : (c.t0 ? timerText(c) : 'Соединяем…')
    };
    $('#callStatus').textContent = map[c.state] || '';
    callBox.classList.toggle('video', !!c.video);
    callBox.classList.toggle('pulse', c.state === 'calling' || c.state === 'ringing' || c.state === 'starting');
    callBox.classList.toggle('camoff', !!c.camOff);
    callBox.classList.toggle('mine', !!c.local);
    $('#cAccept').hidden = $('#cDecline').hidden = !inc;
    $('#cEnd').hidden = inc || c.state === 'ended';
    $('#cMic').hidden = inc || c.state === 'ended' || !c.local;
    $('#cCam').hidden = inc || c.state === 'ended' || !c.video || !c.local;
  }
  function showCall() {
    var c = call;
    $('#callName').textContent = c.name;
    $('#callAv').replaceChildren(avatar({ kind: 'direct', title: c.name, peerId: c.peerId, id: c.peerId }, 'big'));
    $('#cMic').setAttribute('aria-pressed', 'false');
    $('#cCam').setAttribute('aria-pressed', 'false');
    callBox.classList.remove('live');
    callBox.hidden = false;
    paint();
    updateHeadButtons();
    setTimeout(function () { var b = c.dir === 'in' ? $('#cAccept') : $('#cEnd'); if (call === c && !b.hidden) b.focus(); }, 60);
  }
  function startTick() { clearInterval(tickT); tickT = setInterval(paint, 500); }
  function attachLocal() {
    if (!call || !call.local) return;
    localV.srcObject = call.local;
    var p = localV.play(); if (p && p.catch) p.catch(function () {});
    paint();
  }
  function closeCall() {
    var c = call;
    if (!c) return;
    call = null;
    stopRing();
    clearInterval(tickT);
    clearTimeout(c.weakT);
    try { if (c.pc) c.pc.close(); } catch (e) { /* уже закрыто */ }
    if (c.local) c.local.getTracks().forEach(function (t) { t.stop(); });
    remoteV.srcObject = null; localV.srcObject = null;
    callBox.hidden = true;
    callBox.classList.remove('live', 'video', 'pulse', 'camoff', 'mine');
    renderChats();
    updateHeadButtons();
  }
  function endLocal(text, silent) {
    var c = call;
    if (!c || c.state === 'ended') return;
    c.state = 'ended';
    c.endText = text;
    stopRing();
    clearInterval(tickT);
    if (!silent) endTone();
    paint();
    setTimeout(function () { if (call === c) closeCall(); }, 1200);
  }
  function failCall(text) {
    var c = call;
    if (!c) return;
    if (c.id) sigTo(c.id, 'hangup');
    endLocal(text);
  }
  function hangup() {
    var c = call;
    if (!c) return;
    c.closing = true;
    if (c.id) sigTo(c.id, c.dir === 'in' && c.state === 'ringing' ? 'decline' : 'hangup');
    else c.dead = true;
    endTone();
    closeCall();
  }

  /* соединение */
  function makePc() {
    var c = call;
    var pc = new RTCPeerConnection({ iceServers: (iceCfg && iceCfg.iceServers) || [] });
    c.pc = pc;
    c.local.getTracks().forEach(function (t) { pc.addTrack(t, c.local); });
    pc.onicecandidate = function (e) { if (e.candidate) sigTo(c.id, 'candidate', e.candidate.toJSON()); };
    pc.ontrack = function (e) {
      var st = e.streams && e.streams[0];
      if (!st) { c.remote = c.remote || new MediaStream(); c.remote.addTrack(e.track); st = c.remote; }
      c.remote = st;
      remoteV.srcObject = st;
      var p = remoteV.play(); if (p && p.catch) p.catch(function () {});
      if (e.track.kind === 'video' && call === c) callBox.classList.add('live');
    };
    pc.onconnectionstatechange = function () {
      if (call !== c) return;
      var s = pc.connectionState;
      if (s === 'connected') {
        clearTimeout(c.weakT); c.weak = false;
        if (c.state !== 'active') { c.state = 'active'; c.t0 = Date.now(); startTick(); }
        paint();
      } else if (s === 'disconnected') {
        c.weak = true; paint();
        clearTimeout(c.weakT);
        c.weakT = setTimeout(function () { if (call === c && pc.connectionState !== 'connected') failCall('Связь потеряна'); }, 8000);
      } else if (s === 'failed') failCall('Не удалось соединиться');
    };
    return pc;
  }
  function flushCands(c) {
    c.pending.splice(0).forEach(function (d) { c.pc.addIceCandidate(d).catch(function () { /* устаревший кандидат */ }); });
  }

  function startCall(video) {
    var chat = chatById(state.active);
    if (!canCall(chat)) return;
    if (call) { toast('Звонок уже идёт.'); return; }
    if (!callsOk()) { toast('Звонки работают только по HTTPS или на localhost, в современном браузере.'); return; }
    unlockAudio();
    var c = call = newCall({ dir: 'out', chatId: chat.id, peerId: chat.peerId, name: chat.title, video: !!video, state: 'starting' });
    showCall();
    Promise.all([loadIce(), getMedia(video)]).then(function (res) {
      if (call !== c) { res[1].getTracks().forEach(function (t) { t.stop(); }); return; }
      c.local = res[1];
      attachLocal();
      return api('/api/calls/invite', { method: 'POST', body: { chatId: chat.id, video: !!video } }).then(function (r) {
        c.id = r.callId;
        if (call !== c || c.dead) { sigTo(c.id, 'cancel'); return; }
        c.state = 'calling';
        startRing('out');
        paint();
        c.early.splice(0).forEach(onCallEvent);
      });
    }).catch(function (ex) {
      if (call === c) { closeCall(); toast(ex.message); }
    });
  }
  function acceptCall() {
    var c = call;
    if (!c || c.dir !== 'in' || c.state !== 'ringing') return;
    if (!callsOk()) { hangup(); toast('Звонки работают только по HTTPS или на localhost, в современном браузере.'); return; }
    stopRing();
    c.accepted = true;
    c.state = 'connecting';
    document.title = 'Svipe';
    paint();
    Promise.all([loadIce(), getMedia(c.video)]).then(function (res) {
      if (call !== c) { res[1].getTracks().forEach(function (t) { t.stop(); }); return; }
      c.local = res[1];
      attachLocal();
      return sigTo(c.id, 'accept');
    }).catch(function (ex) {
      if (call === c) { sigTo(c.id, 'decline'); closeCall(); toast(ex.message); }
    });
  }

  function onInvite(d) {
    if (call) return;
    call = newCall({ id: d.callId, dir: 'in', chatId: d.chatId, peerId: d.from.id, name: d.from.name, video: !!d.video, state: 'ringing' });
    document.title = 'Звонит ' + d.from.name;
    showCall();
    startRing('in');
    loadIce();
  }
  function onCallEvent(d) {
    if (d.type === 'invite') { onInvite(d); return; }
    var c = call;
    if (!c) return;
    if (c.dir === 'out' && !c.id) { c.early.push(d); return; }
    if (c.id !== d.callId) return;
    if (d.type === 'taken') { if (c.dir === 'in' && !c.accepted) closeCall(); return; }
    if (d.type === 'end') {
      if (c.closing) return;
      var out = c.dir === 'out';
      var text = d.status === 'declined' ? (out ? 'Звонок отклонён' : 'Звонок завершён')
        : d.status === 'missed' ? (out ? 'Нет ответа' : 'Звонок отменён') : 'Звонок завершён';
      endLocal(text);
      return;
    }
    if (c.state === 'ended') return;
    if (d.type === 'accept' && c.dir === 'out') {
      stopRing();
      c.state = 'connecting';
      paint();
      var pc = makePc();
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
        .then(function () { return sigTo(c.id, 'offer', pc.localDescription.toJSON()); })
        .catch(function () { failCall('Ошибка соединения'); });
    } else if (d.type === 'offer' && c.dir === 'in') {
      var pc2 = makePc();
      pc2.setRemoteDescription(d.data).then(function () { flushCands(c); return pc2.createAnswer(); })
        .then(function (a) { return pc2.setLocalDescription(a); })
        .then(function () { return sigTo(c.id, 'answer', pc2.localDescription.toJSON()); })
        .catch(function () { failCall('Ошибка соединения'); });
    } else if (d.type === 'answer' && c.dir === 'out' && c.pc) {
      c.pc.setRemoteDescription(d.data).then(function () { flushCands(c); }).catch(function () { failCall('Ошибка соединения'); });
    } else if (d.type === 'candidate') {
      if (c.pc && c.pc.remoteDescription) c.pc.addIceCandidate(d.data).catch(function () { /* устаревший кандидат */ });
      else c.pending.push(d.data);
    }
  }

  $('#callVoice').addEventListener('click', function () { startCall(false); });
  $('#callVideo').addEventListener('click', function () { startCall(true); });
  $('#cAccept').addEventListener('click', acceptCall);
  $('#cDecline').addEventListener('click', hangup);
  $('#cEnd').addEventListener('click', hangup);
  $('#cMic').addEventListener('click', function () {
    if (!call || !call.local) return;
    call.muted = !call.muted;
    call.local.getAudioTracks().forEach(function (t) { t.enabled = !call.muted; });
    $('#cMic').setAttribute('aria-pressed', call.muted ? 'true' : 'false');
  });
  $('#cCam').addEventListener('click', function () {
    if (!call || !call.local) return;
    call.camOff = !call.camOff;
    call.local.getVideoTracks().forEach(function (t) { t.enabled = !call.camOff; });
    $('#cCam').setAttribute('aria-pressed', call.camOff ? 'true' : 'false');
    paint();
  });
  addEventListener('pagehide', function () {
    if (call && call.id && call.state !== 'ended') {
      try { navigator.sendBeacon('/api/calls/' + encodeURIComponent(call.id) + '/signal', new Blob([JSON.stringify({ type: call.dir === 'in' && call.state === 'ringing' ? 'decline' : 'hangup' })], { type: 'application/json' })); } catch (e) { /* не получилось */ }
    }
  });

  /* ---------- запуск ---------- */
  api('/api/me').then(function (r) { return enterApp(r.user); }, function () { showStart(); if (onFile) toast(FILE_MSG); });
})();
