// Cleared To Do: client. One board per device; strips are tasks, the radar (stage 2) shows them as traffic.
const $ = (id) => document.getElementById(id);
const els = {
  intake: $('intake'), dump: $('dump'), count: $('count'), request: $('request'), error: $('error'),
  board: $('board'), transmission: $('transmission'), tx: $('tx'), readback: $('readback'), voiceStatus: $('voice-status'),
  seq: $('seq'), hold: $('hold'), landed: $('landed'), landedBay: $('landed-bay'), landedSummary: $('landed-summary'),
  seqMeta: $('seq-meta'), holdMeta: $('hold-meta'), stamp: $('stamp'), newBoard: $('new-board'), toast: $('toast'),
  localClock: $('local-clock'), zulu: $('zulu'),
};

let board = null;

// --- storage helpers (private windows may throw) ---
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// Anonymous device ID: no login, boards are keyed by this.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let OWNER = store.get('ctd_owner');
if (!UUID.test(OWNER || '')) { OWNER = crypto.randomUUID(); store.set('ctd_owner', OWNER); }

// --- time formatting ---
const pad = (n) => String(n).padStart(2, '0');
export const hmm = (mins) => `${Math.floor(mins / 60)}:${pad(Math.round(mins % 60))}`; // durations: 0:30, 1:05
export const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`; // local clock
const zulu = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;

function tick() {
  const d = new Date();
  els.localClock.textContent = hhmm(d);
  els.zulu.textContent = zulu(d);
}
tick();
setInterval(tick, 5000);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const showError = (msg) => { els.error.textContent = msg; els.error.classList.toggle('hidden', !msg); };

els.dump.addEventListener('input', () => { els.count.textContent = `${els.dump.value.length}/2000`; });

// --- toast (with optional Undo) ---
let toastTimer = null;
let toastUndo = null;
function toast(msg, { undo = null, error = false, ms = 5000 } = {}) {
  clearTimeout(toastTimer);
  toastUndo = undo;
  els.toast.className = `toast${error ? ' error' : ''}`;
  els.toast.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button" id="undo">Undo</button>' : ''}`;
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  clearTimeout(toastTimer);
  toastUndo = null;
  els.toast.classList.add('hidden');
}
els.toast.addEventListener('click', (e) => {
  if (!e.target.closest('#undo') || !toastUndo) return;
  const fn = toastUndo;
  hideToast();
  fn();
});

// --- board model helpers ---
const visible = () => board.flights.filter((f) => !f._pendingDelete);
const lanes = () => {
  const v = visible();
  return {
    seq: v.filter((f) => !f.landed && f.lane === 'seq'),
    hold: v.filter((f) => !f.landed && f.lane === 'hold'),
    landed: v.filter((f) => f.landed),
  };
};
const find = (id) => board?.flights.find((f) => f.id === id);
const snapshot = () => board.flights.map((f) => ({ ...f }));
function moveToEnd(f) {
  board.flights.splice(board.flights.indexOf(f), 1);
  board.flights.push(f);
}

// --- rendering ---
function stripHTML(f, pos, opts = {}) {
  const lane = f.lane === 'hold' ? 'hold' : 'seq';
  const classes = ['strip', lane];
  if (f.landed) classes.push('landed');
  if (opts.cleared) classes.push('cleared');
  if (f.promoted) classes.push('promoted');
  let no, sub;
  if (f.landed) { no = '✓'; sub = 'DOWN'; }
  else if (lane === 'seq') { no = pad(pos); sub = opts.cleared ? 'CLRD' : (f.promoted ? 'PROM' : 'SEQ'); }
  else { no = 'H' + pos; sub = 'HOLD'; }
  const note = lane === 'hold' && f.note && !f.landed ? `<span class="note">${esc(f.note)}</span>` : '';
  const cs = esc(f.callsign);
  const id = esc(f.id);
  const del = `<button class="land sm del" type="button" data-act="delete" data-id="${id}" aria-label="Delete ${cs}" title="Delete">✕</button>`;
  let act;
  if (f.landed) {
    act = `<button class="land sm" type="button" data-act="return" data-id="${id}" aria-label="Return ${cs} to sequence">Return to sequence</button><div class="row">${del}</div>`;
  } else if (lane === 'seq') {
    act = `<button class="land" type="button" data-act="land" data-id="${id}" aria-label="Mark ${cs} landed">Landed</button>` +
      `<div class="row"><button class="land sm" type="button" data-act="hold" data-id="${id}" aria-label="Send ${cs} to holding">Hold</button>${del}</div>`;
  } else {
    act = `<button class="land" type="button" data-act="clear" data-id="${id}" aria-label="Clear ${cs} into the sequence">Clear</button><div class="row">${del}</div>`;
  }
  return `<article class="${classes.join(' ')}" data-id="${id}">
    <div class="no"><b>${esc(no)}</b><small>${sub}</small></div>
    <div class="main">
      <div class="cs">${cs}</div>
      <div class="task">${esc(f.task)}</div>
      <div class="meta"><span>EST ${hmm(f.minutes)}</span>${note}</div>
    </div>
    <div class="act">${act}</div>
  </article>`;
}

