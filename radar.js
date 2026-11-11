// Radar: a calm picture of your list. Your tasks are numbered blips: Sequence lined up on the approach,
// Holding parked in a hold. Real traffic around Dublin drifts by in the background (or labelled SIM
// when the feed is down). Tapping a task blip or label calls onSelectTask(id).
import { ARP, RUNWAYS, destination, bearing, distNm, angleDiff } from './shared/eidw.js';

const NS = 'http://www.w3.org/2000/svg';
const SIZE = 1000;
const C = SIZE / 2;
const R = SIZE / 2 - 4;
const RANGES = [10, 20, 40, 60];
const POLL_MS = 10000;
const KT_TO_NM_PER_MS = 1 / 3600000;
const MAX_SEQ = 9;
const MAX_HOLD = 8;
const FORCE_SIM = new URLSearchParams(location.search).has('sim'); // ?sim shows simulated traffic

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

export function createRadar(container, { onSelectTask, onStatus } = {}) {
  let range = 20;
  try { const r = +localStorage.getItem('ctd_range'); if (RANGES.includes(r)) range = r; } catch {}
  let scale = R / range;
  const cosLat = Math.cos((ARP.lat * Math.PI) / 180);
  const project = (p) => ({ x: C + (p.lon - ARP.lon) * 60 * cosLat * scale, y: C - (p.lat - ARP.lat) * 60 * scale });

  const svg = el('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'scope', role: 'group', 'aria-label': 'Radar: your tasks around Dublin Airport' }, container);
  const defs = el('defs', {}, svg);
  el('circle', { cx: C, cy: C, r: R }, el('clipPath', { id: 'scope-clip' }, defs));
  el('circle', { cx: C, cy: C, r: R, class: 'scope-bg' }, svg);
  const world = el('g', { 'clip-path': 'url(#scope-clip)' }, svg);
  const gStatic = el('g', {}, world);
  const gTraffic = el('g', { class: 'traffic', 'aria-hidden': 'true' }, world);
  const gTaskBg = el('g', { 'aria-hidden': 'true' }, world);
  const gTasks = el('g', { class: 'tasks' }, svg); // unclipped so labels near the rim stay readable
  const badge = el('text', { x: 30, y: 50, class: 'badge' }, svg);

  let traffic = { aircraft: [], sim: true, attribution: null };
  let tasks = { seq: [], hold: [] };
  let selected = null;
  let landing = RUNWAYS[1].thresholds[1]; // 28L until the traffic says otherwise
  const nodes = new Map();

  // ---------- static: rings, runways ----------
  function drawStatic() {
    gStatic.innerHTML = '';
    scale = R / range;
    const step = range / 4;
    for (let r = step; r <= range + 0.01; r += step) el('circle', { cx: C, cy: C, r: r * scale, class: 'ring' }, gStatic);
    el('text', { x: C + 8, y: C - R + 34, class: 'ring-label' }, gStatic).textContent = `${range} nm`;
    for (const rw of RUNWAYS) {
      const a = project(rw.ends[0]), b = project(rw.ends[1]);
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'runway', 'stroke-width': Math.max(6, (45 / 1852) * scale * 2.5) }, gStatic);
    }
    layoutTasks(); // the approach line and hold depend on the runway in use
  }

  // ---------- tasks: laid out in screen space so every label stays readable ----------
  // Sequence follows a "trombone": out along the final approach, a turn, then back down a downwind leg.
  // Labels try a few spots each and take the first that overlaps nothing already placed.
  const FONT = 40, CHAR_W = FONT * 0.62, BLIP_R = 26;
  const layout = { seq: [], hold: [], path: '', hold0: null };
  function layoutTasks() {
    const T = project(landing);
    const inbound = ((landing.brg + 180) % 360) * (Math.PI / 180);
    const u = { x: Math.sin(inbound), y: -Math.cos(inbound) }; // out along the approach
    const hb = inbound - Math.PI / 2; // the hold sits on this side...
    const w = { x: -Math.sin(hb), y: Math.cos(hb) }; // ...and the downwind leg on the other
    const dx = T.x - C, dy = T.y - C, rr = R * 0.86;
    const b = dx * u.x + dy * u.y;
    const Lf = -b + Math.sqrt(b * b - (dx * dx + dy * dy - rr * rr)); // threshold to near the rim
    const rt = R * 0.17; // turn radius
    const a0 = Math.min(90, Lf * 0.2); // first slot, clear of the runway
    const finalLen = Lf - a0, turnLen = Math.PI * rt, downLen = Lf * 0.85;
    const at = (d) => {
      if (d <= finalLen) return { x: T.x + u.x * (a0 + d), y: T.y + u.y * (a0 + d), out: { x: -w.x, y: -w.y } };
      d -= finalLen;
      const c = { x: T.x + u.x * Lf + w.x * rt, y: T.y + u.y * Lf + w.y * rt };
      if (d <= turnLen) {
        const th = d / rt; // sweep from -w to +w through +u
        const v = { x: -w.x * Math.cos(th) + u.x * Math.sin(th), y: -w.y * Math.cos(th) + u.y * Math.sin(th) };
        return { x: c.x + v.x * rt, y: c.y + v.y * rt, out: v };
      }
      d -= turnLen;
      const st = { x: T.x + u.x * Lf + w.x * 2 * rt, y: T.y + u.y * Lf + w.y * 2 * rt };
      return { x: st.x - u.x * d, y: st.y - u.y * d, out: w };
    };
    const total = finalLen + turnLen + downLen;
    const seq = tasks.seq;
    const gap = seq.length > 1 ? Math.max(100, Math.min(150, total / (seq.length - 1))) : 0;
    const fits = Math.min(seq.length, Math.floor(total / Math.max(gap, 1)) + 1, MAX_SEQ + 3);
    const pts = [];
    for (let d = 0; d <= total; d += 8) pts.push(at(d));
    layout.path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ');
    layout.T = T;
    const placed = [];
    const blips = [];
    layout.seq = seq.slice(0, fits).map((t, i) => {
      const p = at(i * gap);
      blips.push({ x: p.x - BLIP_R, y: p.y - BLIP_R, w: BLIP_R * 2, h: BLIP_R * 2 });
      return { t, p, num: String(i + 1) };
    });
    layout.seqMore = seq.length - fits;

    const H = { x: C + Math.sin(hb) * R * 0.52, y: C - Math.cos(hb) * R * 0.52 };
    const hr = R * 0.2;
    layout.hold0 = { ...H, r: hr };
    const hold = tasks.hold.slice(0, MAX_HOLD);
    layout.hold = hold.map((t, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(hold.length, 1);
      const v = { x: Math.cos(ang), y: Math.sin(ang) };
      const p = { x: H.x + v.x * hr, y: H.y + v.y * hr, out: v };
      blips.push({ x: p.x - BLIP_R, y: p.y - BLIP_R, w: BLIP_R * 2, h: BLIP_R * 2 });
      return { t, p, num: `H${i + 1}` };
    });
    layout.holdMore = tasks.hold.length - hold.length;

    // label placement: try outward, inward, then further out; keep inside the drawing
    const boxOf = (x, y, text, anchor) => {
      const wdt = text.length * CHAR_W;
      const left = anchor === 'middle' ? x - wdt / 2 : anchor === 'end' ? x - wdt : x;
      return { x: left - 4, y: y - FONT * 0.8, w: wdt + 8, h: FONT };
    };
    const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (const it of [...layout.seq, ...layout.hold]) {
      const o = it.p.out;
      const text = it.t.label;
      let best = null;
      for (const [k, dist] of [[1, 52], [-1, 52], [1, 98], [-1, 98], [1, 144], [-1, 144]]) {
        const lx = it.p.x + o.x * k * dist, ly = it.p.y + o.y * k * dist + FONT * 0.35;
        const anchor = Math.abs(o.x * k) < 0.45 ? 'middle' : o.x * k > 0 ? 'start' : 'end';
        const box = boxOf(lx, ly, text, anchor);
        const inside = box.x > -60 && box.x + box.w < SIZE + 60 && box.y > 0 && box.y + box.h < SIZE;
        const cand = { lx, ly, anchor, box };
        best ??= cand;
        if (inside && !placed.some((b) => hit(b, box)) && !blips.some((b) => hit(b, box))) { best = cand; break; }
      }
      placed.push(best.box);
      Object.assign(it, { lp: { x: best.lx, y: best.ly }, anchor: best.anchor });
    }
    drawTasks();
  }

  function drawTasks() {
    gTaskBg.innerHTML = '';
    gTasks.innerHTML = '';
    if (!layout.T) return;
    if (tasks.seq.length) el('path', { d: layout.path, class: 'centreline' }, gTaskBg);
    el('text', { x: layout.T.x, y: layout.T.y + 48, class: 'rwy-label', 'text-anchor': 'middle' }, gTaskBg).textContent = landing.id;
    if (tasks.hold.length) {
      el('circle', { cx: layout.hold0.x, cy: layout.hold0.y, r: layout.hold0.r, class: 'holdring' }, gTaskBg);
      el('text', { x: layout.hold0.x, y: layout.hold0.y + 10, class: 'hold-label', 'text-anchor': 'middle' }, gTaskBg).textContent = 'HOLD';
    }
    for (const [lane, list] of [['seq', layout.seq], ['hold', layout.hold]]) {
      for (const it of list) {
        const g = el('g', { class: `task ${lane}${it.t.id === selected ? ' selected' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${it.num}: ${it.t.task}. Show in list` }, gTasks);
        el('line', { x1: it.p.x, y1: it.p.y, x2: it.lp.x, y2: it.lp.y - FONT * 0.35, class: 'leader' }, g);
        el('circle', { cx: it.p.x, cy: it.p.y, r: BLIP_R + 10, class: 'sel-ring' }, g);
        el('circle', { cx: it.p.x, cy: it.p.y, r: BLIP_R, class: 'tblip' }, g);
        el('text', { x: it.p.x, y: it.p.y + 10, class: 'tnum', 'text-anchor': 'middle' }, g).textContent = it.num;
        el('text', { x: it.lp.x, y: it.lp.y, class: 'task-label', 'text-anchor': it.anchor }, g).textContent = it.t.label;
        el('circle', { cx: it.p.x, cy: it.p.y, r: BLIP_R + 18, class: 'hit' }, g);
        g.addEventListener('click', () => onSelectTask?.(it.t.id));
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectTask?.(it.t.id); } });
      }
    }
    if (layout.seqMore > 0) el('text', { x: layout.T.x, y: layout.T.y + 96, class: 'more', 'text-anchor': 'middle' }, gTasks).textContent = `+${layout.seqMore} more in list`;
    if (layout.holdMore > 0) el('text', { x: layout.hold0.x, y: layout.hold0.y + 50, class: 'more', 'text-anchor': 'middle' }, gTasks).textContent = `+${layout.holdMore}`;
  }

  // ---------- background traffic ----------
  const airborne = (a) => !a.ground && a.alt != null && a.alt > 0;
  const extrapolate = (a, now) => {
    if (!a.gs || a.track == null) return a;
    const nm = a.gs * (now - a.fixAt) * KT_TO_NM_PER_MS;
    return nm > 0.01 ? { ...a, ...destination(a, a.track, Math.min(nm, 3)) } : a;
  };

  function setTraffic(payload) {
    const live = (payload?.aircraft || []).filter(airborne);
    const fetchedAt = payload?.fetchedAt ? Date.parse(payload.fetchedAt) : Date.now();
    const sim = FORCE_SIM || !live.length || !!payload?.error;
    traffic = { sim, attribution: payload?.attribution || null, aircraft: sim ? [] : live.map((a) => ({ ...a, fixAt: fetchedAt - (a.seen || 0) * 1000 })) };
    if (!sim) chooseRunway(traffic.aircraft);
    badge.textContent = sim ? 'SIM TRAFFIC' : '';
    onStatus?.(traffic);
  }

  // Landing direction from low, aligned inbound traffic (needs two to switch).
  function chooseRunway(list) {
    const votes = new Map();
    for (const a of list) {
      if (a.alt > 5000 || a.track == null || (a.vs ?? 0) > 200 || (a.gs ?? 0) < 110) continue;
      for (const rw of RUNWAYS) for (const t of rw.thresholds) {
        if (distNm(a, t) > 15 || angleDiff(a.track, t.brg) > 25 || angleDiff(bearing(a, t), t.brg) > 20) continue;
        votes.set(t.id, (votes.get(t.id) || 0) + 1);
      }
    }
    const best = [...votes].sort((x, y) => y[1] - x[1])[0];
    if (!best || best[1] < 2) return;
    const t = RUNWAYS.flatMap((r) => r.thresholds).find((x) => x.id === best[0]);
    if (t && t.id !== landing.id) { landing = t; drawStatic(); }
  }

  function simAircraft(now) {
    const out = [];
    const inbound = (landing.brg + 180) % 360;
    for (let i = 0; i < 4; i++) {
      const nm = 28 * (1 - ((now / 1800000 + i / 4) % 1));
      out.push({ hex: `sim${i}`, callsign: `SIM${101 + i * 7}`, ...destination(landing, inbound, nm), alt: nm * 318 + 300, gs: 150, track: landing.brg, fixAt: now });
    }
    for (let i = 0; i < 2; i++) {
      const hdg = i ? 135 : 300;
      const p = destination(destination(ARP, (hdg + 180) % 360, 45), hdg, 90 * ((now / 720000 + i / 2) % 1));
      out.push({ hex: `simx${i}`, callsign: `SIM${300 + i * 11}`, ...p, alt: 36000, gs: 450, track: hdg, fixAt: now });
    }
    return out;
  }

  function drawTraffic(now) {
    const list = traffic.sim ? simAircraft(now) : traffic.aircraft.map((a) => extrapolate(a, now));
    const seen = new Set();
    for (const a of list) {
      seen.add(a.hex);
      let n = nodes.get(a.hex);
      if (!n) {
        const g = el('g', { class: `ac${traffic.sim ? ' sim' : ''}` }, gTraffic);
        n = { g, vec: el('line', { class: 'vec' }, g), blip: el('rect', { x: -5, y: -5, width: 10, height: 10, class: 'blip' }, g) }; // no labels: background traffic stays in the background
        nodes.set(a.hex, n);
      }
      const p = project(a);
      if (n.disp && n.fixAt !== a.fixAt) n.off = { x: n.disp.x - p.x, y: n.disp.y - p.y, t: now }; // ease to the new fix
      n.fixAt = a.fixAt;
      let ox = 0, oy = 0;
      if (n.off) { const k = Math.max(0, 1 - (now - n.off.t) / 1500); ox = n.off.x * k; oy = n.off.y * k; if (!k) n.off = null; }
      n.disp = { x: p.x + ox, y: p.y + oy };
      n.g.setAttribute('transform', `translate(${n.disp.x.toFixed(1)},${n.disp.y.toFixed(1)})`);
      const len = ((a.gs || 0) / 60) * scale, tr = ((a.track || 0) * Math.PI) / 180;
      n.vec.setAttribute('x2', (Math.sin(tr) * len).toFixed(1));
      n.vec.setAttribute('y2', (-Math.cos(tr) * len).toFixed(1));
      
    }
    for (const [hex, n] of nodes) if (!seen.has(hex)) { n.g.remove(); nodes.delete(hex); }
  }

  // ---------- loop + polling ----------
  let last = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function frame(ts) {
    requestAnimationFrame(frame);
    if (ts - last < (reduced.matches ? 2000 : 100)) return; // ~10 fps: smooth enough, easy on battery
    last = ts;
    drawTraffic(Date.now());
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
    if (document.visibilityState === 'visible') pollTimer = setTimeout(poll, POLL_MS);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); else clearTimeout(pollTimer); });

  return {
    start() { drawStatic(); requestAnimationFrame(frame); poll(); },
    setTasks(next) { tasks = next; layoutTasks(); },
    select(id) { selected = id; drawTasks(); },
    cycleRange() {
      range = RANGES[(RANGES.indexOf(range) + 1) % RANGES.length];
      try { localStorage.setItem('ctd_range', String(range)); } catch {}
      for (const n of nodes.values()) { n.off = null; n.disp = null; }
      drawStatic();
      return range;
    },
  };
}
