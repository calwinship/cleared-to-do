// ElevenLabs text-to-speech: one call per board.
const VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // "Daniel – Steady Broadcaster" (premade, free-tier usable)
const MODEL_ID = 'eleven_flash_v2_5';

export async function synthesise(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  const base = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';
  if (!key) {
    const e = new Error('ElevenLabs key missing');
    e.status = 500;
    throw e;
  }
  const r = await fetch(`${base}/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: { stability: 0.6, similarity_boost: 0.75, speed: 1.1 },
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    const e = new Error(`ElevenLabs HTTP ${r.status} ${detail.slice(0, 160)}`);
    e.status = 502;
    throw e;
  }
  return Buffer.from(await r.arrayBuffer());
}
