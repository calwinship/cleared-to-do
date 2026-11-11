#!/usr/bin/env bash
# Deploy a Vercel PREVIEW (never production). Prints the preview URL on the last line.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID
npx -y vercel@65.14.0 deploy -y --target=preview
