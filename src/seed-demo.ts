import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCredentials, describeApiError } from "./claude.js";
import { ingest } from "./ingest.js";
import { folderSource } from "./sources/folder.js";
import { demoUser } from "./demo.js";
import { documentCount } from "./store.js";

/**
 * Loads the shared demo corpus.
 *
 *   npm run seed:demo
 *
 * The demo is read-only for visitors, so this is the only way content gets
 * into it. Safe to re-run: ingestion dedupes by content hash.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  assertCredentials();

  const workspace = path.join(here, "..", "samples", "workspace");
  const user = demoUser();

  console.log(`Seeding the demo from ${workspace}`);

  const summary = await ingest(user.id, [folderSource(workspace)], {
    concurrency: 3,
    onEvent: (event) => {
      if (event.type === "extracted") {
        console.log(`  ${event.decisions} decision(s)  ${event.title}`);
      } else if (event.type === "skipped") {
        console.log(`  skipped  ${event.title} — ${event.reason}`);
      } else if (event.type === "failed") {
        console.error(`  FAILED   ${event.title} — ${event.message}`);
      }
    },
  });

  console.log(
    `\nDemo corpus now holds ${documentCount(user.id)} document(s) ` +
      `and gained ${summary.decisionsFound} decision(s).`,
  );

  if (summary.failures.length > 0) {
    console.error(`${summary.failures.length} document(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${describeApiError(err)}\n`);
  process.exit(1);
});
