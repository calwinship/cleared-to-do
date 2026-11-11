// adsb.lol community ADS-B feed. Data licence: ODbL 1.0 (https://www.adsb.lol/docs/open-data/api/).
export const adsblol = {
  name: 'adsb.lol',
  attribution: { text: 'Traffic data © adsb.lol contributors, ODbL 1.0', url: 'https://www.adsb.lol/docs/open-data/api/' },
  async fetchNear(lat, lon, nm) {
    const r = await fetch(`https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.min(250, Math.round(nm))}`, {
      signal: AbortSignal.timeout(12000), // adsb.lol sometimes takes 10s+ under load
      headers: { Accept: 'application/json', 'User-Agent': 'cleared-to-do (radar; low volume, 1 req/10s)' },
    });
    if (!r.ok) throw new Error(`adsb.lol HTTP ${r.status}`);
    const d = await r.json();
    return (d.ac || [])
      .filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon))
      .map((a) => ({
        hex: String(a.hex || '').slice(0, 12),
        callsign: String(a.flight || a.r || a.hex || '').trim().slice(0, 10),
        type: a.t ? String(a.t).slice(0, 6) : null,
        lat: a.lat,
        lon: a.lon,
        alt: a.alt_baro === 'ground' ? 0 : Number.isFinite(a.alt_baro) ? a.alt_baro : Number.isFinite(a.alt_geom) ? a.alt_geom : null,
        ground: a.alt_baro === 'ground',
        gs: Number.isFinite(a.gs) ? a.gs : null,
        track: Number.isFinite(a.track) ? a.track : Number.isFinite(a.true_heading) ? a.true_heading : null,
        vs: Number.isFinite(a.baro_rate) ? a.baro_rate : Number.isFinite(a.geom_rate) ? a.geom_rate : null,
        seen: Number.isFinite(a.seen_pos) ? a.seen_pos : Number.isFinite(a.seen) ? a.seen : 0,
      }));
  },
};
