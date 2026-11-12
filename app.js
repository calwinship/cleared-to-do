// Cleared To Do: a task list you can see. Sequence = do now, Holding = not today, Landed = done.
// The radar draws the list as numbered traffic; real aircraft drift by in the background.
import { createRadar } from './radar.js';

const $ = (id) => document.getElementById(id);
const els = {
  boot: $('boot'), intake: $('intake'), dump: $('dump'), request: $('request'), startEmpty: $('start-empty'), error: $('error'),
  ghosts: $('ghosts'), board: $('board'), seq: $('seq'), hold: $('hold'), landed: $('landed'), landedBay: $('landed-bay'),
  landedSummary: $('landed-summary'), seqMeta: $('seq-meta'), holdMeta: $('hold-meta'), add: $('add'), addText: $('add-text'),
  addTime: $('add-time'), newBoard: $('new-board'), toast: $('toast'), announce: $('announce'),
};

let board = null;
let editingId = null;
let selectedId = null;

// --- storage (private windows may throw) ---
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let OWNER = store.get('ctd_owner');
if (!UUID.test(OWNER || '')) { OWNER = crypto.randomUUID(); store.set('ctd_owner', OWNER); }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hmm = (mins) => `${Math.floor(mins / 60)}:${String(Math.round(mins % 60)).padStart(2, '0')}`;
const say = (msg) => { els.announce.textContent = msg; };

