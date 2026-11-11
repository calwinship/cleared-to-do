// Fixed-window rate limiting in Postgres, per device and per IP. No extra service needed.
import { sql, isId } from './db.js';

// name: { window seconds, max per device, max per IP }
export const LIMITS = {
  clearance: { window: 600, device: 6, ip: 20 }, // LLM calls: the expensive one
  write: { window: 60, device: 90, ip: 300 },
  read: { window: 60, device: 60, ip: 240 },
  traffic: { window: 60, device: 30, ip: 120 },
  erase: { window: 3600, device: 5, ip: 20 },
};

export function clientIp(req) {
  // Vercel overwrites x-real-ip / x-forwarded-for at its edge (verified: client-supplied values never reach
  // the function), so they are safe to key on there. Locally they fall back to the socket address.
  const xff = req.headers['x-forwarded-for'];
  const first = typeof xff === 'string' ? xff.split(',')[0].trim() : '';
  return (req.headers['x-real-ip'] || first || req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

// Returns null when allowed, or { retryAfter } when over the limit.
export async function rateLimit(req, name, owner) {
  const cfg = LIMITS[name];
  const keys = [`ip:${clientIp(req)}:${name}`];
  if (isId(owner)) keys.push(`dev:${owner}:${name}`);
  const rows = await sql()`
    INSERT INTO rate_limits (key, window_start, count)
    SELECT k, now(), 1 FROM unnest(${keys}::text[]) AS k
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${cfg.window}) THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${cfg.window}) THEN now() ELSE rate_limits.window_start END
    RETURNING key, count, extract(epoch FROM (window_start + make_interval(secs => ${cfg.window}) - now()))::int AS remaining`;
  if (Math.random() < 0.01) sql()`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`.catch(() => {});
  for (const r of rows) {
    const max = r.key.startsWith('ip:') ? cfg.ip : cfg.device;
    if (r.count > max) return { retryAfter: Math.max(1, r.remaining) };
  }
  return null;
}

// Convenience for handlers: sends the 429 and returns true when limited.
export async function limited(req, res, name, owner) {
  let hit;
  try {
    hit = await rateLimit(req, name, owner);
  } catch (err) {
    console.error('rate limit check failed', err); // fail open: a DB blip should not lock everyone out
    return false;
  }
  if (!hit) return false;
  res.setHeader('Retry-After', String(hit.retryAfter));
  res.status(429).json({ error: `Frequency busy: too many requests. Try again in ${hit.retryAfter}s.` });
  return true;
}
