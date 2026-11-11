#!/usr/bin/env bash
# Push named variables from the Stripe Projects-managed .env to Vercel production.
# Values are piped via stdin and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID
for name in "$@"; do
  value="${!name:-}"
  if [ -z "$value" ]; then echo "skip $name (not set)"; continue; fi
  npx -y vercel@65.14.0 env rm "$name" production -y >/dev/null 2>&1 || true
  printf %s "$value" | npx -y vercel@65.14.0 env add "$name" production >/dev/null 2>&1 && echo "set $name" || echo "FAILED $name"
done