// --- focus timer (one task at a time) ---
const elapsed = (f) => (f.timer ? f.timer.accMs + (f.timer.pausedAt ? 0 : Date.now() - Date.parse(f.timer.startedAt)) : 0);
const remaining = (f) => f.minutes * 60000 - elapsed(f);
function clock(ms) {
  const s = Math.max(0, Math.round(Math.abs(ms) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
const timerText = (f) => {
  const r = remaining(f);
  return r >= 0 ? `${f.timer.pausedAt ? '▶' : '⏸'} ${clock(r)}` : `+${clock(r)} over`;
};
const showError = (msg) => { els.error.textContent = msg; els.error.classList.toggle('hidden', !msg); };

// one-word radar label, same rule as the server
// Filler and time words never make a good label; the last remaining word usually names the thing.
const STOP = new Set(['THE', 'AND', 'FOR', 'WITH', 'FROM', 'ABOUT', 'INTO', 'BACK', 'SOME', 'MAYBE', 'CALL', 'BUY', 'GET', 'DO', 'TO', 'A', 'AN', 'MY', 'UP', 'OUT', 'OFF', 'BEFORE', 'AFTER', 'TODAY', 'TONIGHT', 'TOMORROW', 'SOMEDAY', 'LATER', 'POINT', 'WEEK', 'MONTH', 'NEXT', 'THIS', 'THAT', 'SOON', 'EVENTUALLY', 'PLEASE', 'AT', 'ON', 'IN', 'OF', 'BY']);
function shortLabel(task) {
  const words = String(task).toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const keep = words.filter((w) => !STOP.has(w) && w.length >= 3);
  return (keep.at(-1) || words[0] || 'TASK').slice(0, 10);
}
const labelOf = (f) => (f.callsign ? String(f.callsign).split(' ')[0] : shortLabel(f.task));

// --- toast with optional Undo ---
let toastTimer = null, toastUndo = null;
function toast(msg, { undo = null, error = false, ms = 5000 } = {}) {
  clearTimeout(toastTimer);
  toastUndo = undo;
  els.toast.className = `toast${error ? ' error' : ''}`;
  els.toast.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button" id="undo">Undo</button>' : ''}`;
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { clearTimeout(toastTimer); toastUndo = null; els.toast.classList.add('hidden'); }
els.toast.addEventListener('click', (e) => {
  if (!e.target.closest('#undo') || !toastUndo) return;
  const fn = toastUndo;
  hideToast();
  fn();
});

// --- model helpers ---
const live = () => board.flights.filter((f) => !f._pendingDelete);
const lanes = () => {
  const v = live();
  return { seq: v.filter((f) => !f.landed && f.lane === 'seq'), hold: v.filter((f) => !f.landed && f.lane === 'hold'), landed: v.filter((f) => f.landed) };
};
const find = (id) => board?.flights.find((f) => f.id === id);
const snapshot = () => board.flights.map((f) => ({ ...f }));
function reorder(seqIds, holdIds) {
  const byId = new Map(board.flights.map((f) => [f.id, f]));
  const placed = new Set([...seqIds, ...holdIds]);
  board.flights = [
    ...seqIds.map((id) => Object.assign(byId.get(id), { lane: 'seq' })),
    ...holdIds.map((id) => Object.assign(byId.get(id), { lane: 'hold' })),
    ...board.flights.filter((f) => !placed.has(f.id)),
  ];
}

// --- rendering ---
const PRESETS = [5, 10, 15, 30, 45, 60, 90, 120];
function stripHTML(f, num, { first = false } = {}) {
  const lane = f.landed ? 'landed' : f.lane === 'hold' ? 'hold' : 'seq';
  const id = esc(f.id), title = esc(f.task);
  const editing = f.id === editingId && !f.landed;
  const due = f.timer && !f.landed && remaining(f) < 0;
  const cls = ['strip', lane, first && 'first', f.id === selectedId && 'selected', editing && 'editing', due && 'due'].filter(Boolean).join(' ');
  let timerBit = '';
  if (f.timer && !f.landed) {
    timerBit = `<button class="timerbtn${f.timer.pausedAt ? ' paused' : ''}" type="button" data-act="pause" data-id="${id}" data-countdown="${id}" aria-label="${f.timer.pausedAt ? 'Resume timer' : 'Pause timer'}">${timerText(f)}</button>`;
  } else if (first && lane === 'seq' && !board.flights.some((x) => x.timer && !x.landed)) {
    timerBit = `<button class="startbtn" type="button" data-act="start" data-id="${id}" aria-label="Start timer for ${title}">▶ Start</button>`;
  }
  const handle = f.landed ? '<span></span>' : `<button class="handle" type="button" data-id="${id}" aria-label="Move: ${title}. Drag, or use the up and down arrow keys">⋮⋮</button>`;
  const edit = !editing ? '' : `
    <div class="edit">
      <label class="sr" for="name-${id}">Task name</label>
      <input type="text" id="name-${id}" data-name="${id}" maxlength="80" value="${title}">
      <div class="stepper" role="group" aria-label="Time">
        <button class="pill round" type="button" data-act="minus" data-id="${id}" aria-label="Less time">−</button>
        <b>${hmm(f.minutes)}</b>
        <button class="pill round" type="button" data-act="plus" data-id="${id}" aria-label="More time">+</button>
        ${PRESETS.map((m) => `<button class="pill${m === f.minutes ? ' on' : ''}" type="button" data-act="preset" data-min="${m}" data-id="${id}">${hmm(m)}</button>`).join('')}
      </div>
      <div class="row">
        <span>
          <button class="pill" type="button" data-act="${lane === 'hold' ? 'to-seq' : 'to-hold'}" data-id="${id}">${lane === 'hold' ? 'Move to Sequence' : 'Move to Holding'}</button>
          ${f.timer ? `<button class="pill" type="button" data-act="stop" data-id="${id}">Stop timer</button>` : ''}
          <button class="pill danger" type="button" data-act="delete" data-id="${id}">Delete</button>
        </span>
        <button class="pill on" type="button" data-act="close" data-id="${id}">Done</button>
      </div>
    </div>`;
  return `<li class="${cls}" data-id="${id}">
    ${handle}
    <span class="num" aria-hidden="true">${f.landed ? '' : num}</span>
    <div class="main" data-act="edit" data-id="${id}">
      <div class="title">${title}</div>
      <div class="meta"><button class="time" type="button" data-act="edit" data-id="${id}" aria-label="Time ${hmm(f.minutes)}. Change">${hmm(f.minutes)}</button>${timerBit}</div>
      ${due ? '<div class="dueline">Time’s up. Landed? Tap ✓, or keep going.</div>' : ''}
    </div>
    <button class="chk" type="button" data-act="toggle" data-id="${id}" aria-label="${f.landed ? `Not done: ${title}` : `Done: ${title}`}" aria-pressed="${!!f.landed}"></button>
    ${edit}
  </li>`;
}

function render() {
  els.boot.classList.add('hidden');
  if (!board) {
    els.board.classList.add('hidden');
    els.intake.classList.remove('hidden');
    els.ghosts.classList.toggle('hidden', !!store.get('ctd_typed') || !!els.dump.value.trim());
    radar.setTasks({ seq: [], hold: [] });
    return;
  }
  els.intake.classList.add('hidden');
  els.board.classList.remove('hidden');
  const { seq, hold, landed } = lanes();
  els.seq.innerHTML = seq.length ? seq.map((f, i) => stripHTML(f, i + 1, { first: i === 0 })).join('') : `<li class="empty">${hold.length ? 'Nothing up next. Drag a task up from Holding when you’re ready.' : 'All clear. Add a task below.'}</li>`;
  els.hold.innerHTML = hold.length ? hold.map((f, i) => stripHTML(f, `H${i + 1}`)).join('') : '<li class="empty">Drag tasks here to hold them for later.</li>';
  els.landed.innerHTML = landed.map((f) => stripHTML(f, '')).join('');
  els.landedBay.classList.toggle('hidden', !landed.length);
  els.landedSummary.textContent = `LANDED · ${landed.length} done`;
  const mins = (list) => list.reduce((a, f) => a + f.minutes, 0);
  els.seqMeta.textContent = seq.length ? `${seq.length} · ${hmm(mins(seq))} total` : '';
  els.holdMeta.textContent = hold.length ? `${hold.length} · ${hmm(mins(hold))}` : '';
  pushRadar();
  radar.select(selectedId);
  placeTraffic();
}

function pushRadar() {
  if (!board) return;
  const { seq, hold } = lanes();
  const toRadar = (f, num) => ({ id: f.id, task: f.task, label: labelOf(f), num, progress: f.timer ? Math.min(1, elapsed(f) / (f.minutes * 60000)) : null });
  radar.setTasks({ seq: seq.map((f, i) => toRadar(f, i + 1)), hold: hold.map((f, i) => ({ ...toRadar(f, `H${i + 1}`), progress: null })) });
}

// Once a second: countdowns; every 5 s: nudge the timed blip along the final.
let tickN = 0;
setInterval(() => {
  if (!board) return;
  const f = board.flights.find((x) => x.timer && !x.landed);
  if (!f) return;
  const span = document.querySelector(`[data-countdown="${CSS.escape(f.id)}"]`);
  if (span) span.textContent = timerText(f);
  const isDue = remaining(f) < 0;
  if (isDue !== !!f._wasDue) {
    f._wasDue = isDue;
    if (isDue) { toast(`Time’s up: ${f.task}`, { ms: 4000 }); say(`Time's up for ${f.task}`); }
    render();
  } else if (++tickN % 5 === 0 && !f.timer.pausedAt && !drag) pushRadar();
}, 1000);

function startTimer(id) {
  const f = find(id);
  if (!f || f.landed) return;
  for (const x of board.flights) if (x !== f && x.timer) x.timer = null; // one at a time
  f.timer = { startedAt: new Date().toISOString(), pausedAt: null, accMs: 0 };
  f._wasDue = false;
  render();
  persist();
  say(`Timer started: ${hmm(f.minutes)} for ${f.task}`);
}
function pauseTimer(id, force) {
  const f = find(id);
  if (!f?.timer) return;
  const t = f.timer;
  if (t.pausedAt && force !== 'pause') f.timer = { startedAt: new Date().toISOString(), pausedAt: null, accMs: t.accMs };
  else if (!t.pausedAt) f.timer = { ...t, accMs: elapsed(f), pausedAt: new Date().toISOString() };
  render();
  persist();
}
function stopTimer(id) {
  const f = find(id);
  if (!f) return;
  f.timer = null;
  f._wasDue = false;
  render();
  persist();
}

// --- live arrivals in the sequence: small grey rows slotted in by time ---
// "By time" = if you started your tasks now: an aircraft ~7 min out goes after a task that starts before then.
let arrivals = [];
let pickedHex = null;
const showTrafficBox = $('show-traffic');
showTrafficBox.checked = store.get('ctd_traffic') !== '0';
showTrafficBox.addEventListener('change', () => { store.set('ctd_traffic', showTrafficBox.checked ? '1' : '0'); placeTraffic(); });

function trafficRowHTML(a) {
  const cs = esc(a.sim && !/^SIM/.test(a.callsign) ? `SIM ${a.callsign}` : a.callsign);
  const alt = a.alt >= 10000 ? `FL${Math.round(a.alt / 100)}` : `${a.alt.toLocaleString('en-GB')} ft`;
  const sum = [a.type, alt, `${a.dist} nm`].filter(Boolean).join(' · ');
  return `<li class="traffic-row${a.hex === pickedHex ? ' picked' : ''}" data-hex="${esc(a.hex)}"><button type="button" data-hex="${esc(a.hex)}" aria-label="${cs}, ${esc(sum)}, ${a.eta < 1 ? 'landing now' : `about ${a.eta} minutes from landing`}. Show on radar"><span class="ac-cs">${cs}</span><span class="ac-sum">${esc(sum)}</span><span class="ac-eta">${a.eta < 1 ? 'landing' : `~${a.eta} min`}</span></button></li>`;
}

function placeTraffic() {
  if (drag) return; // never shuffle rows under a finger
  for (const r of document.querySelectorAll('.traffic-row')) r.remove();
  if (!board || !showTrafficBox.checked || !arrivals.length) return;
  const strips = [...els.seq.querySelectorAll(':scope > .strip')];
  const starts = [];
  let t = 0;
  for (const li of strips) { starts.push(t); t += find(li.dataset.id)?.minutes || 0; }
  for (const a of [...arrivals].reverse()) { // reverse + insert-after keeps the soonest first within a gap
    let j = -1;
    for (let k = 0; k < strips.length; k++) if (starts[k] <= a.eta) j = k;
    const anchor = j >= 0 ? strips[j] : els.seq.firstElementChild;
    const tmp = document.createElement('template');
    tmp.innerHTML = trafficRowHTML(a);
    if (anchor) anchor.after(tmp.content.firstElementChild); else els.seq.append(tmp.content.firstElementChild);
  }
}

function pickAircraft(hex, { fromRadar = false } = {}) {
  pickedHex = !fromRadar && pickedHex === hex ? null : hex;
  radar.selectAircraft(pickedHex);
  for (const r of document.querySelectorAll('.traffic-row')) r.classList.toggle('picked', r.dataset.hex === pickedHex);
  const row = pickedHex && document.querySelector(`.traffic-row[data-hex="${CSS.escape(pickedHex)}"]`);
  if (fromRadar && row) row.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.traffic-row button');
  if (b) pickAircraft(b.dataset.hex);
});

// --- radar <-> list ---
function jumpTo(id) {
  if (!find(id)) return;
  selectedId = id;
  render();
  const li = document.querySelector(`.strip[data-id="${CSS.escape(id)}"]`);
  if (!li) return;
  li.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  li.classList.remove('flash');
  void li.offsetWidth;
  li.classList.add('flash');
  li.querySelector('.handle, .chk')?.focus({ preventScroll: true });
}
const radar = createRadar($('scope'), {
  onSelectTask: jumpTo,
  onArrivals: (list) => { arrivals = list; if (pickedHex && !list.some((a) => a.hex === pickedHex)) radar.selectAircraft(pickedHex); placeTraffic(); },
  onSelectAircraft: (hex) => pickAircraft(hex, { fromRadar: true }),
  onRange: (r) => { $('range').textContent = `${r} nm`; },
  onStatus: (t) => {
    const credit = $('radar-credit');
    if (t.sim) credit.textContent = 'Background traffic: SIM (live feed unavailable)';
    else if (t.attribution) credit.innerHTML = `Background traffic: <a href="${esc(t.attribution.url)}" target="_blank" rel="noopener">adsb.lol, ODbL</a>`;
  },
});
$('range').addEventListener('click', () => { $('range').textContent = `${radar.cycleRange()} nm`; });
radar.start();

// --- actions ---
function toggleDone(id) {
  const f = find(id);
  if (!f) return;
  const before = snapshot();
  if (f.landed) {
    f.landed = false;
    f.landedAt = null;
    const { seq, hold } = lanes();
    reorder([...seq.map((x) => x.id).filter((x) => x !== id), id], hold.map((x) => x.id)); // back of the sequence
    toast(`Back in the sequence: ${f.task}`, { ms: 3000 });
  } else {
    f.landed = true;
    f.landedAt = new Date().toISOString();
    f.timer = null;
    if (editingId === id) editingId = null;
    toast(`Landed: ${f.task}`, { undo: () => { board.flights = before; render(); persist(); } });
  }
  render();
  persist();
}

function setMinutes(id, m) {
  const f = find(id);
  if (!f) return;
  f.minutes = Math.min(600, Math.max(5, m));
  render();
  persist();
}
const step = (m, dir) => (dir > 0 ? (m < 60 ? m + 5 : m + 15) : m <= 60 ? m - 5 : m - 15);

function setLane(id, lane) {
  const f = find(id);
  if (!f) return;
  const { seq, hold } = lanes();
  const s = seq.map((x) => x.id).filter((x) => x !== id);
  const h = hold.map((x) => x.id).filter((x) => x !== id);
  if (lane === 'seq') s.push(id); else h.unshift(id);
  if (lane === 'hold' && f.timer) pauseTimer(id, 'pause');
  reorder(s, h);
  render();
  persist();
  say(`${f.task} moved to ${lane === 'seq' ? 'the end of Sequence' : 'the top of Holding'}`);
}

// Deletes wait out the 5 s undo window before reaching the server.
const pendingDeletes = new Map();
function del(id) {
  const f = find(id);
  if (!f || f._pendingDelete) return;
  f._pendingDelete = true;
  if (editingId === id) editingId = null;
  pendingDeletes.set(id, setTimeout(() => commitDelete(id), 5000));
  render();
  toast(`Deleted: ${f.task}`, {
    undo: () => { clearTimeout(pendingDeletes.get(id)); pendingDeletes.delete(id); delete f._pendingDelete; render(); },
  });
}
function commitDelete(id, keepalive = false) {
  clearTimeout(pendingDeletes.get(id));
  pendingDeletes.delete(id);
  flush({ keepalive });
  board.flights = board.flights.filter((f) => f.id !== id);
}

function rename(id, text) {
  const f = find(id);
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!f || !t || t === f.task) return;
  f.task = t;
  f.callsign = shortLabel(t);
  render();
  persist();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !board) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'toggle': toggleDone(id); break;
    case 'edit': {
      const f = find(id);
      if (!f || f.landed) break;
      editingId = editingId === id && b.classList.contains('main') ? null : id;
      selectedId = id;
      render();
      if (editingId) document.querySelector(`[data-name="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      break;
    }
    case 'close': editingId = null; render(); break;
    case 'minus': case 'plus': { const f = find(id); if (f) setMinutes(id, step(f.minutes, b.dataset.act === 'plus' ? 1 : -1)); break; }
    case 'preset': setMinutes(id, +b.dataset.min); break;
    case 'to-hold': setLane(id, 'hold'); break;
    case 'to-seq': setLane(id, 'seq'); break;
    case 'delete': del(id); break;
    case 'start': startTimer(id); break;
    case 'pause': pauseTimer(id); break;
    case 'stop': stopTimer(id); break;
  }
});
document.addEventListener('change', (e) => { if (e.target.dataset?.name) rename(e.target.dataset.name, e.target.value); });
document.addEventListener('keydown', (e) => {
  if (e.target.dataset?.name && e.key === 'Enter') { rename(e.target.dataset.name, e.target.value); editingId = null; render(); }
  else if (e.key === 'Escape' && editingId) { editingId = null; render(); }
});

// Add a task by hand
els.add.addEventListener('submit', (e) => {
  e.preventDefault();
  const task = els.addText.value.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!task || !board) return;
  const f = { id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, task, callsign: shortLabel(task), minutes: +els.addTime.value || 15, lane: 'seq', landed: false };
  board.flights.push(f);
  const { seq, hold } = lanes();
  reorder(seq.map((x) => x.id), hold.map((x) => x.id));
  els.addText.value = '';
  render();
  persist();
  say(`Added ${task}`);
});

// --- drag to reorder (pointer events: mouse, touch and pen) ---
let drag = null;
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('.handle');
  if (!h || e.button > 0 || !board) return;
  const li = h.closest('.strip');
  e.preventDefault();
  const r = li.getBoundingClientRect();
  const ph = document.createElement('li');
  ph.className = 'placeholder';
  ph.style.height = `${r.height}px`;
  li.before(ph);
  Object.assign(li.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
  li.classList.add('dragging');
  h.setPointerCapture?.(e.pointerId);
  drag = { li, ph, id: li.dataset.id, dy: e.clientY - r.top, y: e.clientY, raf: 0, moved: false };
  const scroll = () => {
    if (!drag) return;
    const edge = 80;
    if (drag.y < edge) window.scrollBy(0, -Math.ceil((edge - drag.y) / 6));
    else if (drag.y > innerHeight - edge) window.scrollBy(0, Math.ceil((drag.y - innerHeight + edge) / 6));
    drag.raf = requestAnimationFrame(scroll);
  };
  drag.raf = requestAnimationFrame(scroll);
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.y = e.clientY;
  drag.moved = true;
  drag.li.style.top = `${e.clientY - drag.dy}px`;
  const under = document.elementsFromPoint(e.clientX, e.clientY);
  const target = under.find((n) => n.matches?.('#seq > .strip, #hold > .strip'));
  const rack = under.find((n) => n.matches?.('#seq, #hold'));
  for (const r of [els.seq, els.hold]) r.classList.toggle('drop-target', r === (target?.parentElement || rack));
  if (target) {
    const t = target.getBoundingClientRect();
    if (e.clientY < t.top + t.height / 2) target.before(drag.ph); else target.after(drag.ph);
  } else if (rack && !rack.contains(drag.ph)) {
    rack.querySelector('.empty')?.remove();
    rack.appendChild(drag.ph);
  }
});
function endDrag(commit) {
  if (!drag) return;
  cancelAnimationFrame(drag.raf);
  const { li, ph, id, moved } = drag;
  drag = null;
  for (const r of [els.seq, els.hold]) r.classList.remove('drop-target');
  if (commit && moved) {
    const ids = (rack) => [...rack.children].map((n) => (n === ph ? id : n.classList.contains('strip') && n !== li ? n.dataset.id : null)).filter(Boolean);
    const toHold = ph.parentElement === els.hold;
    if (toHold && find(id)?.timer) pauseTimer(id, 'pause');
    reorder(ids(els.seq), ids(els.hold));
    const now = lanes();
    const pos = (toHold ? now.hold : now.seq).findIndex((x) => x.id === id) + 1;
    say(`${find(id)?.task} moved to ${toHold ? 'Holding' : 'Sequence'}, position ${pos}`);
    persist();
  }
  li.removeAttribute('style');
  render();
}
document.addEventListener('pointerup', () => endDrag(true));
document.addEventListener('pointercancel', () => endDrag(false));

// Keyboard: arrow keys on a handle move the task one place, and across the Sequence/Holding line.
document.addEventListener('keydown', (e) => {
  const h = e.target.closest?.('.handle');
  if (!h || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !board) return;
  e.preventDefault();
  const id = h.dataset.id;
  const { seq, hold } = lanes();
  const s = seq.map((f) => f.id), hl = hold.map((f) => f.id);
  const inSeq = s.includes(id);
  const list = inSeq ? s : hl;
  const i = list.indexOf(id);
  if (e.key === 'ArrowUp') {
    if (i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    else if (!inSeq) { hl.shift(); s.push(id); }
  } else if (i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
  else if (inSeq) { s.pop(); hl.unshift(id); }
  reorder(s, hl);
  render();
  persist();
  const now = lanes();
  const where = now.seq.some((f) => f.id === id) ? `Sequence, position ${now.seq.findIndex((f) => f.id === id) + 1}` : `Holding, position ${now.hold.findIndex((f) => f.id === id) + 1}`;
  say(`Moved to ${where}`);
  document.querySelector(`.handle[data-id="${CSS.escape(id)}"]`)?.focus();
});

// --- persistence (debounced; flushed when leaving the page) ---
let saveTimer = null, saveChain = Promise.resolve();
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => flush(), 350); }
function flush({ keepalive = false } = {}) {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!board?.id) return;
  const flights = board.flights.map((f) => ({
    id: f.id, task: f.task, minutes: f.minutes, lane: f.lane, landed: !!f.landed, landedAt: f.landedAt || null, timer: f.timer || null,
    deleted: f._pendingDelete && !pendingDeletes.has(f.id) ? true : undefined,
  }));
  const body = JSON.stringify({ owner: OWNER, id: board.id, flights });
  saveChain = saveChain.then(() =>
    fetch('/api/boards', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body, keepalive })
      .then(async (r) => {
        if (!r.ok) throw new Error(`save HTTP ${r.status}`);
        const { flights: saved } = await r.json();
        const labels = new Map((saved || []).map((f) => [f.id, f.callsign]));
        for (const f of board?.flights || []) if (labels.get(f.id)) f.callsign = labels.get(f.id);
      })
      .catch((err) => { console.warn('[CTD] save failed', err); toast('Offline: changes not saved yet', { error: true, ms: 4000 }); })
  );
}
addEventListener('pagehide', () => {
  for (const id of [...pendingDeletes.keys()]) commitDelete(id, true);
  if (saveTimer) flush({ keepalive: true });
});

// --- load / create ---
async function restore() {
  try {
    const r = await fetch(`/api/boards?owner=${encodeURIComponent(OWNER)}`, { cache: 'no-store' });
    const data = await r.json();
    if (r.ok && data.board) board = data.board;
  } catch (err) {
    console.warn('[CTD] restore failed', err);
  }
  render();
}

els.dump.addEventListener('input', () => {
  if (els.dump.value.trim() && !store.get('ctd_typed')) { store.set('ctd_typed', '1'); els.ghosts.classList.add('hidden'); }
});

els.request.addEventListener('click', async () => {
  const text = els.dump.value.trim();
  if (!text) { showError('Type a few things first: anything on your mind.'); return; }
  showError('');
  els.request.disabled = true;
  els.dump.disabled = true;
  els.request.textContent = 'Sorting your list…';
  try {
    const r = await fetch('/api/clearance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, owner: OWNER }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.board) throw new Error(data.error || `Couldn't sort that (HTTP ${r.status}).`);
    board = data.board;
    editingId = selectedId = null;
    render();
  } catch (err) {
    showError(`${err.message} You can try again, or add tasks one by one.`);
  } finally {
    els.request.disabled = false;
    els.dump.disabled = false;
    els.request.textContent = 'Sort my list';
  }
});

els.startEmpty.addEventListener('click', async () => {
  showError('');
  try {
    const r = await fetch('/api/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER, flights: [] }) });
    const data = await r.json();
    if (!r.ok || !data.board) throw new Error(data.error || `HTTP ${r.status}`);
    board = data.board;
    render();
    els.addText.focus();
  } catch (err) {
    showError(`Couldn't start a list: ${err.message}`);
  }
});

els.newBoard.addEventListener('click', () => {
  hideToast();
  for (const id of [...pendingDeletes.keys()]) commitDelete(id);
  if (board?.id) {
    fetch('/api/boards', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER, id: board.id, archived: true }) }).catch(() => {});
  }
  board = null;
  editingId = selectedId = null;
  els.dump.value = '';
  render();
  els.dump.focus();
});

const guide = $('guide');
$('help').addEventListener('click', () => guide.showModal());
$('guide-close').addEventListener('click', () => guide.close());
guide.addEventListener('click', (e) => { if (e.target === guide) guide.close(); });

restore();
