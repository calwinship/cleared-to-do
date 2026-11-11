// Neon Postgres persistence. Boards are keyed by an anonymous device ID kept in the browser.
// user_id is reserved for future accounts and is always NULL for now.
import { neon } from '@neondatabase/serverless';

let _sql;
export function sql() {
  if (!_sql) {
    // DATABASE_URL lets preview/dev point at an isolated database; production falls back to the Neon default.
    const url = process.env.DATABASE_URL || process.env.NEON_POSTGRES_CONNECTION_STRING;
    if (!url) throw Object.assign(new Error('Database not configured'), { status: 500 });
    _sql = neon(url);
  }
  return _sql;
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS boards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text NOT NULL,
    user_id uuid,
    input text NOT NULL,
    flights jsonb NOT NULL,
    transmission text NOT NULL,
    model text,
    archived boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS boards_owner_recent ON boards (owner_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS boards_user ON boards (user_id) WHERE user_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key text PRIMARY KEY,
    window_start timestamptz NOT NULL,
    count integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS traffic_cache (
    id text PRIMARY KEY,
    fetched_at timestamptz NOT NULL,
    claimed_at timestamptz NOT NULL,
    payload jsonb NOT NULL
  )`,
  `ALTER TABLE traffic_cache ADD COLUMN IF NOT EXISTS fetch_count integer NOT NULL DEFAULT 0`,
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (s) => typeof s === 'string' && UUID.test(s);

const toClient = (row) =>
  row && {
    id: row.id,
    input: row.input,
    flights: row.flights,
    transmission: row.transmission,
    model: row.model,
    createdAt: row.created_at,
  };

export async function insertBoard(ownerId, board) {
  const db = sql();
  // A new board replaces the active one on this device.
  await db`UPDATE boards SET archived = true, updated_at = now() WHERE owner_id = ${ownerId} AND archived = false`;
  const [row] = await db`
    INSERT INTO boards (owner_id, input, flights, transmission, model)
    VALUES (${ownerId}, ${board.input}, ${JSON.stringify(board.flights)}::jsonb, ${board.transmission}, ${board.model || null})
    RETURNING id, input, flights, transmission, model, created_at`;
  return toClient(row);
}

export async function latestBoard(ownerId) {
  const [row] = await sql()`
    SELECT id, input, flights, transmission, model, created_at
    FROM boards WHERE owner_id = ${ownerId} AND archived = false
    ORDER BY created_at DESC LIMIT 1`;
  return toClient(row) || null;
}

async function getFlights(ownerId, id) {
  const [row] = await sql()`SELECT flights FROM boards WHERE id = ${id} AND owner_id = ${ownerId}`;
  return row ? row.flights : null;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

// Task text, callsign and estimate are server-issued; the client may only change state, order and deletion.
// Order follows the client's list; flights the client omits keep their place at the end (never silently dropped).
export async function updateFlights(ownerId, id, clientFlights) {
  const current = await getFlights(ownerId, id);
  if (!current) return null;
  const list = Array.isArray(clientFlights) ? clientFlights.slice(0, 50) : [];
  const byId = new Map(current.map((f) => [f.id, f]));
  const seen = new Set();
  const next = [];
  for (const c of list) {
    const f = byId.get(c?.id);
    if (!f || seen.has(f.id)) continue;
    seen.add(f.id);
    if (c.deleted === true) continue;
    const landed = c.landed === true;
    next.push({
      ...f,
      landed,
      landedAt: landed ? str(c.landedAt, 40) || new Date().toISOString() : null,
      lane: c.lane === 'seq' || c.lane === 'hold' ? c.lane : f.lane,
      promoted: c.promoted === true,
      race: c.race && typeof c.race === 'object' ? sanitiseRace(c.race) : null,
    });
  }
  for (const f of current) if (!seen.has(f.id)) next.push(f);
  await sql()`UPDATE boards SET flights = ${JSON.stringify(next)}::jsonb, updated_at = now() WHERE id = ${id} AND owner_id = ${ownerId}`;
  return next;
}

// Race state (Stage 3) is small client bookkeeping; keep only known, bounded fields.
function sanitiseRace(r) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    startedAt: str(r.startedAt, 40),
    leg: num(r.leg),
    legs: num(r.legs),
    hex: str(r.hex, 12),
    callsign: str(r.callsign, 12),
    sim: r.sim === true,
    etaAt: str(r.etaAt, 40),
    goArounds: num(r.goArounds) ?? 0,
    status: str(r.status, 16),
  };
}

export async function archiveBoard(ownerId, id) {
  await sql()`UPDATE boards SET archived = true, updated_at = now() WHERE id = ${id} AND owner_id = ${ownerId}`;
}

// "Delete my data": every board and rate-limit counter tied to this device.
export async function deleteOwner(ownerId) {
  const rows = await sql()`DELETE FROM boards WHERE owner_id = ${ownerId} RETURNING id`;
  await sql()`DELETE FROM rate_limits WHERE key LIKE ${'dev:' + ownerId + ':%'}`;
  return rows.length;
}
