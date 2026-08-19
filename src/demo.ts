import { createHash } from "node:crypto";
import { db } from "./db.js";
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
  const configured = Number(process.env.DEMO_QUESTIONS_PER_HOUR);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5;
}

export function demoUser(): User {
  return upsertUser(DEMO_WALLET, true);
}

export function demoIsReady(): boolean {
  return documentCount(demoUser().id) > 0;
}

/**
 * Identifies a demo visitor without storing an IP address. The hash is salted
 * per deployment, so the stored value is not reversible into an address.
 */
export function demoClientKey(ip: string | undefined, userAgent: string | undefined): string {
  const salt = process.env.DEMO_SALT ?? "cognira-demo";
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

export function checkDemoQuota(client: string): DemoQuota {
  const limit = questionsPerHour();
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  // Opportunistic cleanup keeps the table from growing without a cron job.
  db().prepare("DELETE FROM demo_usage WHERE asked_at < ?").run(since);

  const rows = db()
    .prepare("SELECT asked_at FROM demo_usage WHERE client = ? AND asked_at >= ? ORDER BY asked_at ASC")
    .all(client, since) as unknown as { asked_at: string }[];

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

export function recordDemoQuestion(client: string): void {
  db()
    .prepare("INSERT INTO demo_usage (client, asked_at) VALUES (?, ?)")
    .run(client, new Date().toISOString());
}
