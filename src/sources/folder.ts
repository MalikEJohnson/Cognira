import fs from "node:fs/promises";
import path from "node:path";
import type { RawDocument, Source } from "./types.js";
import { isReadable, loadSlackUsers, readDocuments } from "./readers.js";

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".cache",
]);

export interface FolderSourceOptions {
  /** Skip files larger than this. Defaults to 5 MB. */
  maxFileBytes?: number;
  /** How deep to walk. Defaults to 12. */
  maxDepth?: number;
}

/**
 * Reads every document Cognira understands out of a folder tree.
 *
 * This is the workhorse source, because it covers more of the product vision
 * than its name suggests: Slack and Gmail both let you export your history to
 * disk, so pointing this at an export directory ingests real Slack channels and
 * real email threads with no OAuth involved.
 */
export function folderSource(root: string, options: FolderSourceOptions = {}): Source {
  const maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  const maxDepth = options.maxDepth ?? 12;
  const absoluteRoot = path.resolve(root);

  return {
    id: "folder",
    label: `Folder ${absoluteRoot}`,

    async *documents(): AsyncIterable<RawDocument> {
      const stat = await fs.stat(absoluteRoot).catch(() => null);
      if (!stat) throw new Error(`Folder not found: ${absoluteRoot}`);
      if (!stat.isDirectory()) throw new Error(`Not a folder: ${absoluteRoot}`);

      const slackUsers = await loadSlackUsers(absoluteRoot);
      const ctx = { slackUsers, root: absoluteRoot };

      for await (const filePath of walk(absoluteRoot, 0, maxDepth)) {
        if (!isReadable(filePath)) continue;

        const fileStat = await fs.stat(filePath).catch(() => null);
        if (!fileStat || fileStat.size === 0 || fileStat.size > maxFileBytes) continue;

        let documents: RawDocument[];
        try {
          documents = await readDocuments(filePath, ctx);
        } catch {
          // One unreadable file must not abort the whole ingestion run.
          continue;
        }

        for (const doc of documents) yield doc;
      }
    },
  };
}

async function* walk(
  directory: string,
  depth: number,
  maxDepth: number,
): AsyncIterable<string> {
  if (depth > maxDepth) return;

  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      // Hidden directories are tooling, not documents.
      if (entry.name.startsWith(".")) continue;
      yield* walk(full, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}
