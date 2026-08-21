import { createHash } from "node:crypto";
import { all, run } from "./db.js";
import { upsertUser, type User } from "./auth.js";
import { documentCount } from "./store.js";

/**
 * The demo lets someone try Cognira before connecting a wallet or paying.
 *
 * It answers questions against one shared, pre-seeded corpus and is strictly
 * read-only — a visitor cannot add knowledge to it, so nobody can poison what
 * the next visitor sees. Every question costs the operator real money, so it is
 * rate limited per client and that limit is enforced server-side.
 */

/** Not a real wallet. The demo account is identified by a reserved string. */
export const DEMO_WALLET = "demo";

const WINDOW_MS = 60 * 60 * 1000;

function questionsPerHour(): number {
  // Number("") is 0, not NaN — so a variable declared in a hosting dashboard
  // but left blank silently set the limit to zero and locked everyone out of
  // the demo. Blank has to mean "unset", not "none allowed".
  const raw = process.env.DEMO_QUESTIONS_PER_HOUR?.trim();
  if (!raw) return 5;

  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5;
}

export async function demoUser(): Promise<User> {
  return upsertUser(DEMO_WALLET, true);
}

export async function demoIsReady(): Promise<boolean> {
  const user = await demoUser();
  return (await documentCount(user.id)) > 0;
}

/**
 * Identifies a demo visitor without storing an IP address. The hash is salted
 * per deployment, so the stored value is not reversible into an address.
 */
export function demoClientKey(ip: string | undefined, userAgent: string | undefined): string {
  const salt = process.env.DEMO_SALT?.trim() || "cognira-demo";
  return createHash("sha256")
    .update(`${salt}:${ip ?? "unknown"}:${userAgent ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

export interface DemoQuota {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterMinutes: number;
}

export async function checkDemoQuota(client: string): Promise<DemoQuota> {
  const limit = questionsPerHour();
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  // Opportunistic cleanup keeps the table from growing without a cron job.
  await run("DELETE FROM demo_usage WHERE asked_at < ?", [since]);

  const rows = await all<{ asked_at: string }>(
    "SELECT asked_at FROM demo_usage WHERE client = ? AND asked_at >= ? ORDER BY asked_at ASC",
    [client, since],
  );

  const used = rows.length;
  const oldest = rows[0]?.asked_at;

  const retryAfterMinutes = oldest
    ? Math.max(1, Math.ceil((new Date(oldest).getTime() + WINDOW_MS - Date.now()) / 60_000))
    : 0;

  return {
    allowed: used < limit,
    remaining: Math.max(0, limit - used),
    limit,
    retryAfterMinutes,
  };
}

export async function recordDemoQuestion(client: string): Promise<void> {
  await run("INSERT INTO demo_usage (client, asked_at) VALUES (?, ?)", [
    client,
    new Date().toISOString(),
  ]);
}
