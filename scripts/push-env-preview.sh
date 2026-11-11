#!/usr/bin/env bash
# Set PREVIEW-only env vars for v2. Production variables are never touched.
# DATABASE_URL points previews at the isolated cleared_v2 database. Values go via stdin, never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID
DATABASE_URL="$(node -e 'const u=new URL(process.env.NEON_POSTGRES_CONNECTION_STRING);u.pathname="/cleared_v2";process.stdout.write(u.toString())')"
export DATABASE_URL
for name in DATABASE_URL OPENROUTER_API_API_KEY; do
  value="${!name:-}"
  if [ -z "$value" ]; then echo "skip $name (not set)"; continue; fi
  npx -y vercel@65.14.0 env rm "$name" preview -y >/dev/null 2>&1 || true
  printf %s "$value" | npx -y vercel@65.14.0 env add "$name" preview >/dev/null 2>&1 && echo "set $name (preview)" || echo "FAILED $name"
done
