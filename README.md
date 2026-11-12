# Cleared To Do

**Live: [cleared-to-do.vercel.app](https://cleared-to-do.vercel.app)**

Turn your to-do list into an airport arrivals sequence. You're the controller at Dublin Airport (EIDW): sequence, hold and clear each task to land, alongside real live traffic on the radar.

## Features

- Tasks fly in as radar blips: hold them, give them a timed approach, or send them around
- Live arrivals into Dublin shown in the sequence and selectable on the radar
- Focus timer on the top task, with Focus and Fun modes
- AI-assisted clearances via OpenRouter

## Stack

- Static frontend (`index.html`, `app.js`, `radar.js`) with no build step
- Vercel Functions in `api/` (boards, clearance, traffic, me)
- Neon Postgres for storage
- OpenRouter for the model calls
- Services provisioned with [Stripe Projects](https://docs.stripe.com/stripe-cli)

## Running locally

```sh
npm install
stripe projects env --pull --yes   # writes .env
OPENROUTER_FIXTURE=1 node --env-file=.env scripts/dev-server.mjs
```

Then open http://localhost:3100. `OPENROUTER_FIXTURE=1` uses canned model responses so you don't use up model quota.

## Deploying

- Preview: `scripts/deploy-preview.sh`
- Production: `scripts/deploy.sh`
