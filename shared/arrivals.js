// Arrival inference, time-to-touchdown estimate and touchdown detection for EIDW.
// Pure functions over normalised aircraft {hex, callsign, lat, lon, alt (ft, 0 on ground), ground, gs, track, vs}.
// Used by the browser race logic and by the offline accuracy test against recorded traffic.
import { ARP, RUNWAYS, ELEVATION_FT, distNm, bearing, destination, angleDiff } from './eidw.js';

const THRESHOLDS = RUNWAYS.flatMap((r) => r.thresholds);
export const FINAL_FIX_NM = 8; // arrivals are assumed to join a straight-in final this far out
const FINAL_GS = 140; // typical groundspeed on final, kt

// The runway end an aircraft is most plausibly landing on: the landing runway if known, else best aligned.
export function likelyThreshold(a, landing) {
  if (landing) return landing;
  let best = THRESHOLDS[0], bestScore = Infinity;
  for (const t of THRESHOLDS) {
    const score = angleDiff(a.track ?? t.brg, t.brg) + distNm(a, t);
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}

// Inbound to Dublin: airborne, low/descending, heading for the field (or lined up on an approach).
export function isArrival(a, landing) {
  if (a.ground || a.alt == null || a.alt <= 0 || a.gs == null || a.track == null) return false;
  if (a.gs < 90 || a.gs > 480) return false; // helicopters, light GA circuits, cruisers
  const d = distNm(a, ARP);
  if (d > 60 || d < 0.8) return false;
  const vs = a.vs ?? 0;
  const t = likelyThreshold(a, landing);
  const towardsField = angleDiff(a.track, bearing(a, ARP)) < 50;
  const onFinal = distNm(a, t) < 14 && angleDiff(a.track, t.brg) < 20 && angleDiff(bearing(a, t), t.brg) < 25;
  // altitude band shrinks as aircraft get closer: ~3° profile with generous margins (pressure altitude)
  const maxAlt = Math.max(3000, d * 450 + 3000);
  if (a.alt > maxAlt || a.alt > 16000) return false;
  if (onFinal) return vs < 300;
  return towardsField && (vs < -250 || a.alt < 6000) && vs < 500;
}

// Estimated time to touchdown (ms): straight to an 8 nm final fix, then down the final at ~140 kt.
// Speed tapers from current groundspeed towards the final speed.
export function etaMs(a, landing) {
  const t = likelyThreshold(a, landing);
  const inbound = (t.brg + 180) % 360;
  const dThr = distNm(a, t);
  const aligned = angleDiff(a.track, t.brg) < 25 && angleDiff(bearing(a, t), t.brg) < 25;
  let pathNm;
  if (aligned && dThr <= FINAL_FIX_NM + 4) pathNm = dThr;
  else {
    const fix = destination(t, inbound, FINAL_FIX_NM);
    pathNm = distNm(a, fix) + FINAL_FIX_NM;
  }
  const v0 = Math.max(FINAL_GS, Math.min(a.gs, 320));
  const vAvg = (v0 + FINAL_GS) / 2;
  return (pathNm / vAvg) * 3600000 * ETA_FACTOR;
}
// Calibrated against recorded EIDW arrivals (see report): vectoring/speed control make real paths longer.
export let ETA_FACTOR = 1;
export const setEtaFactor = (f) => { ETA_FACTOR = f; };

// Touchdown rule: reported on the ground, or below 600 ft above the field and slow, within 2 nm of a
// runway threshold. Last-seen low and close also counts (coverage near the ground is patchy).
export function touchedDown(a) {
  if (!a) return false;
  const near = THRESHOLDS.some((t) => distNm(a, t) < 2) || distNm(a, ARP) < 1.5;
  if (!near) return false;
  if (a.ground) return true;
  return a.alt != null && a.alt <= ELEVATION_FT + 600 && (a.gs ?? 999) < 170 && (a.vs ?? 0) <= 200;
}

export function lostLowNearField(last) {
  return !!last && last.alt != null && last.alt < 1800 && distNm(last, ARP) < 5 && (last.vs ?? -1) <= 0;
}

// Pick the arrival whose ETA best matches remaining task time. If none is long enough, take the
// longest (a chained leg). Excludes aircraft already used.
export function choosePair(aircraft, remainingMs, { landing, exclude = new Set(), now = Date.now() } = {}) {
  const arrivals = aircraft
    .filter((a) => !exclude.has(a.hex) && isArrival(a, landing))
    .map((a) => ({ a, eta: etaMs(a, landing) }))
    .filter((x) => x.eta > 60000); // too close to be worth a leg
  if (!arrivals.length) return null;
  const longest = arrivals.reduce((m, x) => (x.eta > m.eta ? x : m));
  if (longest.eta < remainingMs - 60000) return { ...longest, final: false, landsAt: now + longest.eta };
  const best = arrivals.reduce((m, x) => (Math.abs(x.eta - remainingMs) < Math.abs(m.eta - remainingMs) ? x : m));
  return { ...best, final: true, landsAt: now + best.eta };
}
