import { createHash, randomUUID } from "node:crypto";
import { db } from "./db.js";

export interface Alternative {
  option: string;
  why_rejected: string;
}

export interface Decision {
  id: string;
  documentId: string;
  documentTitle: string;
  documentSource: string;
  decision: string;
  reasoning: string;
  alternatives: Alternative[];
  people: string[];
  decided_on: string;
  assumptions: string[];
  outcome: string;
  evidence: string[];
  confidence: number;
  extractedAt: string;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  source: string;
  content: string;
  addedAt: string;
  sourceId?: string;
  externalId?: string;
  contentHash?: string;
}

export interface Corpus {
  documents: KnowledgeDoc[];
  decisions: Decision[];
}

/** SHA-256 of a document's text, used to skip re-ingesting unchanged items. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// SQLite has no array type, so list fields round-trip as JSON text.
function parseList<T>(raw: unknown): T[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

interface DecisionRow {
  id: string;
  document_id: string;
  document_title: string;
  document_source: string;
  decision: string;
  reasoning: string;
  alternatives: string;
  people: string;
  decided_on: string;
  assumptions: string;
  outcome: string;
  evidence: string;
  confidence: number;
  extracted_at: string;
}

interface DocumentRow {
  id: string;
  title: string;
  source: string;
  content: string;
  added_at: string;
  source_id: string | null;
  external_id: string | null;
  content_hash: string;
}

function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    documentSource: row.document_source,
    decision: row.decision,
    reasoning: row.reasoning,
    alternatives: parseList<Alternative>(row.alternatives),
    people: parseList<string>(row.people),
    decided_on: row.decided_on,
    assumptions: parseList<string>(row.assumptions),
    outcome: row.outcome,
    evidence: parseList<string>(row.evidence),
    confidence: row.confidence,
    extractedAt: row.extracted_at,
  };
}

function toDocument(row: DocumentRow): KnowledgeDoc {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    content: row.content,
    addedAt: row.added_at,
    sourceId: row.source_id ?? undefined,
    externalId: row.external_id ?? undefined,
    contentHash: row.content_hash,
  };
}

export function listDecisions(userId: string): Decision[] {
  const rows = db()
    .prepare(
      "SELECT * FROM decisions WHERE user_id = ? ORDER BY extracted_at DESC, rowid DESC",
    )
    .all(userId) as unknown as DecisionRow[];
  return rows.map(toDecision);
}

export function listDocuments(userId: string): KnowledgeDoc[] {
  const rows = db()
    .prepare("SELECT * FROM documents WHERE user_id = ? ORDER BY added_at ASC")
    .all(userId) as unknown as DocumentRow[];
  return rows.map(toDocument);
}

/** Everything one person has stored, which is what an answer is reasoned from. */
export function loadCorpus(userId: string): Corpus {
  return { documents: listDocuments(userId), decisions: listDecisions(userId) };
}

export function documentCount(userId: string): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM documents WHERE user_id = ?")
    .get(userId) as unknown as { n: number };
  return row.n;
}

/**
 * Every content hash this user already has. Ingestion loads it once up front
 * rather than querying per candidate document.
 */
export function knownContentHashes(userId: string): Set<string> {
  const rows = db()
    .prepare("SELECT content_hash FROM documents WHERE user_id = ?")
    .all(userId) as unknown as { content_hash: string }[];
  return new Set(rows.map((r) => r.content_hash));
}

export function saveDocumentWithDecisions(
  userId: string,
  doc: Omit<KnowledgeDoc, "id" | "addedAt">,
  extracted: Omit<
    Decision,
    "id" | "documentId" | "documentTitle" | "documentSource" | "extractedAt"
  >[],
): { document: KnowledgeDoc; decisions: Decision[] } {
  const handle = db();
  const now = new Date().toISOString();

  const document: KnowledgeDoc = {
    ...doc,
    id: randomUUID(),
    addedAt: now,
    contentHash: doc.contentHash ?? hashContent(doc.content),
    sourceId: doc.sourceId ?? "paste",
  };

  const decisions: Decision[] = extracted.map((d) => ({
    ...d,
    id: randomUUID(),
    documentId: document.id,
    documentTitle: document.title,
    documentSource: document.source,
    extractedAt: now,
  }));

  // The document and its decisions land together or not at all.
  handle.exec("BEGIN");
  try {
    handle
      .prepare(
        `INSERT INTO documents
           (id, user_id, title, source, content, added_at, source_id, external_id, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        document.id,
        userId,
        document.title,
        document.source,
        document.content,
        document.addedAt,
        document.sourceId ?? null,
        document.externalId ?? null,
        document.contentHash!,
      );

    const insertDecision = handle.prepare(
      `INSERT INTO decisions
         (id, user_id, document_id, document_title, document_source, decision, reasoning,
          alternatives, people, decided_on, assumptions, outcome, evidence, confidence, extracted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const d of decisions) {
      insertDecision.run(
        d.id,
        userId,
        d.documentId,
        d.documentTitle,
        d.documentSource,
        d.decision,
        d.reasoning,
        JSON.stringify(d.alternatives),
        JSON.stringify(d.people),
        d.decided_on,
        JSON.stringify(d.assumptions),
        d.outcome,
        JSON.stringify(d.evidence),
        d.confidence,
        d.extractedAt,
      );
    }

    handle.exec("COMMIT");
  } catch (err) {
    handle.exec("ROLLBACK");
    throw err;
  }

  return { document, decisions };
}
