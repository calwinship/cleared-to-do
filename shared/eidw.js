// Dublin Airport (EIDW) geometry. Source: Irish AIP, EIDW AD 2.2 / AD 2.12 (AirNav Ireland eAIP, AIRAC 2026-05-14).
// https://www.airnav.ie/AIRAC_MAY_2026/2026-05-14-AIRAC/html/eAIP/EI-AD-2.EIDW-en-IE.html
// Shared by the server (/api/traffic) and the browser radar.

const dms = (s) => {
  // "532520.75N" / "0061724.27W" -> decimal degrees
  const m = s.match(/^(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([NSEW])$/);
  const v = +m[1] + +m[2] / 60 + +m[3] / 3600;
  return m[4] === 'S' || m[4] === 'W' ? -v : v;
};
const pt = (lat, lon) => ({ lat: dms(lat), lon: dms(lon) });

export const ARP = pt('532517N', '0061612W'); // aerodrome reference point
export const ELEVATION_FT = 242;

// Each runway: pavement ends (west/north end first) and both landing thresholds with TRUE bearing.
export const RUNWAYS = [
  {
    name: '10L/28R', lengthM: 3109,
    ends: [pt('532614.62N', '0061705.32W'), pt('532605.39N', '0061417.60W')],
    thresholds: [
      { id: '10L', brg: 95.25, ...pt('532613.79N', '0061650.22W'), elevFt: 235 },
      { id: '28R', brg: 275.28, ...pt('532606.73N', '0061441.87W'), elevFt: 213 },
    ],
  },
  {
    name: '10R/28L', lengthM: 2637,
    ends: [pt('532520.75N', '0061724.27W'), pt('532512.94N', '0061502.08W')],
    thresholds: [
      { id: '10R', brg: 95.24, ...pt('532520.75N', '0061724.27W'), elevFt: 243 },
      { id: '28L', brg: 275.27, ...pt('532512.94N', '0061502.08W'), elevFt: 203 },
    ],
  },
  {
    name: '16/34', lengthM: 2072,
    ends: [pt('532613.16N', '0061543.12W'), pt('532511.66N', '0061458.54W')],
    thresholds: [
      { id: '16', brg: 156.59, ...pt('532613.16N', '0061543.12W'), elevFt: 218 },
      { id: '34', brg: 336.6, ...pt('532511.66N', '0061458.54W'), elevFt: 202 },
    ],
  },
];

// --- small geo helpers (nautical miles, true degrees) ---
const R_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
export function distNm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(h));
}
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
export function destination(p, brg, nm) {
  const d = nm / R_NM, t = rad(brg), la = rad(p.lat), lo = rad(p.lon);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(t));
  const lo2 = lo + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: deg(la2), lon: ((deg(lo2) + 540) % 360) - 180 };
}
export const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
