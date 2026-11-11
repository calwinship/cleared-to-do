import { latestBoard, updateFlights, archiveBoard, createManualBoard, isId } from '../lib/db.js';
import { limited } from '../lib/ratelimit.js';

// GET  /api/boards?owner=<uuid>                 -> { board | null }   (active board for this device)
// POST /api/boards { owner, flights? }          -> { board }          (start a board by hand, no AI)
// PATCH /api/boards { owner, id, flights }      -> { flights }        (order, lanes, edits, adds, deletions)
// PATCH /api/boards { owner, id, archived:true } -> { ok }            (start a new board)
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const owner = req.query?.owner;
      if (!isId(owner)) return res.status(400).json({ error: 'Missing device ID.' });
      if (await limited(req, res, 'read', owner)) return;
      return res.status(200).json({ board: await latestBoard(owner) });
    }
    if (req.method === 'POST') {
      const { owner, flights } = req.body || {};
      if (!isId(owner)) return res.status(400).json({ error: 'Missing device ID.' });
      if (await limited(req, res, 'write', owner)) return;
      return res.status(200).json({ board: await createManualBoard(owner, flights) });
    }
    if (req.method === 'PATCH') {
      const { owner, id, flights, archived } = req.body || {};
      if (!isId(owner) || !isId(id)) return res.status(400).json({ error: 'Missing board or device ID.' });
      if (await limited(req, res, 'write', owner)) return;
      if (archived === true) {
        await archiveBoard(owner, id);
        return res.status(200).json({ ok: true });
      }
      const saved = await updateFlights(owner, id, flights);
      if (!saved) return res.status(404).json({ error: 'Board not found.' });
      return res.status(200).json({ flights: saved });
    }
    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('boards failed', err);
    return res.status(err.status || 500).json({ error: 'Tower log unavailable.' });
  }
}
