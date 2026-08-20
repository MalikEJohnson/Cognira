import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { describeApiError } from "./claude.js";
import { extractDecisions } from "./extract.js";
import {
  askCognira,
  formatAnswer,
  MAX_HISTORY_TURNS,
  type ChatTurn,
} from "./ask.js";
import { documentCount, listDecisions, saveDocumentWithDecisions } from "./store.js";
import { ContactError, saveContactMessage } from "./db.js";
import {
  AuthError,
  createChallenge,
  createSession,
  destroySession,
  isValidWallet,
  pruneExpired,
  readCookie,
  SESSION_COOKIE,
  userForSession,
  verifyChallenge,
  type User,
} from "./auth.js";
import { isPlanId, membershipStatus, PLANS, hasAccess } from "./membership.js";
import { buildPaymentTransaction, paymentConfig, PaymentError, verifyAndGrant } from "./payments.js";
import {
  checkDemoQuota,
  demoClientKey,
  demoIsReady,
  demoUser,
  recordDemoQuestion,
} from "./demo.js";

/**
 * Nothing here may throw at import time. On a serverless host an import-time
 * error becomes an opaque FUNCTION_INVOCATION_FAILED with no way to say what
 * was actually wrong, so configuration is checked per request instead and
 * reported as a readable message.
 */
function configError(): string | null {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    return "ANTHROPIC_API_KEY is not set. Add it in your host's environment variables and redeploy.";
  }
  if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL?.trim()) {
    return "TURSO_DATABASE_URL is not set. A serverless host has no writable disk, so the database must be remote. Create one at turso.tech and add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.";
  }
  return null;
}

/** Blocks a route that cannot work, with a message that says why. */
function blockedByConfig(res: Response): boolean {
  const problem = configError();
  if (!problem) return false;
  res.status(503).json({ error: problem });
  return true;
}

// Housekeeping, but never at the cost of the first request failing to import.
void pruneExpired().catch((err) => console.error("[prune]", err));

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const isProduction = process.env.NODE_ENV === "production";

// Behind a proxy (Fly, Render, nginx) req.ip is only correct with this set.
if (process.env.TRUST_PROXY) app.set("trust proxy", 1);

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(here, "..", "public")));

function sessionToken(req: Request): string | undefined {
  return readCookie(req.headers.cookie, SESSION_COOKIE);
}

function currentUser(req: Request): Promise<User | null> {
  return userForSession(sessionToken(req));
}

/** 401s when nobody is signed in. */
async function requireUser(req: Request, res: Response): Promise<User | null> {
  const user = await currentUser(req);
  if (!user) {
    res.status(401).json({ error: "Connect your wallet first." });
    return null;
  }
  return user;
}

/** 402s when signed in but without a live pass. */
async function requireAccess(req: Request, res: Response): Promise<User | null> {
  const user = await requireUser(req, res);
  if (!user) return null;

  if (!(await hasAccess(user.id))) {
    res.status(402).json({
      error: "This needs an active pass. Pick a plan to unlock your own workspace.",
      needsPlan: true,
    });
    return null;
  }

  return user;
}

/**
 * Reports what is and is not configured. Deliberately reveals no secret
 * values — only whether each one is present — so it is safe to leave public.
 */
app.get("/api/health", async (_req, res) => {
  const checks: Record<string, unknown> = {
    anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    tursoUrl: Boolean(process.env.TURSO_DATABASE_URL?.trim()),
    tursoToken: Boolean(process.env.TURSO_AUTH_TOKEN?.trim()),
    treasuryWallet: Boolean(process.env.TREASURY_WALLET?.trim()),
    serverless: Boolean(process.env.VERCEL),
    nodeVersion: process.version,
  };

  try {
    const demo = await demoUser();
    checks.database = "connected";
    checks.demoDocuments = await documentCount(demo.id);
  } catch (err) {
    checks.database = "FAILED: " + (err instanceof Error ? err.message : String(err));
  }

  const problem = configError();
  res.status(problem ? 503 : 200).json({ ok: !problem, problem, checks });
});

