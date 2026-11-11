import { requestClearance, MAX_INPUT } from '../lib/atc.js';
import { insertBoard, isId } from '../lib/db.js';
import { limited } from '../lib/ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const owner = req.body?.owner;
  if (!isId(owner)) return res.status(400).json({ error: 'Unknown aircraft: missing device ID.' });
  if (!text) return res.status(400).json({ error: 'Say intentions: nothing to clear.' });
  if (text.length > MAX_INPUT) {
    return res.status(413).json({ error: `Too much traffic: keep it under ${MAX_INPUT} characters.` });
  }
  if (await limited(req, res, 'clearance', owner)) return;
  const key = process.env.OPENROUTER_API_API_KEY;
  if (!key) return res.status(500).json({ error: 'Tower offline: OpenRouter key missing.' });

  let board;
  try {
    board = await requestClearance(text, key);
  } catch (err) {
    console.error('clearance failed', err);
    return res.status(err.status || 500).json({ error: `Frequency congested, try again. (${err.message})` });
  }

  try {
    const saved = await insertBoard(owner, { ...board, input: text });
    return res.status(200).json({ board: saved, usage: board.usage });
  } catch (err) {
    console.error('save failed', err);
    return res.status(503).json({ error: 'Tower log unavailable: could not save the board. Try again.' });
  }
}
