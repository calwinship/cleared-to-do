import { getTraffic } from '../lib/traffic/index.js';
import { limited } from '../lib/ratelimit.js';

// GET /api/traffic -> { source, attribution, fetchedAt, aircraft[], cached, age, error? }
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (await limited(req, res, 'traffic')) return;
  try {
    const data = await getTraffic();
    // A short CDN cache on top of the shared Postgres cache keeps function invocations down too.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5, stale-while-revalidate=5');
    return res.status(200).json(data);
  } catch (err) {
    console.error('traffic failed', err);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ source: null, aircraft: [], error: 'feed unavailable' });
  }
}
