import fs from "node:fs/promises";
import path from "node:path";
import type { RawDocument } from "./types.js";

/**
 * Turns one file on disk into zero or more RawDocuments.
 *
 * Most formats yield exactly one document. Two do not: an .mbox holds many
 * emails, and a Slack export file holds a whole channel-day of messages that
 * belongs together as a single conversation.
 *
 * Returning [] means "this file has nothing to read" — a binary, an image, an
 * unsupported format. That is not an error and callers should not treat it as one.
 */

export interface ReadContext {
  /** Slack user id → display name, loaded from a export's users.json if present. */
  slackUsers?: Map<string, string>;
  /** Path the document should be described relative to, for readable titles. */
  root?: string;
}

const PLAIN_TEXT = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".log",
  ".csv",
  ".tsv",
  ".rst",
  ".adoc",
  ".org",
]);

export function isReadable(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return (
    PLAIN_TEXT.has(ext) ||
    ext === ".json" ||
    ext === ".eml" ||
    ext === ".mbox" ||
    ext === ".docx" ||
    ext === ".pdf"
  );
}

export async function readDocuments(
  filePath: string,
  ctx: ReadContext = {},
): Promise<RawDocument[]> {
  const ext = path.extname(filePath).toLowerCase();
  const label = ctx.root ? path.relative(ctx.root, filePath) : path.basename(filePath);

  if (PLAIN_TEXT.has(ext)) {
    const content = await fs.readFile(filePath, "utf8");
    return single(content, path.basename(filePath, ext), label, filePath);
  }

  if (ext === ".json") return readJson(filePath, label, ctx);
  if (ext === ".eml") return readEml(filePath, label);
  if (ext === ".mbox") return readMbox(filePath, label);
  if (ext === ".docx") return readDocx(filePath, label);
  if (ext === ".pdf") return readPdf(filePath, label);

  return [];
}

function single(
  content: string,
  title: string,
  sourceLabel: string,
  externalId: string,
  occurredAt?: string,
): RawDocument[] {
  if (!content.trim()) return [];
  return [{ title, source: sourceLabel, content, externalId, occurredAt }];
}

// ---------------------------------------------------------------- Slack / JSON

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  user_profile?: { real_name?: string; display_name?: string };
}

function looksLikeSlackExport(value: unknown): value is SlackMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.some(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as SlackMessage).ts === "string" &&
        ("text" in (m as object) || "user" in (m as object)),
    )
  );
}

/** Loads a Slack export's users.json into an id → name map, if it exists. */
export async function loadSlackUsers(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const raw = await fs.readFile(path.join(root, "users.json"), "utf8");
    const users = JSON.parse(raw) as {
      id?: string;
      real_name?: string;
      name?: string;
      profile?: { real_name?: string; display_name?: string };
    }[];
    for (const u of users) {
      if (!u.id) continue;
      const name =
        u.profile?.real_name || u.real_name || u.profile?.display_name || u.name;
      if (name) map.set(u.id, name);
    }
  } catch {
    // No users.json — messages fall back to raw user ids.
  }
  return map;
}

function renderSlackConversation(
  messages: SlackMessage[],
  users: Map<string, string> | undefined,
): string {
  const lines: string[] = [];

  for (const m of messages) {
    if (!m.text?.trim()) continue;
    // Joins, leaves, and pins are noise for decision extraction.
    if (m.subtype && m.subtype !== "thread_broadcast" && m.subtype !== "bot_message") {
      continue;
    }

    const name =
      m.user_profile?.real_name ||
      m.user_profile?.display_name ||
      (m.user ? users?.get(m.user) ?? m.user : undefined) ||
      (m.bot_id ? "bot" : "unknown");

    const time = m.ts
      ? new Date(Number(m.ts) * 1000).toISOString().slice(11, 16)
      : "";

    // Slack encodes mentions as <@U123>; swap them for readable names.
    const text = m.text.replace(/<@([A-Z0-9]+)>/g, (_all, id: string) =>
      `@${users?.get(id) ?? id}`,
    );

    lines.push(`[${time}] ${name}: ${text}`);
  }

  return lines.join("\n");
}

async function readJson(
  filePath: string,
  label: string,
  ctx: ReadContext,
): Promise<RawDocument[]> {
  const raw = await fs.readFile(filePath, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON is still text someone might have written a decision in.
    return single(raw, path.basename(filePath, ".json"), label, filePath);
  }

  if (looksLikeSlackExport(parsed)) {
    const channel = path.basename(path.dirname(filePath));
    const day = path.basename(filePath, ".json");
    const content = renderSlackConversation(parsed, ctx.slackUsers);
    if (!content.trim()) return [];

    return [
      {
        title: `#${channel} — ${day}`,
        source: `Slack #${channel}`,
        content,
        externalId: `slack:${channel}:${day}`,
        occurredAt: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined,
      },
    ];
  }

  // users.json and channels.json are metadata, not content.
  const base = path.basename(filePath).toLowerCase();
  if (base === "users.json" || base === "channels.json" || base === "integration_logs.json") {
    return [];
  }

  return single(
    JSON.stringify(parsed, null, 2),
    path.basename(filePath, ".json"),
    label,
    filePath,
  );
}

