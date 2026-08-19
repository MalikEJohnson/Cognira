/**
 * A source is anything Cognira can read decisions out of: a folder on disk, a
 * GitHub repo, a Slack export, eventually a live Gmail account. Each one
 * streams RawDocuments; the ingestion runner does the rest.
 *
 * Sources are async iterables rather than arrays on purpose — a Gmail account
 * or a large repo should not be fully materialised in memory before the first
 * document starts being processed.
 */

export interface RawDocument {
  /** Human-readable name — becomes the citation Cognira shows in an answer. */
  title: string;
  /** Where it came from, phrased for a person: "Slack #engineering", "Commit a3f1b2". */
  source: string;
  /** The text to extract decisions from. */
  content: string;
  /** Stable identifier within the source, so re-runs recognise the same item. */
  externalId: string;
  /** When the thing happened, if the source knows. ISO 8601. */
  occurredAt?: string;
}

export interface Source {
  /** Short machine id: "folder", "github", "slack". */
  readonly id: string;
  /** Label shown in ingestion progress. */
  readonly label: string;
  documents(): AsyncIterable<RawDocument>;
}

/** Progress events emitted while ingesting, for CLI output or a live UI. */
export type IngestEvent =
  | { type: "source-start"; source: string }
  | { type: "source-done"; source: string; found: number }
  | { type: "source-error"; source: string; message: string }
  | { type: "skipped"; source: string; title: string; reason: string }
  | { type: "extracting"; source: string; title: string }
  | { type: "extracted"; source: string; title: string; decisions: number }
  | { type: "failed"; source: string; title: string; message: string };
