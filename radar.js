// Radar scope: plain SVG centred on EIDW. Real traffic = dim blips; your tasks = bright blips on the
// approach (sequence) or orbiting a hold (holding). Falls back to labelled SIM traffic when the feed is
// down or empty.
import { ARP, RUNWAYS, destination, bearing, distNm, angleDiff } from './shared/eidw.js';

const NS = 'http://www.w3.org/2000/svg';
const SIZE = 1000; // viewBox units; the SVG scales to its container
const RANGES = [10, 20, 40, 60];
const POLL_MS = 10000;
const KT_TO_NM_PER_MS = 1 / 3600000;
const HOLD_FIX = destination(ARP, 40, 13); // a racetrack hold north-east of the field (illustrative)
const HOLD_INBOUND = 220; // inbound leg heads towards the field
const FORCE_SIM = new URLSearchParams(location.search).has('sim'); // ?sim shows simulated traffic (demo/testing)

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

export function createRadar(container, { onSelectTask } = {}) {
  let range = 20;
  try { range = RANGES.includes(+localStorage.getItem('ctd_range')) ? +localStorage.getItem('ctd_range') : 20; } catch {}
  let scale = SIZE / 2 / range; // px per nm
  const cosLat = Math.cos((ARP.lat * Math.PI) / 180);
  const project = (p) => ({
    x: SIZE / 2 + (p.lon - ARP.lon) * 60 * cosLat * scale,
    y: SIZE / 2 - (p.lat - ARP.lat) * 60 * scale,
  });

  const svg = el('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'scope', role: 'img', 'aria-label': 'Radar around Dublin Airport' }, container);
  const defs = el('defs', {}, svg);
  const clip = el('clipPath', { id: 'scope-clip' }, defs);
  el('circle', { cx: SIZE / 2, cy: SIZE / 2, r: SIZE / 2 - 2 }, clip);
  el('circle', { cx: SIZE / 2, cy: SIZE / 2, r: SIZE / 2 - 2, class: 'scope-bg' }, svg);
  const world = el('g', { 'clip-path': 'url(#scope-clip)' }, svg);
  const gStatic = el('g', {}, world);
  const gTraffic = el('g', { class: 'traffic' }, world);
  const gTasks = el('g', { class: 'tasks' }, world);
  const sweep = el('line', { x1: SIZE / 2, y1: SIZE / 2, x2: SIZE / 2, y2: 0, class: 'sweep' }, world);
  const badge = el('text', { x: 24, y: 44, class: 'badge' }, svg);
  const rangeLabel = el('text', { x: SIZE - 24, y: 44, class: 'range-label', 'text-anchor': 'end' }, svg);

  let traffic = { aircraft: [], fetchedAt: 0, sim: false, source: null, attribution: null };
  let tasks = { seq: [], hold: [] };
  let selectedTask = null;
  let pairedHex = null;
  let extras = () => [];
  let landingRunway = RUNWAYS[1].thresholds[1]; // 28L until traffic says otherwise
  const nodes = new Map(); // hex -> {g, blip, vec, label, disp:{x,y}, off:{x,y,t}}
  const taskNodes = new Map();
  const listeners = new Set();

  // ---------- static layers ----------
  function drawStatic() {
    gStatic.innerHTML = '';
    scale = SIZE / 2 / range;
    const step = range <= 10 ? 2.5 : range <= 20 ? 5 : range <= 40 ? 10 : 15;
    for (let r = step; r <= range + 0.01; r += step) {
      el('circle', { cx: SIZE / 2, cy: SIZE / 2, r: r * scale, class: 'ring' }, gStatic);
      const t = el('text', { x: SIZE / 2 + 6, y: SIZE / 2 - r * scale + 22, class: 'ring-label' }, gStatic);
      t.textContent = `${r}`;
    }
    for (let b = 0; b < 360; b += 30) {
      const a = (b * Math.PI) / 180;
      const r1 = SIZE / 2 - 2, r0 = r1 - (b % 90 ? 12 : 24);
      el('line', { x1: SIZE / 2 + Math.sin(a) * r0, y1: SIZE / 2 - Math.cos(a) * r0, x2: SIZE / 2 + Math.sin(a) * r1, y2: SIZE / 2 - Math.cos(a) * r1, class: 'tick' }, gStatic);
    }
    // extended centreline of the landing runway, with 1 nm ticks
    const thr = project(landingRunway);
    const out = project(destination(landingRunway, (landingRunway.brg + 180) % 360, Math.min(range, 25)));
    el('line', { x1: thr.x, y1: thr.y, x2: out.x, y2: out.y, class: 'centreline' }, gStatic);
    for (const rw of RUNWAYS) {
      const a = project(rw.ends[0]), b = project(rw.ends[1]);
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'runway', 'stroke-width': Math.max(5, (45 / 1852) * scale * 2.5) }, gStatic);
    }
    const lbl = el('text', { x: thr.x + 10, y: thr.y + 34, class: 'rwy-label' }, gStatic);
    lbl.textContent = landingRunway.id;
    rangeLabel.textContent = `${range} NM`;
  }

  // ---------- traffic ----------
  const isAirborne = (a) => !a.ground && a.alt != null && a.alt > 0;
  function extrapolate(a, now) {
    if (!a.gs || a.track == null) return a;
    const nm = a.gs * (now - a.fixAt) * KT_TO_NM_PER_MS;
    return nm > 0.01 ? { ...a, ...destination(a, a.track, Math.min(nm, 3)) } : a;
  }

  function setTraffic(payload) {
    const live = (payload?.aircraft || []).filter(isAirborne);
    const fetchedAt = payload?.fetchedAt ? Date.parse(payload.fetchedAt) : Date.now();
    const sim = FORCE_SIM || !live.length || !!payload?.error;
    traffic = {
      sim,
      source: sim ? null : payload.source,
      attribution: payload?.attribution || null,
      fetchedAt,
      aircraft: sim ? [] : live.map((a) => ({ ...a, fixAt: fetchedAt - (a.seen || 0) * 1000 })),
    };
    if (!sim) chooseRunway(traffic.aircraft);
    badge.textContent = sim ? 'SIM · simulated traffic' : `LIVE · ${traffic.aircraft.length} ACFT`;
    badge.setAttribute('class', sim ? 'badge sim' : 'badge');
    for (const fn of listeners) fn(api.aircraft());
  }

  // Landing direction: whichever runway end the low, aligned inbound traffic is lined up for.
  function chooseRunway(list) {
    const votes = new Map();
    for (const a of list) {
      if (a.alt > 5000 || a.track == null || (a.vs ?? 0) > 200 || (a.gs ?? 0) < 90) continue; // skip climbers, helicopters
      for (const rw of RUNWAYS) for (const t of rw.thresholds) {
        const d = distNm(a, t);
        if (d > 15 || angleDiff(a.track, t.brg) > 25) continue;
        if (angleDiff(bearing(a, t), t.brg) > 20) continue; // in front of the threshold, on its approach side
        votes.set(t.id, (votes.get(t.id) || 0) + 1);
      }
    }
    const best = [...votes].sort((x, y) => y[1] - x[1])[0];
    if (!best || best[1] < 2) return; // need two aligned arrivals before switching from the current runway
    const t = RUNWAYS.flatMap((r) => r.thresholds).find((x) => x.id === best[0]);
    if (t && t.id !== landingRunway.id) { landingRunway = t; drawStatic(); }
  }

  // SIM traffic: arrivals streaming down the approach plus a couple of overflights, as a pure function of time.
  function simAircraft(now) {
    const out = [];
    const inbound = (landingRunway.brg + 180) % 360;
    for (let i = 0; i < 5; i++) {
      const period = 30 * 60000;
      const phase = ((now / period + i / 5) % 1); // 0..1 along a 30 min arrival
      const nm = 28 * (1 - phase);
      const p = destination(landingRunway, inbound, nm);
      out.push({ hex: `sim${i}`, callsign: `SIM${101 + i * 7}`, ...p, alt: Math.round(nm * 318 + 300), gs: 140 + nm * 3, track: landingRunway.brg, vs: -700, sim: true, fixAt: now });
    }
    for (let i = 0; i < 2; i++) {
      const period = 12 * 60000;
      const phase = (now / period + i / 2) % 1;
      const hdg = i ? 135 : 300;
      const start = destination(ARP, (hdg + 180) % 360, 45);
      const p = destination(start, hdg, 90 * phase);
      out.push({ hex: `simx${i}`, callsign: `SIM${300 + i * 11}`, ...p, alt: i ? 34000 : 37000, gs: 450, track: hdg, vs: 0, sim: true, fixAt: now });
    }
    return out;
  }

  function drawTraffic(now) {
    const list = (traffic.sim ? simAircraft(now) : traffic.aircraft.map((a) => extrapolate(a, now))).concat(extras(now));
    const seen = new Set();
    for (const a of list) {
      seen.add(a.hex);
      let n = nodes.get(a.hex);
      if (!n) {
        const g = el('g', { class: `ac${a.sim ? ' sim' : ''}` }, gTraffic);
        n = { g, vec: el('line', { class: 'vec' }, g), blip: el('rect', { width: 12, height: 12, class: 'blip' }, g), label: el('text', { class: 'ac-label' }, g), alt: el('text', { class: 'ac-label alt' }, g), disp: null, off: null };
        nodes.set(a.hex, n);
      }
      const p = project(a);
      // smooth: when a fresh fix lands somewhere new, ease from where the blip was drawn
      if (n.disp && n.lastFix !== a.fixAt && !a.sim) n.off = { x: n.disp.x - p.x, y: n.disp.y - p.y, t: now };
      n.lastFix = a.fixAt;
      let ox = 0, oy = 0;
      if (n.off) {
        const k = Math.max(0, 1 - (now - n.off.t) / 1500);
        ox = n.off.x * k; oy = n.off.y * k;
        if (!k) n.off = null;
      }
      const x = p.x + ox, y = p.y + oy;
      n.disp = { x, y };
      n.g.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
      n.blip.setAttribute('x', -6); n.blip.setAttribute('y', -6);
      const vlen = ((a.gs || 0) / 60) * scale; // one minute of flight
      const tr = ((a.track || 0) * Math.PI) / 180;
      n.vec.setAttribute('x2', (Math.sin(tr) * vlen).toFixed(1));
      n.vec.setAttribute('y2', (-Math.cos(tr) * vlen).toFixed(1));
      n.label.setAttribute('x', 14); n.label.setAttribute('y', -8);
      n.alt.setAttribute('x', 14); n.alt.setAttribute('y', 22);
      n.label.textContent = a.callsign || a.hex;
      n.alt.textContent = `${pad3(Math.round((a.alt || 0) / 100))}${a.vs < -300 ? '↓' : a.vs > 300 ? '↑' : ''}`;
      n.g.classList.toggle('paired', a.hex === pairedHex);
    }
    for (const [hex, n] of nodes) if (!seen.has(hex)) { n.g.remove(); nodes.delete(hex); }
  }
  const pad3 = (n) => String(Math.max(0, n)).padStart(3, '0');

  // ---------- task blips ----------
  function taskPositions(now) {
    const pos = new Map();
    const inbound = (landingRunway.brg + 180) % 360;
    tasks.seq.forEach((t, i) => pos.set(t.id, { ...destination(landingRunway, inbound, 3 + i * 3), lane: 'seq', i }));
    // racetrack: two 4 nm legs joined by semicircles; tasks spaced evenly and orbiting (4 min per lap)
    const leg = 4, r = 1.2, lap = 2 * leg + 2 * Math.PI * r;
    // local frame at the fix: u along the inbound course, v to the right (right-hand pattern)
    const at = (u, v) => destination(destination(HOLD_FIX, u >= 0 ? HOLD_INBOUND : (HOLD_INBOUND + 180) % 360, Math.abs(u)), v >= 0 ? (HOLD_INBOUND + 90) % 360 : (HOLD_INBOUND + 270) % 360, Math.abs(v));
    tasks.hold.forEach((t, i) => {
      let s = ((now / 240000 + i / Math.max(1, tasks.hold.length)) % 1) * lap;
      let u, v;
      if (s < leg) { u = -leg + s; v = 0; } // inbound leg, ending at the fix
      else if ((s -= leg) < Math.PI * r) { const th = s / r; u = r * Math.sin(th); v = r - r * Math.cos(th); } // turn over the fix
      else if ((s -= Math.PI * r) < leg) { u = -s; v = 2 * r; } // outbound leg
      else { s -= leg; const th = s / r; u = -leg - r * Math.sin(th); v = r + r * Math.cos(th); } // turn back onto inbound
      pos.set(t.id, { ...at(u, v), lane: 'hold', i });
    });
    return pos;
  }

  function drawTasks(now) {
    const pos = taskPositions(now);
    for (const [id, n] of taskNodes) if (!pos.has(id)) { n.g.remove(); taskNodes.delete(id); }
    for (const t of [...tasks.seq, ...tasks.hold]) {
      const p = pos.get(t.id);
      let n = taskNodes.get(t.id);
      if (!n) {
        const g = el('g', { class: 'task', tabindex: 0, role: 'button', 'data-task': t.id }, gTasks);
        n = { g, ring: el('circle', { r: 26, class: 'sel-ring' }, g), blip: el('path', { d: 'M0,-13 L13,0 L0,13 L-13,0 Z', class: 'tblip' }, g), label: el('text', { x: 20, y: 10, class: 'task-label' }, g), hit: el('circle', { r: 34, class: 'hit' }, g) };
        g.addEventListener('click', () => onSelectTask?.(t.id));
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectTask?.(t.id); } });
        taskNodes.set(t.id, n);
      }
      const xy = project(p);
      n.g.setAttribute('transform', `translate(${xy.x.toFixed(1)},${xy.y.toFixed(1)})`);
      n.g.setAttribute('class', `task ${p.lane}${t.id === selectedTask ? ' selected' : ''}${p.lane === 'seq' && p.i === 0 ? ' first' : ''}`);
      n.g.setAttribute('aria-label', `${t.callsign}, ${p.lane === 'seq' ? `number ${p.i + 1} on approach` : 'holding'}`);
      n.label.textContent = t.callsign.split(' ')[0];
    }
  }

  // ---------- loop + polling ----------
  let raf = 0, lastFrame = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (ts - lastFrame < (reduced.matches ? 1000 : 66)) return; // ~15 fps, 1 fps with reduced motion
    lastFrame = ts;
    const now = Date.now();
    drawTraffic(now);
    drawTasks(now);
    if (!reduced.matches) {
      const a = ((now / 4000) % 1) * 2 * Math.PI;
      sweep.setAttribute('x2', SIZE / 2 + Math.sin(a) * (SIZE / 2));
      sweep.setAttribute('y2', SIZE / 2 - Math.cos(a) * (SIZE / 2));
    } else sweep.setAttribute('visibility', 'hidden');
  }

  let pollTimer = 0;
  async function poll() {
    clearTimeout(pollTimer);
    try {
      const r = await fetch('/api/traffic', { cache: 'no-store' });
      setTraffic(r.ok ? await r.json() : { error: `HTTP ${r.status}` });
    } catch (err) {
      setTraffic({ error: err.message });
    }
    onAttribution?.(traffic);
    if (document.visibilityState === 'visible') pollTimer = setTimeout(poll, POLL_MS);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); else clearTimeout(pollTimer); });

  let onAttribution = null;
  const api = {
    start() { drawStatic(); raf = requestAnimationFrame(frame); poll(); },
    setTasks(next) { tasks = next; },
    selectTask(id) { selectedTask = id; },
    setPaired(hex) { pairedHex = hex; },
    setExtras(fn) { extras = fn || (() => []); },
    cycleRange() {
      range = RANGES[(RANGES.indexOf(range) + 1) % RANGES.length];
      try { localStorage.setItem('ctd_range', String(range)); } catch {}
      for (const n of nodes.values()) n.off = null;
      drawStatic();
      return range;
    },
    onTraffic(fn) { listeners.add(fn); },
    onStatus(fn) { onAttribution = fn; },
    // current positions (live, extrapolated) or SIM, for pairing in stage 3
    aircraft(now = Date.now()) { return traffic.sim ? simAircraft(now) : traffic.aircraft.map((a) => extrapolate(a, now)); },
    get sim() { return traffic.sim; },
    get landingRunway() { return landingRunway; },
  };
  return api;
}
