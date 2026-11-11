// "Race a real plane": pair the cleared task with an inbound aircraft and keep that pairing honest.
import { choosePair, etaMs, touchedDown, lostLowNearField } from './shared/arrivals.js';
import { destination, distNm, ARP } from './shared/eidw.js';

const SIM_GS = 150;
const REPAIR_AFTER_MISSING_MS = 60000;
const REPAIR_AFTER_TURNAWAY_MS = 30000;

// A synthetic arrival flying straight down the landing runway's final, touching down at landsAt.
export function simArrival(race, landing, now = Date.now()) {
  const nm = Math.max(0, ((Date.parse(race.etaAt) - now) / 3600000) * SIM_GS);
  const p = destination(landing, (landing.brg + 180) % 360, nm);
  return {
    hex: race.hex, callsign: race.callsign, ...p, sim: true, fixAt: now,
    alt: nm > 0 ? Math.round(nm * 318 + 300) : 0, ground: nm <= 0, gs: nm > 0 ? SIM_GS : 20, track: landing.brg, vs: nm > 0 ? -750 : 0,
  };
}

let simSeq = 0;
function pair(race, aircraft, landing, now, exclude) {
  const remaining = Math.max(Date.parse(race.endsAt) - now, 120000);
  const p = choosePair(aircraft, remaining, { landing, exclude, now });
  if (p) {
    return {
      ...race, hex: p.a.hex, callsign: (p.a.callsign || p.a.hex).toUpperCase(), sim: !!p.a.sim,
      etaAt: new Date(p.landsAt).toISOString(), final: p.final, pairedAt: new Date(now).toISOString(),
      legs: Math.max(race.leg, p.final ? race.leg : race.leg + Math.ceil((remaining - p.eta) / (15 * 60000))),
    };
  }
  // No arrivals: fly our own, clearly labelled SIM.
  const eta = Math.min(remaining, 20 * 60000);
  const final = eta >= remaining - 60000;
  simSeq = (simSeq + 1) % 900;
  return {
    ...race, hex: `simrace${Date.now()}`, callsign: `SIM${100 + simSeq}`, sim: true,
    etaAt: new Date(now + eta).toISOString(), final, pairedAt: new Date(now).toISOString(),
    legs: final ? race.leg : race.leg + Math.ceil((remaining - eta) / (20 * 60000)),
  };
}

export function startRace(task, aircraft, landing, now = Date.now()) {
  const race = {
    status: 'racing', startedAt: new Date(now).toISOString(), endsAt: new Date(now + task.minutes * 60000).toISOString(),
    leg: 1, legs: 1, goArounds: 0, used: [],
  };
  return pair(race, aircraft, landing, now, new Set());
}

// Advance one tick. Returns { race, event } where event is null | 'repaired' | 'next-leg' | 'aircraft-landed'.
export function tickRace(race, aircraft, landing, mem, now = Date.now()) {
  if (!race || race.status !== 'racing') return { race, event: null };
  const exclude = new Set([...(race.used || []), race.hex]);
  let a = race.sim && race.hex.startsWith('simrace') ? simArrival(race, landing, now) : aircraft.find((x) => x.hex === race.hex);

  if (a) {
    mem.lastSeen = now;
    mem.last = a;
    if (touchedDown(a)) return landed(race, aircraft, landing, now, exclude);
    // Turned away = climbing, or clearly opening the distance without descending. Downwind/base legs
    // point away from the field but keep descending, so they don't count.
    const d = distNm(a, ARP);
    mem.minDist = Math.min(mem.minDist ?? d, d);
    const vs = a.vs ?? 0;
    const away = vs > 400 || d > 60 || (d > mem.minDist + 6 && vs > -200);
    if (away) {
      mem.awaySince ??= now;
      if (now - mem.awaySince > REPAIR_AFTER_TURNAWAY_MS) return repair(race, aircraft, landing, now, exclude, mem);
    } else mem.awaySince = null;
    // keep the estimate live, smoothed so the countdown does not jump around
    if (!(race.sim && race.hex.startsWith('simrace'))) {
      const fresh = now + etaMs(a, landing);
      const prev = Date.parse(race.etaAt);
      race = { ...race, etaAt: new Date(prev + (fresh - prev) * 0.2).toISOString() };
    }
    return { race, event: null };
  }
  // not in the feed
  mem.lastSeen ??= now;
  if (lostLowNearField(mem.last) && now - mem.lastSeen > 20000) return landed(race, aircraft, landing, now, exclude);
  if (now - mem.lastSeen > REPAIR_AFTER_MISSING_MS) return repair(race, aircraft, landing, now, exclude, mem);
  return { race, event: null };
}

function repair(race, aircraft, landing, now, exclude, mem) {
  mem.lastSeen = null; mem.last = null; mem.awaySince = null; mem.minDist = null;
  return { race: pair({ ...race, used: [...exclude] }, aircraft, landing, now, exclude), event: 'repaired' };
}

function landed(race, aircraft, landing, now, exclude) {
  const used = [...exclude];
  if (!race.final && Date.parse(race.endsAt) - now > 120000) {
    return { race: pair({ ...race, used, leg: race.leg + 1 }, aircraft, landing, now, new Set(used)), event: 'next-leg' };
  }
  return { race: { ...race, used, status: 'aircraft-landed', landedAt: new Date(now).toISOString() }, event: 'aircraft-landed' };
}

// User chose "Go around": count it and pair with the next arrival.
export function goAround(race, aircraft, landing, now = Date.now()) {
  const used = new Set([...(race.used || []), race.hex]);
  const next = pair({ ...race, status: 'racing', goArounds: (race.goArounds || 0) + 1, used: [...used], leg: race.leg + 1, endsAt: new Date(Math.max(Date.parse(race.endsAt), now + 5 * 60000)).toISOString() }, aircraft, landing, now, used);
  return { ...next, final: true };
}

export const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
