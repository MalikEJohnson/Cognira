# Deploying Cognira

## Vercel

The app now runs on Vercel. Two things made that possible:

- **The database moved off disk.** It is still SQLite, but served over HTTP by
  Turso instead of read from a local file. A serverless function has no
  writable disk and is thrown away after each request, so a `.db` file could
  never have survived there.
- **`vercel.json` raises the function timeout.** Extraction and answering are
  single Claude calls that can run 30-120 seconds.

Steps:

1. Create a free database at **https://turso.tech**, then press **Create
   Token** on it.
2. In the Vercel project, add these environment variables:

       ANTHROPIC_API_KEY
       TURSO_DATABASE_URL
       TURSO_AUTH_TOKEN
       NODE_ENV=production
       TRUST_PROXY=1
       DEMO_SALT=<any random string>

   Plus `TREASURY_WALLET` and `SOLANA_RPC_URL` when you want payments live.
3. Redeploy.
4. Seed the demo once, from your own machine, pointing at the same database:

       npm run seed:demo

   With `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in your local `.env`,
   this writes straight into the deployed database.

**One caveat.** On the Hobby plan, functions cap at 60 seconds regardless of
what `vercel.json` asks for. Most questions finish inside that; extracting a
very large document may not. Pro raises it to 300s. Container hosts have no
such limit at all — see below.

## The container option

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

## Before taking real money

- Use a paid Solana RPC. The public endpoint is rate limited and will fail
  under load, which means failed checkouts.
- Back up `data/cognira.db`. It holds payment records.
- Decide your refund position. On-chain payments have no chargebacks — that
  protects you and leaves buyers no recourse, so say what you will do.
