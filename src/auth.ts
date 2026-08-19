import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { db } from "./db.js";

/**
 * Sign-in with a Solana wallet (Phantom).
 *
 * The server hands out a single-use nonce, the wallet signs a readable message
 * containing it, and the server verifies the ed25519 signature against the
 * claimed public key. No private key ever leaves the extension, and signing a
 * message is not a transaction — it moves no funds and costs no fee.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "cognira_session";

export interface User {
  id: string;
  wallet: string;
  createdAt: string;
  isDemo: boolean;
}

/** Rejects anything that is not a valid ed25519 point in base58. */
export function isValidWallet(wallet: unknown): wallet is string {
  if (typeof wallet !== "string" || wallet.length < 32 || wallet.length > 44) return false;
  try {
    return bs58.decode(wallet).length === 32;
  } catch {
    return false;
  }
}

/**
 * The exact text the wallet is asked to sign. It names the site and the nonce
 * so a signature captured on one site cannot be replayed on another, and it
 * says plainly that nothing is being authorised.
 */
export function challengeMessage(wallet: string, nonce: string, issuedAt: string): string {
  return [
    "Cognira wants you to sign in with your Solana wallet.",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
    "",
    "Signing this proves you own this wallet.",
    "It transfers nothing, costs no fee, and authorises no transaction.",
  ].join("\n");
}

export function createChallenge(wallet: string): { nonce: string; message: string } {
  const nonce = randomBytes(24).toString("base64url");
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

  db()
    .prepare(
      "INSERT INTO challenges (nonce, wallet, issued_at, expires_at, used) VALUES (?, ?, ?, ?, 0)",
    )
    .run(nonce, wallet, issuedAt, expiresAt);

  return { nonce, message: challengeMessage(wallet, nonce, issuedAt) };
}

export class AuthError extends Error {}

/**
 * Verifies a signed challenge and returns the user it belongs to, creating the
 * user on first sign-in. Throws AuthError with a message safe to show.
 */
export function verifyChallenge(input: {
  wallet: string;
  nonce: string;
  signature: string;
}): User {
  if (!isValidWallet(input.wallet)) throw new AuthError("That is not a valid Solana wallet address.");

  const row = db()
    .prepare("SELECT wallet, issued_at, expires_at, used FROM challenges WHERE nonce = ?")
    .get(input.nonce) as unknown as
    | { wallet: string; issued_at: string; expires_at: string; used: number }
    | undefined;

  if (!row) throw new AuthError("Sign-in request not found. Start again.");
  if (row.used) throw new AuthError("That sign-in request was already used. Start again.");
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new AuthError("Sign-in request expired. Start again.");
  }
  if (row.wallet !== input.wallet) throw new AuthError("Wallet does not match the sign-in request.");

  // issuedAt comes from the stored challenge, never from the client, so the
  // exact bytes the wallet signed are reconstructed here rather than supplied.
  const message = new TextEncoder().encode(
    challengeMessage(input.wallet, input.nonce, row.issued_at),
  );

  let ok = false;
  try {
    ok = ed25519.verify(bs58.decode(input.signature), message, bs58.decode(input.wallet));
  } catch {
    ok = false;
  }

  // Burn the nonce whether or not the signature checked out, so a bad
  // signature cannot be retried against the same challenge.
  db().prepare("UPDATE challenges SET used = 1 WHERE nonce = ?").run(input.nonce);

  if (!ok) throw new AuthError("Signature did not match that wallet.");

  return upsertUser(input.wallet);
}

export function upsertUser(wallet: string, isDemo = false): User {
  const handle = db();
  const existing = handle
    .prepare("SELECT id, wallet, created_at, is_demo FROM users WHERE wallet = ?")
    .get(wallet) as unknown as
    | { id: string; wallet: string; created_at: string; is_demo: number }
    | undefined;

  if (existing) {
    return {
      id: existing.id,
      wallet: existing.wallet,
      createdAt: existing.created_at,
      isDemo: existing.is_demo === 1,
    };
  }

  const user: User = {
    id: randomUUID(),
    wallet,
    createdAt: new Date().toISOString(),
    isDemo,
  };

  handle
    .prepare("INSERT INTO users (id, wallet, created_at, is_demo) VALUES (?, ?, ?, ?)")
    .run(user.id, user.wallet, user.createdAt, isDemo ? 1 : 0);

  return user;
}

// ------------------------------------------------------------------ sessions

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Issues a session and returns the raw token to set as a cookie. */
export function createSession(userId: string): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  db()
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .run(hashToken(token), userId, new Date().toISOString(), expiresAt.toISOString());

  return { token, expiresAt };
}

export function userForSession(token: string | undefined): User | null {
  if (!token) return null;

  const row = db()
    .prepare(
      `SELECT u.id, u.wallet, u.created_at, u.is_demo, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as unknown as
    | { id: string; wallet: string; created_at: string; is_demo: number; expires_at: string }
    | undefined;

  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }

  return {
    id: row.id,
    wallet: row.wallet,
    createdAt: row.created_at,
    isDemo: row.is_demo === 1,
  };
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  db().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

/** Clears expired sessions and challenges. Cheap enough to run on boot. */
export function pruneExpired(): void {
  const now = new Date().toISOString();
  db().prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  db().prepare("DELETE FROM challenges WHERE expires_at < ?").run(now);
}

/** Minimal cookie header parser — avoids a dependency for five lines of work. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }

  return undefined;
}

/** Constant-time compare, for anything secret that is checked by equality. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
