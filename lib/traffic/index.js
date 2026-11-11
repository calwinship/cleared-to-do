// Traffic around EIDW behind a swappable provider, with ONE shared upstream call per 10s across all
// function instances: the cache and a claim lock live in Postgres (traffic_cache).
import { sql } from '../db.js';
import { ARP } from '../../shared/eidw.js';
import { adsblol } from './adsblol.js';

const PROVIDERS = { adsblol };
export const provider = PROVIDERS[process.env.TRAFFIC_PROVIDER || 'adsblol'] || adsblol;
export const RANGE_NM = 60;
const MAX_AGE_S = 10;
const KEY = 'eidw';

export async function getTraffic() {
  const db = sql();
  const [row] = await db`
    SELECT payload, fetched_at, fetch_count, extract(epoch FROM now() - fetched_at) AS age FROM traffic_cache WHERE id = ${KEY}`;
  if (row && row.age < MAX_AGE_S) return { ...row.payload, cached: true, age: Math.round(row.age), upstreamCalls: row.fetch_count };

  // Claim the refresh: only the instance whose UPDATE succeeds calls upstream; others serve the stale copy.
  await db`INSERT INTO traffic_cache (id, fetched_at, claimed_at, payload) VALUES (${KEY}, 'epoch', 'epoch', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`;
  // The claim lasts 15s (longer than the upstream timeout) so a slow fetch is never doubled up.
  const claim = await db`
    UPDATE traffic_cache SET claimed_at = now() WHERE id = ${KEY} AND claimed_at < now() - interval '15 seconds' RETURNING id`;
  if (!claim.length) {
    return row?.payload?.aircraft ? { ...row.payload, cached: true, stale: true, age: Math.round(row.age), upstreamCalls: row.fetch_count } : emptyPayload('refresh in progress');
  }
  let payload;
  try {
    const aircraft = await provider.fetchNear(ARP.lat, ARP.lon, RANGE_NM);
    payload = { source: provider.name, attribution: provider.attribution, fetchedAt: new Date().toISOString(), aircraft };
  } catch (err) {
    console.warn(JSON.stringify({ evt: 'traffic_upstream_fail', provider: provider.name, err: err.message }));
    payload = { ...(row?.payload?.aircraft ? row.payload : emptyPayload()), error: 'feed unavailable' };
    // keep the old fetched_at so the next caller retries after the claim window
    await db`UPDATE traffic_cache SET fetch_count = fetch_count + 1 WHERE id = ${KEY}`;
    return { ...payload, cached: false };
  }
  const [saved] = await db`
    UPDATE traffic_cache SET payload = ${JSON.stringify(payload)}::jsonb, fetched_at = now(), fetch_count = fetch_count + 1
    WHERE id = ${KEY} RETURNING fetch_count`;
  return { ...payload, cached: false, age: 0, upstreamCalls: saved.fetch_count };
}

const emptyPayload = (error) => ({ source: provider.name, attribution: provider.attribution, fetchedAt: null, aircraft: [], ...(error ? { error } : {}) });
