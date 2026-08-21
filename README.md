Cognira is an AI agent that learns how a person or company actually operates across their apps, files, messages, websites, and workflows.
Instead of simply searching your history, Cognira can reconstruct the reasoning and context behind past actions.
For example if you ask Cognira "why did we choose stripe instead of paypal" Cognira could examine your old emails, Slack conversations, documents, GitHub commits, meeting notes, and relevant files and respond:

Decision made March 14

You originally considered Stripe, PayPal, and Adyen.

Stripe was selected because:

PayPal's API didn't support the required workflow.
Adyen's integration required additional compliance work.
Your team already had Stripe experience.
The final deciding factor was Stripe's lower estimated integration time.

Confidence: 94%
The decision came from a March 14 engineering discussion and was confirmed in the March 15 project notes.
Cognira is considerably different from a normal RAG chatbot.


The killer feature: Decision Graph

Cognira continuously builds a graph connecting:

Person → conversation → decision → reason → document → action → outcome

So instead of merely remembering what happened, it remembers:

what happened → why it happened → who influenced it → what resulted from it.

You could then ask:

“What decisions have we made that we're probably going to regret?”

or:

“Show me every time we rejected this idea and why.”

or:

“What assumptions are our current strategy based on?”
Imagine an employee quits after five years.

Instead of losing their accumulated knowledge, the company retains their decision history and institutional memory.
Cognira eventually becomes something like a company's artificial institutional memory.


---

## Running it

Requires Node 20+ (developed on Node 24).

1. Install dependencies:

       npm install

2. Copy `.env.example` to `.env` and paste an Anthropic API key into it.
   Get one at https://console.anthropic.com/settings/keys

       ANTHROPIC_API_KEY=sk-ant-...

3. Start the server:

       npm run dev

4. Open http://localhost:3000

To try it immediately, paste the contents of `samples/workspace/notes/payments-kickoff.md`
into the Add Knowledge panel, then ask "Why did we choose Stripe?"

## How it works

    public/index.html   the UI
    src/server.ts       Express routes
    src/extract.ts      reads a document, pulls out structured decisions
    src/ask.ts          answers a question from everything stored
    src/store.ts        per-user documents and decisions
    src/db.ts           SQLite schema (data/cognira.db)
    src/auth.ts         Phantom wallet sign-in
    src/membership.ts   access passes and entitlement
    src/payments.ts     USDC payment building and on-chain verification
    src/demo.ts         the shared demo corpus and its rate limit
    src/sources/        folder, Slack/email export and GitHub readers

**Extraction** (`POST /api/knowledge`) sends the document to Claude with a
strict output schema, so every decision comes back as validated JSON:
the decision, the reasoning, the alternatives and why each lost, the people,
the date, the **assumptions**, the outcome, verbatim supporting quotes, and a
calibrated confidence score.

**Answering** (`POST /api/ask`) sends the whole corpus — extracted decisions
plus the original documents — and asks Claude to reconstruct what happened
rather than return matching documents. It is instructed to say when the
answer isn't there instead of guessing, and to surface conflicts between
sources.

Both use `claude-opus-5` with adaptive thinking.

## What is built, and what is not

Built:

- Decision extraction from pasted text, with assumptions and confidence
- Persistent decision memory
- "Why" question answering with inline citations and stated caveats
- Multi-turn conversation — follow-ups resolve against earlier turns, and the
  corpus is cached so each follow-up costs a fraction of the first question
- Ingestion from real sources — folders, Slack and Gmail exports, and live
  GitHub commits and pull request discussions. See below.
- Accounts, with every document and decision scoped to one owner
- Phantom wallet sign-in, and paid passes in USDC on Solana
- A shared read-only demo so people can try it before paying

Not built yet:

- **Live Gmail and Slack APIs.** Exports work today. Continuous sync needs
  OAuth apps registered with Google and Slack, which only the account owner
  can create.
- **The Decision Graph.** Decisions are stored as a flat list. The graph
  edges — decision to decision, assumption to outcome — are the next feature,
  and what makes "what are we going to regret" answerable properly.
- **Retrieval.** `ask.ts` sends the entire corpus in one request. That gives
  better cross-document reasoning than naive chunk retrieval at small scale,
  but it has a hard ceiling (~1.5M characters), and the code raises an
  explicit error at that point rather than silently dropping documents.

## Ingesting real sources

    npm run ingest -- --folder ./samples/workspace --dry-run

`--dry-run` lists exactly what would be read, with a token estimate, and makes
no model calls at all. Run it first on anything large.

Then for real:

    npm run ingest -- --folder ./samples/workspace
    npm run ingest -- --folder "C:/exports/slack-export" --limit 20
    npm run ingest -- --github MalikEJohnson/Cognira

`--folder` walks a directory tree and reads:

    .md .markdown .txt .csv .tsv .log .rst .adoc .org   plain text
    .json                                               Slack exports, detected by shape
    .eml                                                a single email
    .mbox                                               a whole mail archive, split per message
    .docx                                               Word documents
    .pdf                                                text-layer PDFs