// ------------------------------------------------------------------ identity

app.get("/api/me", async (req, res) => {
  const user = await currentUser(req);
  const config = safely(() => paymentConfig());

  res.json({
    wallet: user?.wallet ?? null,
    membership: user ? await membershipStatus(user.id) : null,
    demo: {
      ready: await demoIsReady(),
      ...(await checkDemoQuota(demoClientKey(req.ip, req.get("user-agent")))),
    },
    payments: {
      enabled: config !== null,
      treasury: config?.treasury.toBase58() ?? null,
    },
  });
});

/** paymentConfig throws on a malformed address; the page should still load. */
function safely<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

app.post("/api/auth/challenge", async (req, res) => {
  const { wallet } = req.body ?? {};

  if (!isValidWallet(wallet)) {
    res.status(400).json({ error: "That is not a valid Solana wallet address." });
    return;
  }

  res.json(await createChallenge(wallet));
});

app.post("/api/auth/verify", async (req, res) => {
  const { wallet, nonce, signature } = req.body ?? {};

  if (typeof nonce !== "string" || typeof signature !== "string") {
    res.status(400).json({ error: "Missing signature." });
    return;
  }

  try {
    const user = await verifyChallenge({ wallet, nonce, signature });
    const session = await createSession(user.id);

    res.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      expires: session.expiresAt,
      path: "/",
    });

    res.json({ wallet: user.wallet, membership: await membershipStatus(user.id) });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("[/api/auth/verify]", err);
    res.status(500).json({ error: "Could not complete sign-in." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  await destroySession(sessionToken(req));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ payments

app.get("/api/plans", (_req, res) => {
  const config = safely(() => paymentConfig());

  res.json({
    currency: "USDC",
    network: "Solana",
    // Said plainly because the wording matters: nothing here auto-renews.
    renews: false,
    enabled: config !== null,
    treasury: config?.treasury.toBase58() ?? null,
    plans: Object.values(PLANS).map((plan) => ({
      id: plan.id,
      label: plan.label,
      priceUsd: plan.priceUsd,
      days: plan.days,
    })),
  });
});

app.post("/api/checkout", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const { plan } = req.body ?? {};
  if (!isPlanId(plan)) {
    res.status(400).json({ error: "Unknown plan." });
    return;
  }

  try {
    res.json(await buildPaymentTransaction(user.wallet, plan));
  } catch (err) {
    if (err instanceof PaymentError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("[/api/checkout]", err);
    res.status(502).json({ error: "Could not reach Solana to prepare the payment." });
  }
});

app.post("/api/payments/verify", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const { signature, plan } = req.body ?? {};
  if (!isPlanId(plan) || typeof signature !== "string") {
    res.status(400).json({ error: "Missing plan or transaction signature." });
    return;
  }

  try {
    const granted = await verifyAndGrant({
      signature,
      userId: user.id,
      wallet: user.wallet,
      plan,
    });
    res.json({
      ok: true,
      expiresAt: granted.expiresAt,
      membership: await membershipStatus(user.id),
    });
  } catch (err) {
    if (err instanceof PaymentError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("[/api/payments/verify]", err);
    res.status(502).json({ error: "Could not verify that payment on chain. Try again shortly." });
  }
});

// ----------------------------------------------------------------- knowledge

app.get("/api/decisions", async (req, res) => {
  try {
    const user = await currentUser(req);
    const member = user !== null && (await hasAccess(user.id));

    // Signed out, the page shows the demo corpus so there is something to look at.
    const owner = member ? user!.id : (await demoUser()).id;
    res.json({
      decisions: await listDecisions(owner),
      demo: !member,
    });
  } catch (err) {
    console.error("[/api/decisions]", err);
    res.status(500).json({ error: describeApiError(err) });
  }
});

app.post("/api/knowledge", async (req, res) => {
  if (blockedByConfig(res)) return;

  const user = await requireAccess(req, res);
  if (!user) return;

  const { title, source, content } = req.body ?? {};

  if (typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "A title is required." });
    return;
  }
  if (typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "Some content is required." });
    return;
  }

  const cleanSource = typeof source === "string" ? source.trim() : "";

  try {
    const extracted = await extractDecisions({
      title: title.trim(),
      source: cleanSource,
      content,
    });

    const { decisions } = await saveDocumentWithDecisions(
      user.id,
      { title: title.trim(), source: cleanSource, content },
      extracted,
    );

    res.json({ success: true, decisionsFound: decisions.length });
  } catch (err) {
    console.error("[/api/knowledge]", err);
    res.status(500).json({ error: describeApiError(err) });
  }
});

