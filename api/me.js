import { deleteOwner, isId, sql } from '../lib/db.js';
import { limited, clientIp } from '../lib/ratelimit.js';

// DELETE /api/me { owner } -> { ok, boards }   "Delete my data": everything stored for this device.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const owner = req.body?.owner;
  if (!isId(owner)) return res.status(400).json({ error: 'Missing device ID.' });
  if (await limited(req, res, 'erase', owner)) return;
  try {
    const boards = await deleteOwner(owner);
    // Counters keyed by this request's IP go too (the erase counter itself is recreated by this request's limit check).
    await sql()`DELETE FROM rate_limits WHERE key LIKE ${'ip:' + clientIp(req) + ':%'} AND key NOT LIKE '%:erase'`;
    return res.status(200).json({ ok: true, boards });
  } catch (err) {
    console.error('erase failed', err);
    return res.status(500).json({ error: 'Could not delete right now. Please try again.' });
  }
}
