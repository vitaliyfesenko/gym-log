(function () {
  var C = GymCore;
  var REQUEST_TIMEOUT_MS = 15000;
  var K_QUEUE = 'gymlog.queue', K_STATE = 'gymlog.state', K_WORKOUT = 'gymlog.workout';
  var ACCESS_ERRORS = ['forbidden', 'expired', 'bad_signature', 'not_configured'];

  var params = new URLSearchParams(location.search);
  var mock = params.get('mock'); // '1', 'offline' or null
  var tg = (window.Telegram && window.Telegram.WebApp) || null;
  var initData = (tg && tg.initData) || '';
  var apiUrl = window.GYMLOG_API_URL || '';

  var root = document.getElementById('app');
  var queue = lsGet(K_QUEUE, []);
  var state = null;
  var stateDate = null;   // date for which state.today is valid
  var sentLog = [];       // entries sent successfully during this session
  var rejected = [];      // exercises the server rejected (invalid_entry), not yet reported
  var notice = null;      // {text, retry, blocking}
  var selected = null;    // selected workout name
  var openEx = null;      // exercise with open form
  var draft = null;       // {w, r, s} text values of the open form
  var flushing = false, again = false, syncing = false;
  var lastErrRes = null;  // last non-ok server response (for userId of 'forbidden')

  if (!Array.isArray(queue)) queue = [];
  (function () {
    var raw = lsGet(K_STATE, null);
    if (raw && raw.state && Array.isArray(raw.state.program)) { state = raw.state; stateDate = raw.date || null; }
    else if (raw && Array.isArray(raw.program)) { state = raw; stateDate = null; }
  })();
  function saveState() { lsSet(K_STATE, { date: stateDate, state: state }); }
  // yesterday's "today" must never show as today's records
  function ensureFresh() {
    if (state && stateDate !== today()) {
      state.today = {};
      stateDate = today();
      saveState();
    }
  }

  // ---------- storage (may be unavailable) ----------
  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* works for this session only */ }
  }

  function today() { return C.localDate(new Date()); }

  // ---------- mock ----------
  function mockState() {
    var d = new Date();
    d.setDate(d.getDate() - 7);
    return {
      program: [
        { workout: 'Тренування А', exercises: ['Жим лежачи', 'Присідання', 'Планка'] },
        { workout: 'Тренування Б', exercises: ['Станова тяга', 'Підтягування'] }
      ],
      today: { 'Жим лежачи': { workout: 'Тренування А', weight: 80, reps: 8, sets: 3 } },
      last: { 'Присідання': { date: C.localDate(d), weight: 90, reps: 6, sets: 3 } }
    };
  }

  // ---------- network ----------
  async function request(payload) {
    if (mock) {
      if (payload.action === 'state') return { ok: true, who: 'Демо', state: mockState() };
      if (mock === 'offline') throw new Error('offline');
      return { ok: true };
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    try {
      var r = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        signal: ctrl.signal
      });
      if (!r.ok) throw new Error('http ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function send(entry) {
    return request({ action: 'save', initData: initData, today: today(), entry: entry });
  }

  function errorNotice(code, res) {
    if (code === 'forbidden') {
      return { text: 'У вас немає доступу. Ваш Telegram ID: ' + (res && res.userId) + '. Передайте його власнику щоденника.', blocking: true };
    }
    if (code === 'expired' || code === 'bad_signature') {
      return { text: 'Сеанс застарів. Закрийте й відкрийте додаток знову.', blocking: true };
    }
    if (code === 'not_configured') {
      return { text: 'Скрипт не налаштовано: додайте BOT_TOKEN у властивості скрипта.', blocking: true };
    }
    return { text: 'Помилка сервера (' + code + '). Спробуйте ще раз.', retry: true };
  }

  // ---------- queue ----------
  function saveQueue() { lsSet(K_QUEUE, queue); }

  async function flush() {
    if (flushing) { again = true; return undefined; }
    flushing = true;
    var failed = null;
    try {
      do {
        again = false;
        var snapshot = queue.slice();
        var res = await C.flushQueue(snapshot, function (entry) {
          return send(entry).then(function (r) {
            if (!(r && r.ok)) lastErrRes = r;
            if (r && r.error === 'invalid_entry' && rejected.indexOf(entry.exercise) === -1) rejected.push(entry.exercise);
            if (r && r.ok) {
              sentLog.push(entry);
              applySent(entry);
            }
            return r;
          });
        });
        queue = queue.filter(function (e) {
          return snapshot.indexOf(e) === -1 || res.queue.indexOf(e) !== -1;
        });
        saveQueue();
        if (state) saveState();
        failed = res.failed;
        if (failed) again = false;
      } while (again);
    } finally {
      flushing = false;
    }
    return failed;
  }

  // fold a sent entry into state.today (only if it is for today)
  function applySent(entry) {
    ensureFresh();
    if (state && entry.date === today()) {
      state.today = state.today || {};
      state.today[entry.exercise] = { workout: entry.workout, weight: entry.weight, reps: entry.reps, sets: entry.sets };
    }
  }

  // notice for the error outcome of a flush (rejections are kept separately in `rejected`)
  function flushNotice(failed) {
    return failed && failed !== 'network' ? errorNotice(failed, lastErrRes) : null;
  }

  // ---------- sync: flush -> state ----------
  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      var failed = await flush();
      if (failed !== undefined) notice = flushNotice(failed); // undefined: joined a running flush, its owner reports
      render();
      if (failed && ACCESS_ERRORS.indexOf(failed) !== -1) return;

      var res;
      var reqToday = today(), mark = sentLog.length;
      try {
        res = await request({ action: 'state', initData: initData, today: reqToday });
      } catch (e) {
        if (!state) notice = { text: 'Немає зв\'язку. Спробуйте ще раз.', retry: true, fromState: true };
        render();
        return;
      }
      if (res && res.ok && res.state && Array.isArray(res.state.program)) {
        state = res.state;
        stateDate = reqToday;
        // re-apply entries sent while this request was in flight
        sentLog.slice(mark).forEach(applySent);
        saveState();
        if (notice && notice.fromState) notice = null; // only a stale state-fetch error is cleared
      } else {
        notice = errorNotice((res && res.error) || 'server_error', res);
        notice.fromState = true;
      }
      render();
    } finally {
      syncing = false;
    }
  }

  // ---------- rendering ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // rejected entries stay on screen until tapped or re-saved; independent of `notice`
  function renderRejected() {
    rejected.forEach(function (ex) {
      var b = el('div', 'banner', 'Запис «' + ex + '» відхилено сервером. Введіть його ще раз.');
      b.setAttribute('role', 'button');
      b.addEventListener('click', function () {
        rejected = rejected.filter(function (x) { return x !== ex; });
        renderNow();
      });
      root.appendChild(b);
    });
  }

  function messageBlock(text, retry) {
    var box = el('div', 'message');
    box.appendChild(el('p', null, text));
    if (retry) {
      var b = el('button', 'btn', 'Повторити');
      b.type = 'button';
      b.addEventListener('click', sync);
      box.appendChild(b);
    }
    return box;
  }

  function currentWorkout() {
    var names = state.program.map(function (p) { return p.workout; });
    if (selected && names.indexOf(selected) !== -1) return selected;
    var saved = lsGet(K_WORKOUT, null);
    if (saved && saved.date === today() && names.indexOf(saved.workout) !== -1) selected = saved.workout;
    else selected = names[0];
    return selected;
  }

  function lastText(ex) {
    var l = state.last && state.last[ex];
    if (!l) return 'минулого разу: —';
    return 'минулого разу: ' + C.formatResult(l) + ' (' + C.formatShortDate(l.date) + ')';
  }

  function initialDraft(ex, view) {
    var src = view[ex] || (state.last && state.last[ex]);
    if (!src) return { w: '', r: '', s: '' };
    return { w: String(src.weight).replace('.', ','), r: String(src.reps), s: String(src.sets) };
  }

  // A background re-render would destroy the focused input and close the phone keyboard.
  // While an input of the open form has focus, only mark the render as pending.
  var renderPending = false, pendingTimer = null;
  function formInputFocused() {
    var a = document.activeElement;
    return !!(openEx && a && a.tagName === 'INPUT' && root.contains(a));
  }
  function render() {
    if (formInputFocused()) { renderPending = true; return; }
    renderNow();
  }
  root.addEventListener('focusout', function (e) {
    if (!renderPending) return;
    var next = e.relatedTarget;
    if (next && next.tagName === 'INPUT' && root.contains(next)) return;
    // short delay: a tap on «Зберегти» must reach its button before the DOM is rebuilt
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () {
      if (renderPending && !formInputFocused()) renderNow();
    }, 250);
  });

  function renderNow() {
    renderPending = false;
    clearTimeout(pendingTimer);
    root.textContent = '';
    ensureFresh();
    renderRejected();

    if (notice && (!state || (notice.blocking && !queue.length))) {
      root.appendChild(messageBlock(notice.text, notice.retry));
      renderBar();
      return;
    }
    if (!state) { // first open, nothing cached yet
      root.appendChild(messageBlock('Завантаження…'));
      renderBar();
      return;
    }
    if (state.program.length === 0) {
      root.appendChild(messageBlock('Програма порожня. Додайте тренування і вправи на аркуш «Програма» в таблиці.'));
      renderBar();
      return;
    }
    if (notice) {
      var banner = el('div', 'banner');
      banner.appendChild(el('p', null, notice.text));
      if (notice.retry) {
        var rb = el('button', 'btn', 'Повторити');
        rb.type = 'button';
        rb.addEventListener('click', sync);
        banner.appendChild(rb);
      }
      root.appendChild(banner);
    }

    var wk = currentWorkout();
    var tabs = el('div', 'tabs');
    state.program.forEach(function (p) {
      var b = el('button', 'tab' + (p.workout === wk ? ' active' : ''), p.workout);
      b.type = 'button';
      b.addEventListener('click', function () {
        selected = p.workout;
        lsSet(K_WORKOUT, { date: today(), workout: p.workout });
        openEx = null; draft = null;
        renderNow();
      });
      tabs.appendChild(b);
    });
    root.appendChild(tabs);

    var view = C.viewToday(state, queue, today());
    var program = state.program.filter(function (p) { return p.workout === wk; })[0];
    var list = el('div', 'list');
    (program.exercises || []).forEach(function (ex) {
      list.appendChild(renderItem(ex, view, wk));
    });
    root.appendChild(list);
    renderBar();
  }

  function renderItem(ex, view, wk) {
    var v = view[ex];
    var item = el('div', 'item');
    var row = el('div', 'row');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    var mark = el('div', 'mark' + (v && !v.pending ? ' done' : ''), v ? (v.pending ? '⏳' : '✓') : (openEx === ex ? '▾' : '▸'));
    var main = el('div', 'main');
    main.appendChild(el('div', 'name', ex));
    main.appendChild(el('div', 'sub', v ? (v.pending ? 'очікує відправки' : lastText(ex)) : lastText(ex)));
    row.appendChild(mark);
    row.appendChild(main);
    if (v) row.appendChild(el('div', 'res', C.formatResult(v)));
    function toggle() {
      if (openEx === ex) { openEx = null; draft = null; }
      else { openEx = ex; draft = initialDraft(ex, view); }
      renderNow();
    }
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    item.appendChild(row);
    if (openEx === ex) item.appendChild(renderForm(ex, wk));
    return item;
  }

  function field(label, mode, key, value) {
    var wrap = el('div', 'field');
    var id = 'f-' + key;
    var lab = el('label', null, label);
    lab.setAttribute('for', id);
    var inp = document.createElement('input');
    inp.id = id;
    inp.type = 'text';
    inp.setAttribute('inputmode', mode);
    inp.setAttribute('autocomplete', 'off');
    inp.value = value;
    inp.addEventListener('input', function () {
      draft[key] = inp.value;
      inp.classList.remove('invalid');
    });
    wrap.appendChild(lab);
    wrap.appendChild(inp);
    return { wrap: wrap, input: inp };
  }

  function renderForm(ex, wk) {
    var form = el('div', 'form');
    var fields = el('div', 'fields');
    var fw = field('кг', 'decimal', 'w', draft.w);
    var fr = field('повт.', 'numeric', 'r', draft.r);
    var fs = field('підх.', 'numeric', 's', draft.s);
    [fw, fr, fs].forEach(function (f) { fields.appendChild(f.wrap); });
    form.appendChild(fields);
    var btn = el('button', 'save', 'Зберегти');
    btn.type = 'button';
    form.appendChild(btn);

    function submit() {
      var w = C.parseWeight(fw.input.value);
      var r = C.parseCount(fr.input.value, 1000);
      var s = C.parseCount(fs.input.value, 100);
      fw.input.classList.toggle('invalid', w === null);
      fr.input.classList.toggle('invalid', r === null);
      fs.input.classList.toggle('invalid', s === null);
      if (w === null || r === null || s === null) {
        clearTimeout(pendingTimer); // keep the highlighted fields; a pending re-render waits for the next action
        haptic('error');
        return;
      }
      rejected = rejected.filter(function (x) { return x !== ex; });
      queue = C.queueAdd(queue, { date: today(), workout: wk, exercise: ex, weight: w, reps: r, sets: s });
      saveQueue();
      openEx = null; draft = null;
      renderNow();
      haptic('success');
      flush().then(function (failed) {
        if (failed === undefined) return; // joined a running flush; its owner renders
        notice = flushNotice(failed);
        render();
      });
    }
    btn.addEventListener('click', submit);
    [fw, fr, fs].forEach(function (f) {
      f.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });
    return form;
  }

  function renderBar() {
    if (!queue.length) return;
    var bar = el('div', 'bar');
    bar.appendChild(el('span', null, 'Не відправлено: ' + queue.length));
    var b = el('button', 'btn', 'Повторити');
    b.type = 'button';
    b.addEventListener('click', sync);
    bar.appendChild(b);
    root.appendChild(bar);
  }

  function haptic(kind) {
    try {
      var h = tg && tg.HapticFeedback;
      if (h) h.notificationOccurred(kind);
    } catch (e) { /* optional */ }
  }

  // ---------- start ----------
  try { if (tg) { tg.ready(); tg.expand(); } } catch (e) { /* not in Telegram */ }

  if (!mock && !initData) {
    root.appendChild(messageBlock(window.Telegram
      ? 'Відкрийте додаток через бота в Telegram.'
      : 'Не вдалося завантажити додаток. Перевірте зв\'язок і відкрийте його знову.'));
  } else if (!mock && !apiUrl) {
    root.appendChild(messageBlock('Не налаштовано: вкажіть адресу скрипта у config.js.'));
  } else {
    render();
    sync();
    // returning to the app: pick up the other person's entries and retry the queue
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !syncing) sync();
    });
  }
})();
