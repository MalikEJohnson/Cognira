# Deploying Cognira

## Read this before choosing Vercel

Cognira is a **stateful, long-running server**. Two things about it decide
where it can be hosted:

1. **It keeps a database on disk.** Accounts, memberships, on-chain payment
   records and every ingested document live in a SQLite file under `data/`.
2. **Its requests are slow on purpose.** Extraction and answering are single
   Claude calls at high effort. A large document can take 30–120 seconds.

Vercel's serverless functions are the opposite of both: the filesystem is
ephemeral, and functions have a wall-clock ceiling. Deployed to Vercel as-is,
**every user account, pass and payment record would be wiped on the next
deploy** — and a slow extraction would be cut off mid-flight.

That is fixable, but it is a migration, not a setting (see below).

## Recommended: a container host

Railway, Render and Fly.io all run the `Dockerfile` in this repo unchanged,
with a persistent volume and no request timeout to design around.

The only thing that matters is that **`/app/data` is a mounted volume.**
Without it, the database is recreated empty on every deploy.

### Fly.io

    fly launch --no-deploy
    fly volumes create cognira_data --size 1
    fly secrets set ANTHROPIC_API_KEY=sk-ant-... TREASURY_WALLET=... TRUST_PROXY=1
    fly deploy

In `fly.toml`, mount the volume:

    [mounts]
      source = "cognira_data"
      destination = "/app/data"

### Railway / Render

Point the service at this repo, let it detect the `Dockerfile`, then:

- add a **persistent volume** mounted at `/app/data`
- set the environment variables below
- no build command is needed; the Dockerfile handles it

## Environment variables

Required:

    ANTHROPIC_API_KEY     from console.anthropic.com (credits must be added)

Set these in production:

    NODE_ENV=production   marks session cookies Secure
    TRUST_PROXY=1         so demo rate limiting sees the real visitor IP
    DEMO_SALT=<random>    makes the stored visitor hash unguessable

For payments:

    TREASURY_WALLET       the PUBLIC address that receives USDC
    SOLANA_RPC_URL        use a paid provider; the public endpoint will fail

Never put a private key or seed phrase in any of these. `TREASURY_WALLET` is a
receiving address and nothing more.

## After the first deploy

The demo corpus is not seeded automatically, because seeding costs money. Run
it once against the deployed instance:

    npm run seed:demo

On Fly that is `fly ssh console -C "npm run seed:demo"`; on Railway/Render use
their shell. Until it runs, the site loads and says the demo is empty.

## If it has to be Vercel

Three changes are needed, in this order:

1. **Replace SQLite with hosted Postgres** (Vercel Postgres, Neon, Supabase).
   Everything database-shaped is already isolated in `src/db.ts`, so this is a
   contained rewrite of that one file plus the query call sites — not a
   redesign. This is the non-negotiable one; without it the app loses all data
   on every deploy.
2. **Raise the function timeout.** Set `maxDuration` for the API routes to the
   highest your plan allows, and expect the longest extractions to still be at
   risk. Moving ingestion to a queue is the real fix.
3. **Serve Express through Vercel's Node runtime**, or split the routes into
   individual serverless functions.

The static front end would be very happy on Vercel. It is the server behind it
that does not fit the model.

## Before taking real money

- Use a paid Solana RPC. The public endpoint is rate limited and will fail
  under load, which means failed checkouts.
- Back up `data/cognira.db`. It holds payment records.
- Decide your refund position. On-chain payments have no chargebacks — that
  protects you and leaves buyers no recourse, so say what you will do.
