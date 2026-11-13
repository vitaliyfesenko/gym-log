(function () {
  var MONTHS = ['січ.', 'лют.', 'бер.', 'квіт.', 'трав.', 'черв.', 'лип.', 'серп.', 'вер.', 'жовт.', 'лист.', 'груд.'];

  function parseWeight(text) {
    var s = String(text).trim();
    if (s === '') return 0;
    if (!/^\d+([.,]\d+)?$/.test(s)) return null;
    var n = Number(s.replace(',', '.'));
    return n > 1000 ? null : n;
  }

  function parseCount(text, max) {
    var s = String(text).trim();
    if (!/^\d+$/.test(s)) return null;
    var n = Number(s);
    return n >= 1 && n <= max ? n : null;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function localDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function formatResult(r) {
    return String(r.weight).replace('.', ',') + ' кг × ' + r.reps + ' × ' + r.sets;
  }

  function formatShortDate(iso) {
    var p = iso.split('-');
    return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1];
  }

  function queueAdd(queue, entry) {
    var out = queue.filter(function (e) {
      return !(e.date === entry.date && e.exercise === entry.exercise);
    });
    out.push(entry);
    return out;
  }

  async function flushQueue(queue, send) {
    var rest = queue.slice();
    while (rest.length) {
      var res;
      try {
        res = await send(rest[0]);
      } catch (e) {
        return { queue: rest, failed: 'network' };
      }
      if (res && res.ok) {
        rest.shift();
      } else if (res && res.error === 'invalid_entry') {
        rest.shift();
      } else {
        return { queue: rest, failed: (res && res.error) || 'server_error' };
      }
    }
    return { queue: rest, failed: null };
  }

  function viewToday(state, queue, today) {
    var view = {};
    Object.keys(state.today || {}).forEach(function (ex) {
      var t = state.today[ex];
      view[ex] = { workout: t.workout, weight: t.weight, reps: t.reps, sets: t.sets, pending: false };
    });
    queue.forEach(function (e) {
      if (e.date !== today) return;
      view[e.exercise] = { workout: e.workout, weight: e.weight, reps: e.reps, sets: e.sets, pending: true };
    });
    return view;
  }

  var api = {
    parseWeight: parseWeight, parseCount: parseCount, localDate: localDate,
    formatResult: formatResult, formatShortDate: formatShortDate,
    queueAdd: queueAdd, flushQueue: flushQueue, viewToday: viewToday
  };
  globalThis.GymCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