// ------------------------------------------------------------------- Email

function decodeBody(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? "").toLowerCase();

  if (enc === "base64") {
    try {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
    } catch {
      return body;
    }
  }

  if (enc === "quoted-printable") {
    // Each =XX is one BYTE, not one character. Collect the bytes first and
    // decode the whole lot as UTF-8 at the end — decoding per escape turns a
    // multi-byte character like an em dash (=E2=80=94) into mojibake.
    const unfolded = body.replace(/=\r?\n/g, "");
    const bytes: number[] = [];

    for (let i = 0; i < unfolded.length; i += 1) {
      const hex = unfolded.slice(i + 1, i + 3);
      if (unfolded[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(...Buffer.from(unfolded[i]!, "utf8"));
      }
    }

    return Buffer.from(bytes).toString("utf8");
  }

  return body;
}

/** Parses one RFC-822 message into a readable document. */
function parseMessage(rfc822: string, fallbackId: string): RawDocument | null {
  const splitAt = rfc822.search(/\r?\n\r?\n/);
  if (splitAt === -1) return null;

  const headerBlock = rfc822.slice(0, splitAt);
  let body = rfc822.slice(splitAt).replace(/^\r?\n\r?\n/, "");

  // Unfold headers that continue on indented lines.
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }

  const contentType = headers.get("content-type") ?? "";

  // For multipart mail, keep only the first text/plain part.
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType);
  if (boundaryMatch) {
    const parts = body.split(`--${boundaryMatch[1]}`);
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p));
    if (plain) {
      const inner = parseMessage(plain.replace(/^\r?\n/, ""), fallbackId);
      body = inner?.content ?? body;
    }
  } else {
    body = decodeBody(body, headers.get("content-transfer-encoding"));
  }

  // Strip an HTML-only body down to something readable.
  if (/text\/html/i.test(contentType) && !boundaryMatch) {
    body = body
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  const subject = headers.get("subject") || "(no subject)";
  const from = headers.get("from") || "unknown sender";
  const to = headers.get("to") || "";
  const date = headers.get("date") || "";

  const content = [
    `From: ${from}`,
    to ? `To: ${to}` : "",
    date ? `Date: ${date}` : "",
    `Subject: ${subject}`,
    "",
    body.trim(),
  ]
    .filter(Boolean)
    .join("\n");

  if (!body.trim()) return null;

  const parsedDate = date ? new Date(date) : null;
  const occurredAt =
    parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toISOString()
      : undefined;

  return {
    title: subject,
    source: `Email from ${from}`,
    content,
    externalId: headers.get("message-id") ?? fallbackId,
    occurredAt,
  };
}

async function readEml(filePath: string, label: string): Promise<RawDocument[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const doc = parseMessage(raw, filePath);
  return doc ? [{ ...doc, source: `${doc.source} (${label})` }] : [];
}

async function readMbox(filePath: string, label: string): Promise<RawDocument[]> {
  const raw = await fs.readFile(filePath, "utf8");

  // mbox delimits messages with a line beginning "From " at column zero.
  const chunks = raw.split(/\r?\n(?=From )/);
  const documents: RawDocument[] = [];

  for (const [i, chunk] of chunks.entries()) {
    // Drop the "From sender date" separator line itself.
    const body = chunk.replace(/^From .*\r?\n/, "");
    const doc = parseMessage(body, `${filePath}#${i}`);
    if (doc) documents.push({ ...doc, source: `${doc.source} (${label})` });
  }

  return documents;
}

// ---------------------------------------------------------------- docx / pdf

async function readDocx(filePath: string, label: string): Promise<RawDocument[]> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ path: filePath });
  return single(value, path.basename(filePath, ".docx"), label, filePath);
}

async function readPdf(filePath: string, label: string): Promise<RawDocument[]> {
  // The legacy build is the one that runs outside a browser.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const data = new Uint8Array(await fs.readFile(filePath));

  // verbosity 0 = errors only. Text extraction needs no font data, but pdfjs
  // warns about missing fonts on every base-14 PDF, and it cannot load them
  // from disk anyway because Node's fetch does not accept file: URLs.
  // getDocument returns a loading task; destroy() lives on the task, not the doc.
  const task = pdfjs.getDocument({ data, useSystemFonts: false, verbosity: 0 });

  const pages: string[] = [];
  try {
    const pdf = await task.promise;

    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const text = await page.getTextContent();
      const line = text.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (line) pages.push(line);
    }
  } finally {
    await task.destroy();
  }

  return single(pages.join("\n\n"), path.basename(filePath, ".pdf"), label, filePath);
}