export function render() {
  $('boot')?.remove();
  if (!board) {
    els.board.classList.add('hidden');
    els.intake.classList.remove('hidden');
    return;
  }
  els.intake.classList.add('hidden');
  els.board.classList.remove('hidden');
  els.transmission.textContent = board.transmission;

  const { seq, hold, landed } = lanes();
  els.seq.innerHTML = seq.length
    ? seq.map((f, i) => stripHTML(f, i + 1, { cleared: i === 0 })).join('')
    : `<div class="empty">${hold.length ? 'Runway clear.' : 'All traffic landed. Runway clear. Good day.'}</div>`;
  els.hold.innerHTML = hold.length
    ? hold.map((f, i) => stripHTML(f, i + 1)).join('')
    : '<div class="empty">Holding stack empty.</div>';
  els.landed.innerHTML = landed.map((f) => stripHTML(f, 0)).join('');
  els.landedBay.classList.toggle('hidden', !landed.length);
  els.landedSummary.textContent = `LANDED · ${landed.length}`;

  const mins = (list) => list.reduce((a, f) => a + f.minutes, 0);
  els.seqMeta.textContent = seq.length ? `${seq.length} ACFT · EST ${hmm(mins(seq))}` : '';
  els.holdMeta.textContent = hold.length ? `${hold.length} ACFT · EST ${hmm(mins(hold))}` : '';
  els.stamp.textContent = `ISSUED ${hhmm(new Date(board.createdAt || Date.now()))}`;
}

// --- strip controls ---
function land(id) {
  const f = find(id);
  if (!f || f.landed) return;
  const before = snapshot();
  f.landed = true;
  f.landedAt = new Date().toISOString();
  // If the sequence is now empty, promote the top of the holding stack.
  const { seq, hold } = lanes();
  if (!seq.length && hold.length) { hold[0].lane = 'seq'; hold[0].promoted = true; }
  const el = document.querySelector(`.strip[data-id="${CSS.escape(id)}"]`);
  const finish = () => { render(); persist(); };
  if (el && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.classList.add('landed');
    setTimeout(() => { el.classList.add('leaving'); setTimeout(finish, 300); }, 350);
  } else finish();
  toast(`${f.callsign} landed.`, { undo: () => { board.flights = before; render(); persist(); } });
}

function setLane(id, lane) {
  const f = find(id);
  if (!f) return;
  f.lane = lane;
  f.landed = false;
  f.landedAt = null;
  f.promoted = false;
  moveToEnd(f); // joins the back of the sequence / holding stack
  render();
  persist();
}

// Deletes wait out the 5s undo window before reaching the server.
const pendingDeletes = new Map(); // id -> timer
function del(id) {
  const f = find(id);
  if (!f || f._pendingDelete) return;
  f._pendingDelete = true;
  pendingDeletes.set(id, setTimeout(() => commitDelete(id), 5000));
  render();
  toast(`${f.callsign} deleted.`, {
    undo: () => {
      clearTimeout(pendingDeletes.get(id));
      pendingDeletes.delete(id);
      delete f._pendingDelete;
      render();
    },
  });
}
function commitDelete(id, keepalive = false) {
  clearTimeout(pendingDeletes.get(id));
  pendingDeletes.delete(id);
  persist({ keepalive });
  board.flights = board.flights.filter((f) => f.id !== id);
}
// Leaving the page inside an undo window still deletes.
addEventListener('pagehide', () => { for (const id of [...pendingDeletes.keys()]) commitDelete(id, true); });

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !board) return;
  const id = b.getAttribute('data-id');
  const act = b.getAttribute('data-act');
  if (act === 'land') land(id);
  else if (act === 'hold') setLane(id, 'hold');
  else if (act === 'clear' || act === 'return') setLane(id, 'seq');
  else if (act === 'delete') del(id);
});

