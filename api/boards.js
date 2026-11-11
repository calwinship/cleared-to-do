import { latestBoard, updateFlights, archiveBoard, isId } from '../lib/db.js';

// GET  /api/boards?owner=<uuid>                 -> { board | null }   (active board for this device)
// PATCH /api/boards { owner, id, flights }      -> { flights }        (landed / promoted state)
// PATCH /api/boards { owner, id, archived:true } -> { ok }            (start a new board)
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const owner = req.query?.owner;
      if (!isId(owner)) return res.status(400).json({ error: 'Missing device ID.' });
      return res.status(200).json({ board: await latestBoard(owner) });
    }
    if (req.method === 'PATCH') {
      const { owner, id, flights, archived } = req.body || {};
      if (!isId(owner) || !isId(id)) return res.status(400).json({ error: 'Missing board or device ID.' });
      if (archived === true) {
        await archiveBoard(owner, id);
        return res.status(200).json({ ok: true });
      }
      const saved = await updateFlights(owner, id, flights);
      if (!saved) return res.status(404).json({ error: 'Board not found.' });
      return res.status(200).json({ flights: saved });
    }
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('boards failed', err);
    return res.status(err.status || 500).json({ error: 'Tower log unavailable.' });
  }
}