/** Keeps only well-formed turns — the history comes from the browser. */
function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(
      (turn): turn is ChatTurn =>
        typeof turn === "object" &&
        turn !== null &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string" &&
        turn.content.trim().length > 0,
    )
    .slice(-MAX_HISTORY_TURNS);
}

app.post("/api/ask", async (req, res) => {
  const { question, history } = req.body ?? {};

  if (typeof question !== "string" || !question.trim()) {
    res.status(400).json({ error: "Ask a question first." });
    return;
  }

  if (blockedByConfig(res)) return;

  const user = await currentUser(req);
  const member = user !== null && (await hasAccess(user.id));

  // Anyone without a pass is answered from the shared demo corpus, and every
  // one of those questions costs the operator money, so it is capped here.
  let client: string | null = null;
  if (!member) {
    if (!(await demoIsReady())) {
      res.status(503).json({
        error: "The demo has not been set up yet. Run `npm run seed:demo` to load it.",
      });
      return;
    }

    client = demoClientKey(req.ip, req.get("user-agent"));
    const quota = await checkDemoQuota(client);

    if (!quota.allowed) {
      res.status(429).json({
        error: `Demo limit reached — ${quota.limit} questions an hour. Try again in ${quota.retryAfterMinutes} minute(s), or get a pass for your own workspace.`,
        needsPlan: true,
      });
      return;
    }
  }

  try {
    const owner = member ? user!.id : (await demoUser()).id;
    const result = await askCognira(owner, question.trim(), parseHistory(history));

    if (client) await recordDemoQuestion(client);

    res.json({
      answer: formatAnswer(result),
      raw: result.answer,
      found: result.found,
      confidence: result.confidence,
      // What the run actually touched, so the UI can report it rather than
      // animate a progress bar that means nothing.
      documentsRead: await documentCount(owner),
      sourcesCited: result.sources.length,
      demo: !member,
      demoRemaining: client ? (await checkDemoQuota(client)).remaining : null,
    });
  } catch (err) {
    console.error("[/api/ask]", err);
    res.status(500).json({ error: describeApiError(err) });
  }
});

// ------------------------------------------------------------------- contact

app.post("/api/contact", async (req, res) => {
  const { name, email, message } = req.body ?? {};

  if (typeof name !== "string" || typeof email !== "string" || typeof message !== "string") {
    res.status(400).json({ error: "Please fill in every field." });
    return;
  }

  try {
    const user = await currentUser(req);

    await saveContactMessage({
      name,
      email,
      message,
      wallet: user?.wallet ?? null,
      client: demoClientKey(req.ip, req.get("user-agent")),
    });

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ContactError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("[/api/contact]", err);
    res.status(500).json({ error: "Could not send that message. Try again shortly." });
  }
});

export default app;

/**
 * Only bind a port when this is run as a process. On Vercel the app is
 * imported by api/index.ts and invoked per request, where calling listen()
 * would be meaningless — so local dev and serverless share one file.
 */
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? 3000);

  app.listen(port, async () => {
    console.log(`Cognira running at http://localhost:${port}`);

    if (!safely(() => paymentConfig())) {
      console.log("Payments disabled — set TREASURY_WALLET in .env to enable them.");
    }

    if (!(await demoIsReady())) {
      console.log("Demo corpus empty — run: npm run seed:demo");
    }
  });
}
