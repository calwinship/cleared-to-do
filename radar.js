// Radar: your list as arrivals into Dublin Airport (EIDW). Task blips fly at approach speed, like the
// real traffic: waiting tasks circle holds around the edge, the timed task leaves its hold so it touches
// down when its time runs out, and goes around if it isn't done. Real traffic drifts by in Fun mode
// (labelled SIM when the feed is down). Tapping a task blip calls onSelectTask(id).
import { ARP, RUNWAYS, destination, bearing, distNm, angleDiff } from './shared/eidw.js';
import { geometry, activePos, waitingPos, sample, FIX_COUNT } from './shared/approach.js';
import { COAST } from './shared/coast.js';

const NS = 'http://www.w3.org/2000/svg';
const SIZE = 1000;
const C = SIZE / 2;
const R = SIZE / 2 - 4;
const RANGES = [10, 20, 40, 60];
const POLL_MS = 10000;
const KT_TO_NM_PER_MS = 1 / 3600000;
const FORCE_SIM = new URLSearchParams(location.search).has('sim'); // ?sim shows simulated traffic

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

export function createRadar(container, { onSelectTask, onStatus, onArrivals, onSelectAircraft, onRange, onRunway } = {}) {
  let range = 20;
  try { const r = +localStorage.getItem('ctd_range'); if (RANGES.includes(r)) range = r; } catch {}
  let scale = R / range;
  const cosLat = Math.cos((ARP.lat * Math.PI) / 180);
  const project = (p) => ({ x: C + (p.lon - ARP.lon) * 60 * cosLat * scale, y: C - (p.lat - ARP.lat) * 60 * scale });
  const toNm = (p) => ({ x: (p.lon - ARP.lon) * 60 * cosLat, y: (p.lat - ARP.lat) * 60 });
  const screen = (p) => ({ x: C + p.x * scale, y: C - p.y * scale }); // nm -> svg

  const svg = el('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'scope', role: 'group', 'aria-label': 'Radar: your tasks as arrivals into Dublin Airport' }, container);
  const defs = el('defs', {}, svg);
  el('circle', { cx: C, cy: C, r: R }, el('clipPath', { id: 'scope-clip' }, defs));
  el('circle', { cx: C, cy: C, r: R, class: 'scope-bg' }, svg);
  const world = el('g', { 'clip-path': 'url(#scope-clip)' }, svg);
  const gStatic = el('g', {}, world);
  const gGuides = el('g', { 'aria-hidden': 'true' }, world);
  const gTraffic = el('g', { class: 'traffic', 'aria-hidden': 'true' }, world); // keyboard users pick aircraft from the list instead
  const gTasks = el('g', { class: 'tasks' }, svg); // unclipped so labels near the rim stay readable
  const badge = el('text', { x: 30, y: 50, class: 'badge' }, svg);
  const notes = el('text', { x: 30, y: SIZE - 30, class: 'more' }, svg);
  el('text', { x: SIZE - 30, y: 50, class: 'apt-label', 'text-anchor': 'end' }, svg).textContent = 'EIDW · DUBLIN';

  let traffic = { aircraft: [], sim: true, attribution: null };
  let tasks = { seq: [], holdCount: 0 };
  let selected = null;
  let picked = null; // selected aircraft hex
  let mode = 'fun';
  let landing = RUNWAYS[1].thresholds[1]; // 28L until the traffic says otherwise
  let geo = null;
  let activeInfo = null; // phase of the timed task, for the app's status line
  const nodes = new Map();

  // ---------- static: coast, rings, runways ----------
  function drawStatic() {
    gStatic.innerHTML = '';
    scale = R / range;
    const coast = COAST.map((seg) => seg.map(([lat, lon], i) => { const p = project({ lat, lon }); return `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join('')).join(' ');
    el('path', { d: coast, class: 'coast' }, gStatic);
    const sea = project({ lat: 53.42 + range * 0.0065, lon: -6.06 + range * 0.0025 }); // offshore, between the holds
    el('text', { x: sea.x, y: sea.y, class: 'geo-label', 'text-anchor': 'middle' }, gStatic).textContent = 'IRISH SEA';
    const step = range / 4;
    for (let r = step; r <= range + 0.01; r += step) el('circle', { cx: C, cy: C, r: r * scale, class: 'ring' }, gStatic);
    el('text', { x: C + 8, y: C - R + 34, class: 'ring-label' }, gStatic).textContent = `${range} nm`;
    for (const rw of RUNWAYS) {
      const a = project(rw.ends[0]), b = project(rw.ends[1]);
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'runway', 'stroke-width': Math.max(6, (45 / 1852) * scale * 2.5) }, gStatic);
    }
    const T = project(landing);
    el('text', { x: T.x, y: T.y + 46, class: 'rwy-label', 'text-anchor': 'middle' }, gStatic).textContent = landing.id;
    geo = geometry({ ...toNm(landing), brg: landing.brg }, range);
    guideKey = '';
    for (const n of nodes.values()) n.disp = null; // re-placed, not eased, after a zoom or runway change
    drawTasks(Date.now());
  }

  // ---------- tasks: one persistent node per task, moved every frame ----------
  const FONT = 34, BLIP_R = 24;
  function taskNode(id) {
    let n = nodes.get(id);
    if (n) return n;
    const g = el('g', { tabindex: 0, role: 'button' }, gTasks);
    n = {
      g,
      ring: el('circle', { r: BLIP_R + 10, class: 'sel-ring' }, g),
      blip: el('circle', { r: BLIP_R, class: 'tblip' }, g),
      num: el('text', { class: 'tnum', 'text-anchor': 'middle' }, g),
      label: el('text', { class: 'task-label' }, g),
      hit: el('circle', { r: BLIP_R + 18, class: 'hit' }, g),
      disp: null, target: null, off: null, cls: '', aria: '',
    };
    g.addEventListener('click', () => onSelectTask?.(id));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectTask?.(id); } });
    nodes.set(id, n);
    return n;
  }

  let guideKey = '';
  function drawGuides(occupied, active) {
    const key = [range, landing.id, occupied.join(','), active ? `${active.fi}${active.phase}` : ''].join('|');
    if (key === guideKey) return;
    guideKey = key;
    gGuides.innerHTML = '';
    const d = (pts) => pts.map((q, i) => { const s = screen(q); return `${i ? 'L' : 'M'}${s.x.toFixed(0)},${s.y.toFixed(0)}`; }).join('');
    for (const i of occupied) el('path', { d: d(sample(geo.fixes[i].hold, 0.3)), class: 'holdtrack' }, gGuides);
    if (active?.phase === 'goaround') el('path', { d: d(sample(geo.ga, 0.3)), class: 'gatrack' }, gGuides);
    else if (active) el('path', { d: d(sample(active.path, 0.5)), class: 'centreline' }, gGuides);
  }

  // Each task keeps its hold until it lands, so finishing one doesn't reshuffle the rest.
  // New tasks take the free fix nearest the approach.
  const fixOf = new Map();
  let shown = [];
  function assignFixes() {
    shown = tasks.seq.slice(0, FIX_COUNT);
    const timed = tasks.seq.find((t) => t.timer);
    if (timed && !shown.includes(timed)) shown[FIX_COUNT - 1] = timed;
    const ids = new Set(shown.map((t) => t.id));
    for (const id of [...fixOf.keys()]) if (!ids.has(id)) fixOf.delete(id);
    const used = new Set(fixOf.values());
    for (const t of shown) {
      if (fixOf.has(t.id)) continue;
      let f = 0;
      while (used.has(f)) f++;
      fixOf.set(t.id, f);
      used.add(f);
    }
  }

  function drawTasks(now) {
    if (!geo) return;
    const items = [];
    const occupied = new Set();
    let active = null;
    shown.forEach((t) => {
      const fi = fixOf.get(t.id);
      if (t.timer) {
        const rem = t.timer.paused ? t.timer.remainingMs : t.timer.dueAt - now;
        const a = activePos(geo, fi, rem, now, t.timer.paused);
        active = { ...a, fi, id: t.id };
        if (a.phase === 'hold') occupied.add(fi);
        items.push({ t, p: a.p, phase: a.phase, fi });
      } else {
        occupied.add(fi);
        items.push({ t, p: waitingPos(geo, fi, now), phase: 'wait', fi });
      }
    });
    activeInfo = active && { phase: active.phase, leaveInMs: active.leaveInMs, runway: landing.id, id: active.id };
    drawGuides([...occupied], active);

    const seen = new Set();
    const easing = !reduced.matches;
    const awayW = { x: -geo.w.x, y: geo.w.y }; // screen direction away from the go-around side
    for (const it of items) {
      const n = taskNode(it.t.id);
      seen.add(it.t.id);
      const target = screen(it.p);
      // a jump (re-sequenced, timer started, time added) glides over instead of teleporting
      if (easing && n.disp && n.target && Math.hypot(target.x - n.target.x, target.y - n.target.y) > 12) n.off = { x: n.disp.x - target.x, y: n.disp.y - target.y, t: now };
      n.target = target;
      let ox = 0, oy = 0;
      if (n.off) { const k = Math.max(0, 1 - (now - n.off.t) / 1800); ox = n.off.x * k * k; oy = n.off.y * k * k; if (!k) n.off = null; }
      const p = n.disp = { x: target.x + ox, y: target.y + oy };

      // label: towards the middle of the scope while holding, away from the circuit when flying the approach
      let dir;
      if (it.phase === 'approach' || it.phase === 'goaround') dir = awayW;
      else dir = { x: p.x < C ? 1 : -1, y: 0 }; // level with the blip, on the inward side
      const lx = p.x + dir.x * 54, ly = p.y + dir.y * 54 + FONT * 0.35;
      const anchor = Math.abs(dir.x) < 0.45 ? 'middle' : dir.x > 0 ? 'start' : 'end';

      const timed = !!it.t.timer;
      const cls = `task ${timed ? 'timed' : 'seq'}${it.phase === 'goaround' ? ' ga' : ''}${it.t.id === selected ? ' selected' : ''}`;
      if (cls !== n.cls) { n.g.setAttribute('class', cls); n.cls = cls; }
      const aria = `${it.t.num}: ${it.t.task}. Show in list`;
      if (aria !== n.aria) { n.g.setAttribute('aria-label', aria); n.aria = aria; }
      for (const c of [n.ring, n.blip, n.hit]) { c.setAttribute('cx', p.x.toFixed(1)); c.setAttribute('cy', p.y.toFixed(1)); }
      n.num.setAttribute('x', p.x.toFixed(1));
      n.num.setAttribute('y', (p.y + 9).toFixed(1));
      if (n.num.textContent !== String(it.t.num)) n.num.textContent = it.t.num;
      const text = it.phase === 'goaround' ? `${it.t.label} GA` : it.t.label;
      if (n.label.textContent !== text) n.label.textContent = text;
      n.label.setAttribute('x', lx.toFixed(1));
      n.label.setAttribute('y', ly.toFixed(1));
      n.label.setAttribute('text-anchor', anchor);
      if (timed && gTasks.lastChild !== n.g) gTasks.appendChild(n.g); // the timed task draws on top
    }
    for (const [id, n] of nodes) if (!seen.has(id)) { n.g.remove(); nodes.delete(id); }

    const parts = [];
    const more = tasks.seq.length - shown.length;
    if (more > 0) parts.push(`+${more} MORE IN LIST`);
    if (tasks.holdCount) parts.push(`${tasks.holdCount} NOT TODAY`);
    const txt = parts.join(' · ');
    if (notes.textContent !== txt) notes.textContent = txt;
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
    badge.textContent = sim && mode === 'fun' ? 'SIM TRAFFIC' : '';
    onStatus?.(traffic);
    onArrivals?.(arrivals(Date.now()));
  }

  // Aircraft inbound to Dublin, soonest first, with a rough time to touchdown (for the list).
  // Rough on purpose: straight to an 8 nm final, speed tapering to ~140 kt.
  function arrivals(now) {
    const list = traffic.sim ? simAircraft(now) : traffic.aircraft.map((a) => extrapolate(a, now));
    const out = [];
    for (const a of list) {
      if (a.gs == null || a.track == null || a.gs < 110 || a.gs > 480) continue;
      // lined up on any runway end? (parallel runways and crosswind 16/34 are in use too)
      const fin = RUNWAYS.flatMap((r) => r.thresholds).find((t) => distNm(a, t) < 14 && angleDiff(a.track, t.brg) < 20 && angleDiff(bearing(a, t), t.brg) < 25);
      const thr = fin || landing;
      const dArp = distNm(a, ARP), dThr = distNm(a, thr), vs = a.vs ?? 0;
      if (dArp > 60 || a.alt > 16000 || a.alt > dArp * 450 + 3000 || a.alt + 600 < dThr * 200 || vs > 500) continue;
      const towards = angleDiff(a.track, bearing(a, ARP)) < 60;
      if (!fin && !(towards && (vs < -250 || a.alt < 6000))) continue;
      const path = fin ? dThr : distNm(a, destination(thr, (thr.brg + 180) % 360, 8)) + 8;
      const eta = (path / ((Math.min(a.gs, 320) + 140) / 2)) * 60;
      out.push({ hex: a.hex, callsign: a.callsign || a.hex, type: a.type || null, alt: Math.round(a.alt), dist: Math.round(dArp), eta: Math.round(eta), sim: !!traffic.sim });
    }
    return out.sort((x, y) => x.eta - y.eta).slice(0, 6);
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
    if (t && t.id !== landing.id) { landing = t; drawStatic(); onRunway?.(t.id); }
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

  const acNodes = new Map();
  function drawTraffic(now) {
    const list = traffic.sim ? simAircraft(now) : traffic.aircraft.map((a) => extrapolate(a, now));
    const seen = new Set();
    for (const a of list) {
      seen.add(a.hex);
      let n = acNodes.get(a.hex);
      if (!n) {
        const g = el('g', { class: `ac${traffic.sim ? ' sim' : ''}` }, gTraffic);
        n = { g, vec: el('line', { class: 'vec' }, g), blip: el('rect', { x: -5, y: -5, width: 10, height: 10, class: 'blip' }, g), label: null };
        el('rect', { x: -22, y: -22, width: 44, height: 44, class: 'hit' }, g);
        const hex = a.hex;
        g.addEventListener('click', () => onSelectAircraft?.(hex));
        acNodes.set(a.hex, n);
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
      // only the picked aircraft gets a label; the rest stay quiet in the background
      const isPicked = a.hex === picked;
      n.g.classList.toggle('picked', isPicked);
      if (isPicked) {
        n.label ??= el('text', { x: 16, y: -12, class: 'ac-label' }, n.g);
        n.label.textContent = `${a.callsign || a.hex} ${String(Math.round((a.alt || 0) / 100)).padStart(3, '0')}`;
      } else if (n.label) { n.label.remove(); n.label = null; }
    }
    for (const [hex, n] of acNodes) if (!seen.has(hex)) { n.g.remove(); acNodes.delete(hex); }
  }

  // ---------- loop + polling ----------
  let last = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function frame(ts) {
    requestAnimationFrame(frame);
    if (ts - last < (reduced.matches ? 2000 : 100)) return; // ~10 fps: smooth enough, easy on battery
    last = ts;
    const now = Date.now();
    if (mode === 'fun') drawTraffic(now);
    drawTasks(now);
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

  const resetEase = () => { for (const n of [...nodes.values(), ...acNodes.values()]) { n.off = null; n.disp = null; } };
  return {
    start() { drawStatic(); requestAnimationFrame(frame); poll(); },
    /** seq: [{ id, task, label, num, timer: { dueAt, paused, remainingMs } | null }], holdCount: number */
    setTasks(next) { tasks = next; assignFixes(); drawTasks(Date.now()); },
    select(id) { selected = id; drawTasks(Date.now()); },
    /** The timed task's phase: 'hold' | 'approach' | 'goaround', plus the runway in use. */
    active: () => activeInfo,
    runway: () => landing.id,
    setMode(m) {
      mode = m;
      gTraffic.style.display = m === 'fun' ? '' : 'none';
      badge.textContent = traffic.sim && m === 'fun' ? 'SIM TRAFFIC' : '';
      if (m === 'fun') drawTraffic(Date.now());
    },
    selectAircraft(hex) {
      picked = hex;
      // zoom out if the picked aircraft is off the scope
      const a = hex && (traffic.sim ? simAircraft(Date.now()) : traffic.aircraft).find((x) => x.hex === hex);
      if (a) {
        const need = RANGES.find((r) => r >= distNm(a, ARP) + 3) || RANGES.at(-1);
        if (need > range) {
          range = need;
          resetEase();
          drawStatic();
          onRange?.(range);
        }
      }
    },
    cycleRange() {
      range = RANGES[(RANGES.indexOf(range) + 1) % RANGES.length];
      try { localStorage.setItem('ctd_range', String(range)); } catch {}
      resetEase();
      drawStatic();
      return range;
    },
  };
}