// --- persistence (Neon via /api/boards) ---
let saveChain = Promise.resolve();
function persist({ keepalive = false } = {}) {
  if (!board?.id) return;
  const flights = board.flights.map((f) => ({
    id: f.id, landed: !!f.landed, landedAt: f.landedAt || null, lane: f.lane, promoted: !!f.promoted, race: f.race || null,
    // a pending delete is only sent as deleted when its undo window has closed (commitDelete)
    deleted: f._pendingDelete && !pendingDeletes.has(f.id) ? true : undefined,
  }));
  const payload = JSON.stringify({ owner: OWNER, id: board.id, flights });
  saveChain = saveChain.then(() =>
    fetch('/api/boards', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive })
      .then((r) => { if (!r.ok) throw new Error(`save HTTP ${r.status}`); })
      .catch((err) => { console.warn('[CTD] save failed', err); toast('Tower log offline · progress not saved', { error: true, ms: 4000 }); })
  );
}

// --- Read back: the browser's own speech synthesis, off by default ---
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
let speaking = false;
let towerBusy = false;
function updateTx() { els.tx.classList.toggle('on', towerBusy || speaking); }

function pickVoice() {
  const voices = synth?.getVoices() || [];
  const pref = ['en-IE', 'en-GB', 'en-AU', 'en-US'];
  for (const lang of pref) {
    const v = voices.find((x) => x.lang?.replace('_', '-') === lang && x.localService) || voices.find((x) => x.lang?.replace('_', '-') === lang);
    if (v) return v;
  }
  return voices.find((x) => /^en/i.test(x.lang)) || null;
}

function speak(text) {
  if (!synth || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = 1.05;
  u.onstart = () => { speaking = true; updateTx(); els.voiceStatus.textContent = 'Transmitting'; };
  u.onend = u.onerror = () => { speaking = false; updateTx(); els.voiceStatus.textContent = ''; };
  synth.speak(u);
}
function stopSpeaking() {
  synth?.cancel();
  speaking = false;
  updateTx();
  els.voiceStatus.textContent = '';
}

if (!synth) {
  els.readback.disabled = true;
  els.voiceStatus.textContent = 'Not supported in this browser';
}
els.readback.checked = !!synth && store.get('ctd_readback') === '1';
els.readback.addEventListener('change', () => {
  store.set('ctd_readback', els.readback.checked ? '1' : '0');
  if (els.readback.checked) speak(board?.transmission);
  else stopSpeaking();
});

// --- stand-by chatter while the tower works out the board ---
let standbyTimer = null;
const STANDBY = ['Stand by...', 'Checking the sequence...', 'Traffic in sight...', 'Sequencing traffic...', 'Copy your intentions...', 'Clearing the runway...'];
function startStandby() {
  let i = 0;
  towerBusy = true;
  els.board.classList.remove('hidden');
  els.board.classList.add('loading');
  els.board.setAttribute('aria-busy', 'true');
  els.transmission.textContent = STANDBY[0];
  clearInterval(standbyTimer);
  standbyTimer = setInterval(() => { els.transmission.textContent = STANDBY[++i % STANDBY.length]; }, 2000);
  updateTx();
  els.board.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function stopStandby() {
  clearInterval(standbyTimer);
  standbyTimer = null;
  towerBusy = false;
  els.board.classList.remove('loading');
  els.board.removeAttribute('aria-busy');
  updateTx();
}

// --- load / request ---
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

els.request.addEventListener('click', async () => {
  const text = els.dump.value.trim();
  if (!text) { showError('Say intentions: brain-dump at least one task.'); return; }
  showError('');
  stopSpeaking();
  // iOS only lets speech start from a tap: prime it now so the read-back can play when the board arrives.
  if (els.readback.checked && synth) synth.speak(new SpeechSynthesisUtterance(''));
  els.request.disabled = true;
  els.request.innerHTML = 'Contacting tower<span class="scanning">_</span>';
  startStandby();
  try {
    const r = await fetch('/api/clearance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, owner: OWNER }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.board) throw new Error(data.error || `Tower unavailable (HTTP ${r.status}).`);
    stopStandby();
    board = data.board;
    render();
    if (els.readback.checked) speak(board.transmission);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    stopStandby();
    els.board.classList.add('hidden');
    showError(err.message || 'Frequency congested, try again.');
  } finally {
    els.request.disabled = false;
    els.request.textContent = 'Request clearance';
  }
});

els.newBoard.addEventListener('click', () => {
  stopSpeaking();
  hideToast();
  for (const id of [...pendingDeletes.keys()]) commitDelete(id);
  if (board?.id) {
    fetch('/api/boards', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, id: board.id, archived: true }),
    }).catch(() => {});
  }
  board = null;
  els.dump.value = '';
  els.count.textContent = '0/2000';
  render();
  els.dump.focus();
});

restore();
