import { describeApiError } from "./claude.js";
import { extractDecisions } from "./extract.js";
import { hashContent, knownContentHashes, saveDocumentWithDecisions } from "./store.js";
import type { IngestEvent, RawDocument, Source } from "./sources/types.js";

/**
 * Pulls documents from every configured source and extracts decisions from each.
 *
 * Sources run in parallel with each other, and extraction runs in a bounded
 * pool, so a slow source never blocks a fast one and the Anthropic API never
 * sees an unbounded burst. Everything is deduplicated by content hash, which
 * makes re-running ingestion cheap and safe — the second run over an unchanged
 * folder costs nothing.
 */

/** Below this, a document is too short to hold a decision worth extracting. */
const MIN_CONTENT_CHARS = 80;

/**
 * Above this, one document would cost a lot to extract. It is reported as a
 * skip with its size rather than quietly truncated — a half-read meeting note
 * produces a confidently wrong decision record, which is worse than no record.
 */
const MAX_CONTENT_CHARS = 400_000;

export interface IngestOptions {
  /** Concurrent extraction calls. Defaults to 4. */
  concurrency?: number;
  /** Stop after ingesting this many new documents. Unlimited by default. */
  limit?: number;
  onEvent?: (event: IngestEvent) => void;
}

export interface IngestSummary {
  documentsSeen: number;
  documentsIngested: number;
  documentsSkipped: number;
  decisionsFound: number;
  failures: { source: string; title: string; message: string }[];
  sourceErrors: { source: string; message: string }[];
}

export async function ingest(
  userId: string,
  sources: Source[],
  options: IngestOptions = {},
): Promise<IngestSummary> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const emit = options.onEvent ?? (() => {});

  const summary: IngestSummary = {
    documentsSeen: 0,
    documentsIngested: 0,
    documentsSkipped: 0,
    decisionsFound: 0,
    failures: [],
    sourceErrors: [],
  };

  // Seeded from what is already stored, then grown as this run proceeds — so
  // duplicates within a single run are caught too.
  const seenHashes = knownContentHashes(userId);

  let inFlight = 0;
  let stopped = false;
  const pending = new Set<Promise<void>>();

  /** Blocks until a worker slot frees up. */
  async function acquire(): Promise<void> {
    while (inFlight >= concurrency) {
      await Promise.race(pending);
    }
  }

  function schedule(source: Source, doc: RawDocument): void {
    inFlight += 1;

    const task = (async () => {
      emit({ type: "extracting", source: source.label, title: doc.title });

      try {
        const extracted = await extractDecisions({
          title: doc.title,
          source: doc.source,
          content: doc.content,
        });

        saveDocumentWithDecisions(
          userId,
          {
            title: doc.title,
            source: doc.source,
            content: doc.content,
            sourceId: source.id,
            externalId: doc.externalId,
            contentHash: hashContent(doc.content),
          },
          extracted,
        );

        summary.documentsIngested += 1;
        summary.decisionsFound += extracted.length;
        emit({
          type: "extracted",
          source: source.label,
          title: doc.title,
          decisions: extracted.length,
        });
      } catch (err) {
        const message = describeApiError(err);
        summary.failures.push({ source: source.label, title: doc.title, message });
        emit({ type: "failed", source: source.label, title: doc.title, message });
      } finally {
        inFlight -= 1;
      }
    })();

    pending.add(task);
    void task.finally(() => pending.delete(task));
  }

  async function drain(source: Source): Promise<void> {
    emit({ type: "source-start", source: source.label });
    let found = 0;

    try {
      for await (const doc of source.documents()) {
        if (stopped) break;
        summary.documentsSeen += 1;

        const skip = reasonToSkip(doc, seenHashes);
        if (skip) {
          summary.documentsSkipped += 1;
          emit({ type: "skipped", source: source.label, title: doc.title, reason: skip });
          continue;
        }

        seenHashes.add(hashContent(doc.content));
        found += 1;

        await acquire();
        if (stopped) break;
        schedule(source, doc);

        if (options.limit && summary.documentsIngested + inFlight >= options.limit) {
          stopped = true;
          break;
        }
      }

      emit({ type: "source-done", source: source.label, found });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.sourceErrors.push({ source: source.label, message });
      emit({ type: "source-error", source: source.label, message });
    }
  }

  await Promise.all(sources.map(drain));
  // Sources have stopped producing; wait for extractions still in the pool.
  while (pending.size > 0) await Promise.all([...pending]);

  return summary;
}

function reasonToSkip(doc: RawDocument, seenHashes: Set<string>): string | null {
  const length = doc.content.trim().length;

  if (length < MIN_CONTENT_CHARS) return "too short to hold a decision";
  if (length > MAX_CONTENT_CHARS) {
    return `too large to extract in one pass (${Math.round(length / 1000)}k characters)`;
  }
  if (seenHashes.has(hashContent(doc.content))) return "already ingested";

  return null;
}
