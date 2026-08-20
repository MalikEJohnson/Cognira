import { randomUUID } from "node:crypto";
import { one, run } from "./db.js";

/**
 * Access passes, not subscriptions.
 *
 * Solana has no native recurring billing — nothing can charge a wallet again
 * without the owner approving it. So each purchase grants a fixed window and
 * then simply lapses. The UI must say so plainly; calling it a "subscription"
 * would imply an auto-renewal that cannot happen.
 *
 * Buying while a pass is still live extends from its existing expiry rather
 * than from today, so nobody loses days by renewing early.
 */

export type PlanId = "month" | "quarter" | "year";

export interface Plan {
  id: PlanId;
  label: string;
  /** Whole US dollars. */
  priceUsd: number;
  /** USDC has 6 decimals, so this is priceUsd * 1_000_000. */
  amountBaseUnits: bigint;
  days: number;
}

export const PLANS: Record<PlanId, Plan> = {
  month: {
    id: "month",
    label: "1 month",
    priceUsd: 20,
    amountBaseUnits: 20_000_000n,
    days: 30,
  },
  quarter: {
    id: "quarter",
    label: "3 months",
    priceUsd: 60,
    amountBaseUnits: 60_000_000n,
    days: 90,
  },
  year: {
    id: "year",
    label: "1 year",
    priceUsd: 200,
    amountBaseUnits: 200_000_000n,
    days: 365,
  },
};

export function isPlanId(value: unknown): value is PlanId {
  return value === "month" || value === "quarter" || value === "year";
}

export interface Membership {
  id: string;
  plan: PlanId;
  startsAt: string;
  expiresAt: string;
}

export interface MembershipStatus {
  active: boolean;
  plan: PlanId | null;
  expiresAt: string | null;
  daysRemaining: number;
}

/** The pass with the furthest expiry, if it has not lapsed. */
export async function activeMembership(userId: string): Promise<Membership | null> {
  const row = await one<{
    id: string;
    plan: PlanId;
    starts_at: string;
    expires_at: string;
  }>(
    `SELECT id, plan, starts_at, expires_at
       FROM memberships
      WHERE user_id = ? AND expires_at > ?
      ORDER BY expires_at DESC
      LIMIT 1`,
    [userId, new Date().toISOString()],
  );

  if (!row) return null;

  return {
    id: row.id,
    plan: row.plan,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
  };
}

export async function membershipStatus(userId: string): Promise<MembershipStatus> {
  const membership = await activeMembership(userId);

  if (!membership) {
    return { active: false, plan: null, expiresAt: null, daysRemaining: 0 };
  }

  const msLeft = new Date(membership.expiresAt).getTime() - Date.now();

  return {
    active: true,
    plan: membership.plan,
    expiresAt: membership.expiresAt,
    daysRemaining: Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000))),
  };
}

export async function hasAccess(userId: string): Promise<boolean> {
  return (await activeMembership(userId)) !== null;
}

/**
 * Grants a pass. `signature` is the on-chain payment it came from and is
 * UNIQUE in the schema, so a replayed transaction cannot buy a second pass.
 */
export async function grantMembership(
  userId: string,
  plan: PlanId,
  signature: string | null,
): Promise<Membership> {
  const definition = PLANS[plan];
  const existing = await activeMembership(userId);

  // Renewing early stacks onto the remaining time instead of discarding it.
  const startsAt = existing ? new Date(existing.expiresAt) : new Date();
  const expiresAt = new Date(startsAt.getTime() + definition.days * 24 * 60 * 60 * 1000);

  const membership: Membership = {
    id: randomUUID(),
    plan,
    startsAt: startsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await run(
    "INSERT INTO memberships (id, user_id, plan, starts_at, expires_at, signature) VALUES (?, ?, ?, ?, ?, ?)",
    [membership.id, userId, plan, membership.startsAt, membership.expiresAt, signature],
  );

  return membership;
}
