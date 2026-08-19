import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/**
 * SQLite, via the driver built into Node 24 — no native compile step, which
 * matters because this has to install cleanly on a fresh machine.
 *
 * Everything a person owns carries a user_id and every read filters on it.
 * That is the whole reason this replaced the JSON file: a single shared pile of
 * documents cannot be exposed to more than one person without leaking.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

let database: DatabaseSync | null = null;

function resolvePath(): string {
  return process.env.COGNIRA_DB ?? path.join(here, "..", "data", "cognira.db");
}

export function db(): DatabaseSync {
  if (database) return database;

  const file = resolvePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);

  return database;
}

/** Closes the handle. Tests use this before deleting a scratch database. */
export function closeDb(): void {
  database?.close();
  database = null;
}

function migrate(handle: DatabaseSync): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      wallet      TEXT UNIQUE NOT NULL,
      created_at  TEXT NOT NULL,
      is_demo     INTEGER NOT NULL DEFAULT 0
    );

    -- Short-lived nonces for wallet sign-in. A signature is only accepted once.
    CREATE TABLE IF NOT EXISTS challenges (
      nonce       TEXT PRIMARY KEY,
      wallet      TEXT NOT NULL,
      issued_at   TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0
    );

    -- Sessions store a hash of the cookie value, never the value itself.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    );

    -- One row per on-chain payment. The signature is the primary key, which is
    -- what stops the same transaction being replayed to buy a second membership.
    CREATE TABLE IF NOT EXISTS payments (
      signature         TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan              TEXT NOT NULL,
      amount_base_units INTEGER NOT NULL,
      payer_wallet      TEXT NOT NULL,
      verified_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan        TEXT NOT NULL,
      starts_at   TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      signature   TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS documents (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      source       TEXT NOT NULL,
      content      TEXT NOT NULL,
      added_at     TEXT NOT NULL,
      source_id    TEXT,
      external_id  TEXT,
      content_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      document_title  TEXT NOT NULL,
      document_source TEXT NOT NULL,
      decision        TEXT NOT NULL,
      reasoning       TEXT NOT NULL,
      alternatives    TEXT NOT NULL,
      people          TEXT NOT NULL,
      decided_on      TEXT NOT NULL,
      assumptions     TEXT NOT NULL,
      outcome         TEXT NOT NULL,
      evidence        TEXT NOT NULL,
      confidence      REAL NOT NULL,
      extracted_at    TEXT NOT NULL
    );

    -- Caps what an anonymous demo visitor can spend of the operator's budget.
    CREATE TABLE IF NOT EXISTS demo_usage (
      client  TEXT NOT NULL,
      asked_at TEXT NOT NULL
    );

    -- Messages from the contact form. Stored rather than emailed, so the form
    -- does something real without depending on a mail provider.
    CREATE TABLE IF NOT EXISTS contact_messages (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      message    TEXT NOT NULL,
      wallet     TEXT,
      client     TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
    CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(user_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_decisions_user ON decisions(user_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_demo_usage ON demo_usage(client, asked_at);
  `);
}

export interface ContactMessage {
  id: string;
  name: string;
  email: string;
  message: string;
  wallet: string | null;
  createdAt: string;
}

/** Rough shape check only — real deliverability is not this form's problem. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export class ContactError extends Error {}

/** Messages one client may send per hour, to keep the form from being a spam relay. */
const CONTACT_LIMIT_PER_HOUR = 3;

export function saveContactMessage(input: {
  name: string;
  email: string;
  message: string;
  wallet: string | null;
  client: string;
}): ContactMessage {
  const name = input.name.trim();
  const email = input.email.trim();
  const message = input.message.trim();

  if (name.length < 1) throw new ContactError("Please add your name.");
  if (!looksLikeEmail(email)) throw new ContactError("That email address does not look right.");
  if (message.length < 10) throw new ContactError("Please say a little more so we can actually help.");
  if (name.length > 120 || email.length > 200 || message.length > 5000) {
    throw new ContactError("That is longer than the form accepts.");
  }

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = db()
    .prepare("SELECT COUNT(*) AS n FROM contact_messages WHERE client = ? AND created_at >= ?")
    .get(input.client, since) as unknown as { n: number };

  if (recent.n >= CONTACT_LIMIT_PER_HOUR) {
    throw new ContactError("You have sent a few messages already. Try again in an hour.");
  }

  const row: ContactMessage = {
    id: randomUUID(),
    name,
    email,
    message,
    wallet: input.wallet,
    createdAt: new Date().toISOString(),
  };

  db()
    .prepare(
      `INSERT INTO contact_messages (id, name, email, message, wallet, client, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.name, row.email, row.message, row.wallet, input.client, row.createdAt);

  return row;
}

/** Everything the form has collected, newest first. Used by `npm run messages`. */
export function listContactMessages(): ContactMessage[] {
  const rows = db()
    .prepare("SELECT id, name, email, message, wallet, created_at FROM contact_messages ORDER BY created_at DESC")
    .all() as unknown as {
    id: string;
    name: string;
    email: string;
    message: string;
    wallet: string | null;
    created_at: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    message: r.message,
    wallet: r.wallet,
    createdAt: r.created_at,
  }));
}
