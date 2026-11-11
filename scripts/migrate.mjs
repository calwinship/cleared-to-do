// Create the boards table in Neon. Run: node --env-file=.env scripts/migrate.mjs
import { sql, SCHEMA } from '../lib/db.js';

for (const stmt of SCHEMA) await sql().query(stmt);
const [{ n }] = await sql()`SELECT count(*)::int AS n FROM boards`;
console.log(`boards table ready (${n} rows)`);
