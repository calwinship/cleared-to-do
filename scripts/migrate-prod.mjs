// Additive schema upgrade for the PRODUCTION database (neondb): new tables + nullable user_id.
// Nothing is dropped or rewritten, so the previous app version keeps working against it.
// Run: node --env-file=.env scripts/migrate-prod.mjs
delete process.env.DATABASE_URL;
const { sql, SCHEMA } = await import('../lib/db.js');
const [{ db }] = await sql()`SELECT current_database() AS db`;
if (db !== 'neondb') throw new Error(`expected production neondb, got ${db}`);
for (const stmt of SCHEMA) await sql().query(stmt);
const cols = await sql()`SELECT column_name FROM information_schema.columns WHERE table_name = 'boards' ORDER BY ordinal_position`;
const tables = await sql()`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`;
const [{ n }] = await sql()`SELECT count(*)::int AS n FROM boards`;
console.log(`${db}: tables ${tables.map((t) => t.table_name).join(', ')}; boards columns ${cols.map((c) => c.column_name).join(', ')}; ${n} boards kept`);