This covers more of the vision than it sounds like: **both Slack and Gmail let
you export your history to disk**, so pointing `--folder` at an export directory
ingests real channels and real threads with no OAuth involved. Slack exports get
special handling — one channel-day becomes one conversation, user IDs resolve to
real names via `users.json`, `<@U123>` mentions are rewritten, and join/leave
noise is dropped.

`--github` reads commits and pull request discussions. Commits with no message
body are skipped, because "fix typo" holds no reasoning; PRs are assembled into
one document with their review comments attached, which is where the "why did we
do it this way" argument actually lives. Set `GITHUB_TOKEN` in `.env` for private
repos or to raise the rate limit.

Everything is deduplicated by SHA-256 of the content, so **re-running ingestion
over an unchanged folder costs nothing.** `node_modules`, `.git`, `dist` and
hidden directories are skipped. Files over 5 MB and documents over 400k
characters are reported as skips rather than silently truncated — a half-read
meeting note produces a confidently wrong decision record.

To check ingestion end to end, including cross-document reasoning:

    npm run selftest -- --with-ingest

That ingests `samples/workspace` into a throwaway store, then asks a question
whose answer requires connecting four separate files.

## The logo

Five marks live in `public/logo/`, all drawn on the same 64×64 grid with the
same accent colour:

    fork.svg    a decision node with the rejected paths kept, dotted
    rings.svg   concentric strata forming a C — accumulated memory
    root.svg    a decision above, its causes branching below
    trace.svg   a path running forward through time, then back
    graph.svg   the decision graph, arranged to read as a C

`fork.svg` is wired into the header and used as the favicon. To switch, change
the two `href`/`src` references to `/logo/fork.svg` in `public/index.html`.


## The demo

Anyone can try Cognira without a wallet. Questions are answered from one
shared, pre-seeded workspace, and the demo is strictly read-only so a visitor
cannot change what the next visitor sees.

Load it once:

    npm run seed:demo

Every demo question costs you real money, so it is rate limited per visitor —
`DEMO_QUESTIONS_PER_HOUR` in `.env`, default 5. The limit is enforced
server-side, not in the browser.

## Accounts and payment

Sign-in is a Phantom wallet signature. The server issues a single-use nonce,
the wallet signs a readable message containing it, and the server verifies the
ed25519 signature. **Signing costs nothing and authorises no transaction** —
the message says so, because people are right to be wary of signature prompts.

Passes are paid in USDC on Solana:

| Plan     | Price | Length   | Per month |
|----------|-------|----------|-----------|
| 1 month  | $20   | 30 days  | $20.00    |
| 3 months | $50   | 90 days  | $16.67    |
| 1 year   | $200  | 365 days | $16.44    |

These are **fixed-length passes, not subscriptions.** Solana cannot charge a
wallet again without the owner approving it, so nothing auto-renews. Buying
while a pass is live extends from its existing expiry, so nobody loses days by
renewing early.

To turn payments on, set `TREASURY_WALLET` in `.env` to the wallet that
should receive USDC. That is a **public address only** — never put a private
key or seed phrase in that file. Until it is set, payments are disabled and
the rest of the app still runs.

How a payment is checked:

1. The server builds an unsigned USDC transfer and returns it.
2. Phantom shows the amount and recipient; the user approves it themselves.
3. The server reads the transaction back off chain and confirms it succeeded,
   that the treasury's USDC balance actually went up by at least the price,
   and that the payer is the wallet that is signed in.
4. The signature is the primary key of the payments table, so the same
   transaction cannot be redeemed twice.

Nothing here trusts the browser beyond the signature string, and no key
material ever reaches the server.

## Before taking real traffic

- Use a paid Solana RPC (Helius, QuickNode, Triton). The public endpoint is
  rate limited and will fail under load.
- Set `NODE_ENV=production` so session cookies are marked Secure, and
  `TRUST_PROXY` if you are behind one, or demo rate limiting will see the
  proxy's IP for everyone.
- Put a real backup on `data/cognira.db`.
- Decide your refund position before the first sale. On-chain payments have no
  chargebacks, which cuts both ways.


## Contact form

The footer carries a contact form on every page. Messages are **stored in the
database rather than emailed**, so there is no mail provider to configure and
nothing fails silently in the background. Read the inbox with:

    npm run messages

It is rate limited to 3 messages an hour per visitor, validates the email
shape, and records the sender's wallet if they happen to be signed in.

## Site structure

Three tabs, plus a footer that appears on all of them:

    Product     the pitch and how the three stages fit together
    Workspace   the demo chat, pricing, add-knowledge, decision memory
    Demo        the real source code behind the claims, and the GitHub link

Pricing lives inside the Workspace tab rather than on a page of its own.
Anything money-shaped — the strip, the demo banner, the locked panel, a 402 or
a spent demo quota — routes to that strip.

**Outbound links live in one place.** `LINKS` at the bottom of
`public/index.html` holds the GitHub and Twitter URLs. The Twitter icon
renders visibly disabled until a URL is filled in, rather than pointing at a
dead page:

    const LINKS = {
        github: "https://github.com/MalikEJohnson/Cognira",
        twitter: ""      // paste the profile URL here
    };
