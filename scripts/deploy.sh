#!/usr/bin/env bash
# Deploy to Vercel production using the Stripe Projects-provisioned token (read from env, never argv).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID
npx -y vercel@65.14.0 deploy --prod -y
