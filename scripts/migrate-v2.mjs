// Create/upgrade the v2 schema in the ISOLATED cleared_v2 database (never production's neondb).
// Run: node --env-file=.env scripts/migrate-v2.mjs
const base = new URL(process.env.NEON_POSTGRES_CONNECTION_STRING);
base.pathname = '/cleared_v2';
process.env.DATABASE_URL = base.toString();
const { sql, SCHEMA } = await import('../lib/db.js');
const [{ db }] = await sql()`SELECT current_database() AS db`;
if (db !== 'cleared_v2') throw new Error(`refusing to migrate ${db}`);
for (const stmt of SCHEMA) await sql().query(stmt);
const tables = await sql()`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`;
console.log(`${db}: ${tables.map((t) => t.table_name).join(', ')}`);
