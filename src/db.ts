import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Client, InValue } from "@libsql/client";

/**
 * The database, over libSQL.
 *
 * This is still SQLite — same dialect, same schema — but reached over HTTP
 * instead of from a file on disk. That is what makes the app deployable to a
 * serverless host: a Vercel function has no writable disk and is thrown away
 * after each request, so a local .db file could never survive.
 *
 * With no TURSO_DATABASE_URL set it falls back to a local file, so `npm run
 * dev` still works offline with no configuration.
 *
 * Everything a person owns carries a user_id and every read filters on it.
 */

let client: Client | null = null;
let ready: Promise<Client> | null = null;

/**
 * Two entry points, chosen at runtime.
 *
 * "@libsql/client" loads a native .node binary to support local files. Those
 * binaries frequently fail to get traced into a serverless bundle, which
 * shows up as a function that crashes the moment it is invoked.
 *
 * "@libsql/client/web" is pure HTTP with no native code, which is all a remote
 * Turso database ever needs — so serverless never touches the native path,
 * and local development keeps working against a file.
 */
async function connect(): Promise<Client> {
  const url = process.env.TURSO_DATABASE_URL?.trim();

  if (!url) {
    // Local development: a plain file, no account or network needed.
    const local = process.env.COGNIRA_DB ?? "file:./data/cognira.db";

    // libSQL will not create the directory for us, and a fresh clone has no
    // data/ folder because it is gitignored.
    if (local.startsWith("file:")) {
      try {
        mkdirSync(
          path.dirname(fileURLToPath(new URL(local, pathToFileURL(`${process.cwd()}/`)))),
          { recursive: true },
        );
      } catch {
        // A read-only filesystem means this is a serverless host with no
        // TURSO_DATABASE_URL configured. Let the connection fail with its own
        // message rather than dying here on a mkdir.
      }
    }

    const { createClient } = await import("@libsql/client");
    return createClient({ url: local });
  }

  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

  if (!authToken && !url.startsWith("file:")) {
    throw new Error(
      "TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is missing. Create a token in the Turso dashboard and add it to .env.",
    );
  }

  const { createClient } = await import("@libsql/client/web");
  return createClient({ url, authToken });
}

/**
 * Returns a migrated client. Memoised on the promise, not the result, so a
 * cold serverless start that handles several concurrent requests still runs
 * the migration exactly once.
 */
export function db(): Promise<Client> {
  if (ready) return ready;

  ready = (async () => {
    client = await connect();
    await migrate(client);
    return client;
  })().catch((err) => {
    // A failed init must not be cached, or every later request inherits it.
    ready = null;
    client = null;
    throw err;
  });

  return ready;
}

/** Drops the cached connection. Tests use this between scratch databases. */
export function closeDb(): void {
  client?.close();
  client = null;
  ready = null;
}

// libSQL rejects undefined; SQL wants NULL.
function toArgs(args: unknown[]): InValue[] {
  return args.map((value) => (value === undefined ? null : (value as InValue)));
}

export async function all<T>(sql: string, args: unknown[] = []): Promise<T[]> {
  const handle = await db();
  const result = await handle.execute({ sql, args: toArgs(args) });
  return result.rows as unknown as T[];
}

export async function one<T>(sql: string, args: unknown[] = []): Promise<T | undefined> {
  const rows = await all<T>(sql, args);
  return rows[0];
}

export async function run(sql: string, args: unknown[] = []): Promise<void> {
  const handle = await db();
  await handle.execute({ sql, args: toArgs(args) });
}

/** Runs several statements as one transaction — all of them, or none. */
export async function batch(
  statements: { sql: string; args?: unknown[] }[],
): Promise<void> {
  if (statements.length === 0) return;
  const handle = await db();
  await handle.batch(
    statements.map((s) => ({ sql: s.sql, args: toArgs(s.args ?? []) })),
    "write",
  );
}

async function migrate(handle: Client): Promise<void> {
  // No journal_mode pragma here: it is meaningless over a remote connection.
  await handle.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      wallet      TEXT UNIQUE NOT NULL,
      created_at  TEXT NOT NULL,
      is_demo     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS challenges (
      nonce       TEXT PRIMARY KEY,
      wallet      TEXT NOT NULL,
      issued_at   TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      signature         TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL,
      plan              TEXT NOT NULL,
      amount_base_units INTEGER NOT NULL,
      payer_wallet      TEXT NOT NULL,
      verified_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      plan        TEXT NOT NULL,
      starts_at   TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      signature   TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS documents (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
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
      user_id         TEXT NOT NULL,
      document_id     TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS demo_usage (
      client   TEXT NOT NULL,
      asked_at TEXT NOT NULL
    );

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

// ------------------------------------------------------------------- contact

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

/** Messages one client may send per hour, so the form is not a spam relay. */
const CONTACT_LIMIT_PER_HOUR = 3;

export async function saveContactMessage(input: {
  name: string;
  email: string;
  message: string;
  wallet: string | null;
  client: string;
}): Promise<ContactMessage> {
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
  const recent = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM contact_messages WHERE client = ? AND created_at >= ?",
    [input.client, since],
  );

  if ((recent?.n ?? 0) >= CONTACT_LIMIT_PER_HOUR) {
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

  await run(
    `INSERT INTO contact_messages (id, name, email, message, wallet, client, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.name, row.email, row.message, row.wallet, input.client, row.createdAt],
  );

  return row;
}

/** Everything the form has collected, newest first. Used by `npm run messages`. */
export async function listContactMessages(): Promise<ContactMessage[]> {
  const rows = await all<{
    id: string;
    name: string;
    email: string;
    message: string;
    wallet: string | null;
    created_at: string;
  }>(
    "SELECT id, name, email, message, wallet, created_at FROM contact_messages ORDER BY created_at DESC",
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    message: r.message,
    wallet: r.wallet,
    createdAt: r.created_at,
  }));
}
