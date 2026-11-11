import { synthesise } from '../lib/tts.js';
import { MAX_TRANSMISSION } from '../lib/atc.js';
import { getBoardRow, saveAudio, isId } from '../lib/db.js';

// POST { owner, id } -> audio/mpeg for that board's tower transmission.
// ElevenLabs is called at most once per board; the MP3 is cached in Postgres for replays and reloads.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { owner, id } = req.body || {};
  if (!isId(owner) || !isId(id)) return res.status(400).json({ error: 'Missing board or device ID.' });

  try {
    const row = await getBoardRow(owner, id);
    if (!row) return res.status(404).json({ error: 'Board not found.' });

    let audio;
    let cache = 'HIT';
    if (row.audio_b64) {
      audio = Buffer.from(row.audio_b64, 'base64');
    } else {
      cache = 'MISS';
      audio = await synthesise(row.transmission.slice(0, MAX_TRANSMISSION));
      await saveAudio(owner, id, audio);
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Voice-Cache', cache);
    return res.status(200).send(audio);
  } catch (err) {
    console.error('voice failed', err);
    return res.status(err.status || 500).json({ error: 'Tower radio failure.' });
  }
}
