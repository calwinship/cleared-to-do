// Where a task "flies" on the radar, as a pure function of its timer and the clock.
// Everything moves at approach speed in real nautical miles, so task blips keep pace with real traffic.
//
// - Waiting tasks circle racetrack holds at fixes around the edge of the scope.
// - The timed task leaves its hold at the moment that puts it on the runway exactly when its time runs out.
// - Still not done at the runway? It goes around: a circuit, then back down the final, again and again.
//
// Coordinates are nm from the airport reference point, x east, y north. Bearings are true degrees.
// Used by the radar (positions) and by the list (go-around count), so both always agree.

export const SPEED_KT = 180;
const NM_PER_MS = SPEED_KT / 3600000;
export const msToNm = (ms) => ms * NM_PER_MS;

// Go-around circuit: climb out 3 nm, turn, downwind, turn onto a 5 nm final.
const GA_UP = 3, GA_R = 1.5, GA_FIN = 5;
export const GA_NM = 2 * GA_UP + 2 * GA_FIN + 2 * Math.PI * GA_R;
export const GA_MS = GA_NM / NM_PER_MS; // one lap, about 8.5 minutes
/** How many times a task has gone around, given how long it has been overdue. */
export const goArounds = (overMs) => (overMs > 0 ? Math.floor(msToNm(overMs) / GA_NM) + 1 : 0);

export const FIX_COUNT = 8;
const FIX_OFFSETS = [25, -25, 70, -70, 115, -115, 160, -160]; // from the approach bearing; nearest the final first

const add = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const vec = (brg) => ({ x: Math.sin((brg * Math.PI) / 180), y: Math.cos((brg * Math.PI) / 180) });
const neg = (a) => ({ x: -a.x, y: -a.y });

// A path is lines and half-circle turns, walked by distance.
const line = (a, b) => ({ a, b, len: Math.hypot(b.x - a.x, b.y - a.y) });
function turn(from, dir, side, r) { // half circle from `from`, heading `dir`, turning towards `side`
  const c = add(from, side, r);
  return { c, r, a0: Math.atan2(from.y - c.y, from.x - c.x), sw: Math.sign(cross(dir, side)) * Math.PI, len: Math.PI * r, end: add(from, side, 2 * r) };
}
const path = (segs) => ({ segs, len: segs.reduce((s, g) => s + g.len, 0) });
const lines = (pts) => path(pts.slice(1).map((p, i) => line(pts[i], p)));

export function pointAt(p, s) {
  s = Math.max(0, Math.min(p.len, s));
  for (const g of p.segs) {
    if (s <= g.len || g === p.segs.at(-1)) {
      const k = g.len ? Math.min(1, s / g.len) : 0;
      if (g.b) return { x: g.a.x + (g.b.x - g.a.x) * k, y: g.a.y + (g.b.y - g.a.y) * k };
      const ang = g.a0 + g.sw * k;
      return { x: g.c.x + Math.cos(ang) * g.r, y: g.c.y + Math.sin(ang) * g.r };
    }
    s -= g.len;
  }
  return p.segs[0].a;
}
/** Points along a path, for drawing it. */
export function sample(p, step) {
  const out = [];
  for (let s = 0; s < p.len; s += step) out.push(pointAt(p, s));
  out.push(pointAt(p, p.len));
  return out;
}

/** Holds, approach and go-around circuit for a landing threshold {x, y, brg} and the radar range (nm). */
export function geometry(thr, range) {
  const T = { x: thr.x, y: thr.y };
  const u = neg(vec(thr.brg)); // out along the approach
  const w = { x: u.y, y: -u.x }; // the go-around side
  const appBrg = (thr.brg + 180) % 360;
  const rho = range * 0.74;
  const leg = Math.min(3, range * 0.12), r = Math.min(1, range * 0.045);
  const fixes = FIX_OFFSETS.map((off) => {
    const d = vec(appBrg + off);
    const F = { x: d.x * rho, y: d.y * rho };
    const n = neg(d); // inward
    const t = { x: d.y, y: -d.x }; // along the rim
    const A = add(F, t, -leg);
    const t1 = turn(F, t, n, r);
    const t2 = turn(add(A, n, 2 * r), neg(t), neg(n), r);
    return { F, hold: path([line(A, F), t1, line(t1.end, add(A, n, 2 * r)), t2]) };
  });
  const U = add(T, u, -GA_UP);
  const g1 = turn(U, neg(u), w, GA_R);
  const D = add(add(T, u, GA_FIN), w, 2 * GA_R);
  const g2 = turn(D, u, neg(w), GA_R);
  const ga = path([line(T, U), g1, line(g1.end, D), g2, line(g2.end, T)]);

  const di = Math.min(8, range * 0.45); // final approach length
  const approaches = fixes.map(({ F }) => {
    const rel = { x: F.x - T.x, y: F.y - T.y };
    const a = dot(rel, u), c = dot(rel, w);
    if (a >= di + 2) return lines([F, add(T, u, Math.max(di, Math.min(a * 0.6, a - 2))), T]);
    const side = c >= 0 ? 1 : -1; // round the side, then a base turn onto the final
    const P = add(add(T, u, Math.min(di + 3, range * 0.75)), w, side * Math.max(Math.abs(c) * 0.5, 3));
    return lines([F, P, add(T, u, di), T]);
  });
  return { T, u, w, range, fixes, approaches, ga };
}

const holdPos = (geo, i, now) => pointAt(geo.fixes[i].hold, (msToNm(now) + i * 1.7) % geo.fixes[i].hold.len);

/** A waiting task circling the hold at fix i. */
export const waitingPos = (geo, i, now) => holdPos(geo, i, now);

/**
 * The timed task from fix i. remainingMs < 0 means overdue (going around).
 * Paused: it circles where it is (or stays in its hold).
 */
export function activePos(geo, i, remainingMs, now, paused) {
  const app = geo.approaches[i];
  let p, phase;
  if (remainingMs >= 0) {
    const toGo = msToNm(remainingMs);
    if (toGo >= app.len) { phase = 'hold'; p = holdPos(geo, i, now); }
    else { phase = 'approach'; p = pointAt(app, app.len - toGo); }
  } else {
    phase = 'goaround';
    p = pointAt(geo.ga, msToNm(-remainingMs) % GA_NM);
  }
  if (paused && phase !== 'hold') {
    const rr = Math.min(0.8, geo.range * 0.04), ang = msToNm(now) / rr;
    p = { x: p.x + Math.cos(ang) * rr, y: p.y + Math.sin(ang) * rr };
  }
  // minutes until it leaves the hold, for the "expect approach" line
  const leaveInMs = phase === 'hold' ? remainingMs - app.len / NM_PER_MS : 0;
  return { p, phase, path: app, leaveInMs };
}
