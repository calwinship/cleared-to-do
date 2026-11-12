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
  `ALTER TABLE boards ADD COLUMN IF NOT EXISTS user_id uuid`, // for databases created before accounts were planned
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
const FLIGHT_ID = /^[A-Za-z0-9_-]{1,40}$/;
// Filler and time words never make a good label; the last remaining word usually names the thing.
const STOP = new Set(['THE', 'AND', 'FOR', 'WITH', 'FROM', 'ABOUT', 'INTO', 'BACK', 'SOME', 'MAYBE', 'CALL', 'BUY', 'GET', 'DO', 'TO', 'A', 'AN', 'MY', 'UP', 'OUT', 'OFF', 'BEFORE', 'AFTER', 'TODAY', 'TONIGHT', 'TOMORROW', 'SOMEDAY', 'LATER', 'POINT', 'WEEK', 'MONTH', 'NEXT', 'THIS', 'THAT', 'SOON', 'EVENTUALLY', 'PLEASE', 'AT', 'ON', 'IN', 'OF', 'BY']);

// A short radar label for a task: its most telling word ("Email Sam about rent" -> "SAM"... or "EMAIL").
export function shortLabel(task) {
  const words = String(task).toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const keep = words.filter((w) => !STOP.has(w) && w.length >= 3);
  return (keep.at(-1) || words[0] || 'TASK').slice(0, 10);
}

function cleanFlight(c, base = {}) {
  const task = (str(c.task, 80) ?? base.task ?? '').replace(/\s+/g, ' ').trim();
  if (!task) return null;
  const minutes = Number.isFinite(+c.minutes) && +c.minutes > 0 ? Math.min(600, Math.max(1, Math.round(+c.minutes))) : base.minutes ?? 15;
  const landed = c.landed === true;
  return {
    id: base.id || c.id,
    task,
    // radar label: one word, no flight number
    callsign: task === base.task && base.callsign ? String(base.callsign).split(' ')[0] : shortLabel(task),
    minutes,
    lane: c.lane === 'hold' ? 'hold' : c.lane === 'seq' ? 'seq' : base.lane || 'seq',
    note: str(c.note, 48) ?? base.note ?? '',
    landed,
    landedAt: landed ? str(c.landedAt, 40) || base.landedAt || new Date().toISOString() : null,
    timer: landed ? null : cleanTimer(c.timer),
  };
}

// Focus timer on a task: when it was (re)started, whether it is paused, time already run, and
// go-arounds banked before the time was extended (the current overrun's go-arounds are derived).
function cleanTimer(t) {
  if (!t || typeof t !== 'object' || !str(t.startedAt, 40)) return null;
  const acc = Number.isFinite(+t.accMs) ? Math.min(Math.max(0, +t.accMs), 36e6) : 0;
  const ga = Number.isInteger(+t.ga) ? Math.min(Math.max(0, +t.ga), 99) : 0;
  return { startedAt: str(t.startedAt, 40), pausedAt: str(t.pausedAt, 40), accMs: acc, ...(ga ? { ga } : {}) };
}

// The client owns its list: order, lanes, landed state, task text and time; it may add tasks (client ids)
// and delete them (deleted: true). Flights the client omits keep their place at the end, so a stale or
// partial client can never wipe a board.
export async function updateFlights(ownerId, id, clientFlights) {
  const current = await getFlights(ownerId, id);
  if (!current) return null;
  const list = Array.isArray(clientFlights) ? clientFlights.slice(0, 60) : [];
  const byId = new Map(current.map((f) => [f.id, f]));
  const seen = new Set();
  const next = [];
  for (const c of list) {
    if (!c || !FLIGHT_ID.test(c.id || '') || seen.has(c.id)) continue;
    seen.add(c.id);
    if (c.deleted === true) continue;
    const f = cleanFlight(c, byId.get(c.id) || { id: c.id });
    if (f) next.push(f);
  }
  for (const f of current) if (!seen.has(f.id)) next.push(f);
  const capped = next.slice(0, 60);
  await sql()`UPDATE boards SET flights = ${JSON.stringify(capped)}::jsonb, updated_at = now() WHERE id = ${id} AND owner_id = ${ownerId}`;
  return capped;
}

// A board started by hand (no AI): empty or with a few typed tasks.
export async function createManualBoard(ownerId, clientFlights) {
  const flights = (Array.isArray(clientFlights) ? clientFlights.slice(0, 60) : [])
    .filter((c) => c && FLIGHT_ID.test(c.id || ''))
    .map((c) => cleanFlight(c, { id: c.id }))
    .filter(Boolean);
  return insertBoard(ownerId, { input: '', flights, transmission: '', model: 'manual' });
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
