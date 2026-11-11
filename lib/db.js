// Neon Postgres persistence. Boards are keyed by an anonymous owner ID kept in the browser.
import { neon } from '@neondatabase/serverless';

let _sql;
export function sql() {
  if (!_sql) {
    const url = process.env.NEON_POSTGRES_CONNECTION_STRING;
    if (!url) throw Object.assign(new Error('Database not configured'), { status: 500 });
    _sql = neon(url);
  }
  return _sql;
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS boards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text NOT NULL,
    input text NOT NULL,
    flights jsonb NOT NULL,
    transmission text NOT NULL,
    model text,
    audio_b64 text,
    archived boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS boards_owner_recent ON boards (owner_id, created_at DESC)`,
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
    hasAudio: row.has_audio,
    createdAt: row.created_at,
  };

export async function insertBoard(ownerId, board) {
  const db = sql();
  // A new board replaces the active one on this device.
  await db`UPDATE boards SET archived = true, updated_at = now() WHERE owner_id = ${ownerId} AND archived = false`;
  const [row] = await db`
    INSERT INTO boards (owner_id, input, flights, transmission, model)
    VALUES (${ownerId}, ${board.input}, ${JSON.stringify(board.flights)}::jsonb, ${board.transmission}, ${board.model || null})
    RETURNING id, input, flights, transmission, model, false AS has_audio, created_at`;
  return toClient(row);
}

export async function latestBoard(ownerId) {
  const [row] = await sql()`
    SELECT id, input, flights, transmission, model, audio_b64 IS NOT NULL AS has_audio, created_at
    FROM boards WHERE owner_id = ${ownerId} AND archived = false
    ORDER BY created_at DESC LIMIT 1`;
  return toClient(row) || null;
}

export async function getBoardRow(ownerId, id) {
  const [row] = await sql()`SELECT id, flights, transmission, audio_b64 FROM boards WHERE id = ${id} AND owner_id = ${ownerId}`;
  return row || null;
}

// Only landing state and lane promotion may change after clearance; everything else is server-issued.
export async function updateFlights(ownerId, id, clientFlights) {
  const row = await getBoardRow(ownerId, id);
  if (!row) return null;
  const byId = new Map((Array.isArray(clientFlights) ? clientFlights : []).map((f) => [f?.id, f]));
  const flights = row.flights.map((f) => {
    const c = byId.get(f.id);
    if (!c) return f;
    const landed = c.landed === true;
    return {
      ...f,
      landed,
      landedAt: landed ? (typeof c.landedAt === 'string' ? c.landedAt.slice(0, 40) : new Date().toISOString()) : null,
      lane: c.lane === 'seq' || c.lane === 'hold' ? c.lane : f.lane,
      promoted: c.promoted === true,
    };
  });
  await sql()`UPDATE boards SET flights = ${JSON.stringify(flights)}::jsonb, updated_at = now() WHERE id = ${id} AND owner_id = ${ownerId}`;
  return flights;
}

export async function archiveBoard(ownerId, id) {
  await sql()`UPDATE boards SET archived = true, updated_at = now() WHERE id = ${id} AND owner_id = ${ownerId}`;
}

export async function saveAudio(ownerId, id, buf) {
  await sql()`UPDATE boards SET audio_b64 = ${buf.toString('base64')} WHERE id = ${id} AND owner_id = ${ownerId} AND audio_b64 IS NULL`;
}
