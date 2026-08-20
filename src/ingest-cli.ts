import "dotenv/config";
import { assertCredentials, describeApiError } from "./claude.js";
import { ingest } from "./ingest.js";
import { folderSource } from "./sources/folder.js";
import { githubSource } from "./sources/github.js";
import { hashContent, knownContentHashes } from "./store.js";
import { upsertUser } from "./auth.js";
import type { Source } from "./sources/types.js";

/**
 * Ingestion from the command line.
 *
 *   npm run ingest -- --folder "C:/exports/slack" --github anthropics/claude-code
 *   npm run ingest -- --folder ./notes --dry-run
 *
 * --dry-run lists exactly what would be read and costs nothing, because it
 * never calls the model. Run it first on a big folder.
 */

const USAGE = `
Cognira ingestion

  npm run ingest -- [options]

Options
  --folder <path>        Read a folder tree. Repeatable.
                         Handles .md .txt .csv .json .eml .mbox .docx .pdf,
                         and detects Slack export JSON automatically.
  --github <owner/repo>  Read commits and pull request discussions. Repeatable.
                         Set GITHUB_TOKEN in .env for private repos.
  --limit <n>            Stop after n new documents.
  --concurrency <n>      Parallel extractions. Default 4.
  --wallet <address>     Ingest into the workspace of this wallet. Defaults to
                         a local-only workspace called "local".
  --dry-run              List what would be ingested. Makes no model calls.
  --help                 Show this.

Examples
  npm run ingest -- --folder ./samples --dry-run
  npm run ingest -- --folder "C:/Users/me/slack-export" --limit 20
  npm run ingest -- --github MalikEJohnson/Cognira
`.trim();

interface Args {
  folders: string[];
  repos: string[];
  limit?: number;
  concurrency?: number;
  wallet: string;
  dryRun: boolean;
  help: boolean;
}

/** The CLI writes into its own workspace unless told to target a wallet. */
const LOCAL_WALLET = "local";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    folders: [],
    repos: [],
    wallet: LOCAL_WALLET,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    switch (flag) {
      case "--folder":
        if (!value) throw new Error("--folder needs a path");
        args.folders.push(value);
        i += 1;
        break;
      case "--github":
        if (!value) throw new Error("--github needs an owner/repo");
        args.repos.push(value);
        i += 1;
        break;
      case "--limit":
        if (!value) throw new Error("--limit needs a number");
        args.limit = Number(value);
        if (!Number.isFinite(args.limit) || args.limit < 1) {
          throw new Error(`--limit must be a positive number, got "${value}"`);
        }
        i += 1;
        break;
      case "--concurrency":
        if (!value) throw new Error("--concurrency needs a number");
        args.concurrency = Number(value);
        if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
          throw new Error(`--concurrency must be a positive number, got "${value}"`);
        }
        i += 1;
        break;
      case "--wallet":
        if (!value) throw new Error("--wallet needs an address");
        args.wallet = value;
        i += 1;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown option "${flag}". Run with --help.`);
    }
  }

  return args;
}

function buildSources(args: Args): Source[] {
  const sources: Source[] = [];

  for (const folder of args.folders) sources.push(folderSource(folder));

  for (const repo of args.repos) {
    sources.push(githubSource(repo, { token: process.env.GITHUB_TOKEN }));
  }

  return sources;
}

/** Lists what each source would hand over, without calling the model. */
async function dryRun(sources: Source[], userId: string, limit?: number): Promise<void> {
  const seen = await knownContentHashes(userId);
  let candidates = 0;
  let skipped = 0;
  let characters = 0;

  for (const source of sources) {
    console.log(`\n${source.label}`);
    console.log("-".repeat(source.label.length));

    try {
      for await (const doc of source.documents()) {
        const length = doc.content.trim().length;
        const hash = hashContent(doc.content);

        let mark: string;
        if (length < 80) mark = "skip  (too short)";
        else if (length > 400_000) mark = "skip  (too large)";
        else if (seen.has(hash)) mark = "skip  (already ingested)";
        else {
          mark = "read ";
          candidates += 1;
          characters += length;
          seen.add(hash);
        }

        if (mark.startsWith("skip")) skipped += 1;

        console.log(`  ${mark}  ${doc.title}  (${length.toLocaleString()} chars)`);

        if (limit && candidates >= limit) {
          console.log(`  ... stopping at --limit ${limit}`);
          break;
        }
      }
    } catch (err) {
      console.log(`  ERROR  ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ~4 characters per token is a rough but serviceable estimate for prose.
  const inputTokens = Math.round(characters / 4);

  console.log(`\nWould ingest ${candidates} document(s), skip ${skipped}.`);
  console.log(`Roughly ${inputTokens.toLocaleString()} input tokens of extraction.`);
  console.log("Run again without --dry-run to do it.\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }

  const sources = buildSources(args);

  if (sources.length === 0) {
    console.log(USAGE);
    console.error("\nNothing to ingest. Pass at least one --folder or --github.\n");
    process.exit(1);
  }

  const owner = await upsertUser(args.wallet);

  if (args.dryRun) {
    await dryRun(sources, owner.id, args.limit);
    return;
  }

  assertCredentials();

  console.log(`Ingesting into workspace: ${args.wallet}`);

  const summary = await ingest(owner.id, sources, {
    concurrency: args.concurrency,
    limit: args.limit,
    onEvent: (event) => {
      switch (event.type) {
        case "source-start":
          console.log(`\nReading ${event.source}`);
          break;
        case "source-done":
          console.log(`Finished ${event.source} — ${event.found} new document(s)`);
          break;
        case "source-error":
          console.error(`ERROR in ${event.source}: ${event.message}`);
          break;
        case "extracted":
          console.log(
            `  ${event.decisions === 0 ? "no decisions" : `${event.decisions} decision(s)`}  ${event.title}`,
          );
          break;
        case "failed":
          console.error(`  FAILED  ${event.title} — ${event.message}`);
          break;
        default:
          break;
      }
    },
  });

  console.log("\nDone.");
  console.log(`  Documents seen:     ${summary.documentsSeen}`);
  console.log(`  Ingested:           ${summary.documentsIngested}`);
  console.log(`  Skipped:            ${summary.documentsSkipped}`);
  console.log(`  Decisions found:    ${summary.decisionsFound}`);

  if (summary.failures.length > 0) {
    console.log(`  Failed:             ${summary.failures.length}`);
    for (const f of summary.failures) console.log(`    ${f.title} — ${f.message}`);
  }

  if (summary.sourceErrors.length > 0) {
    console.log(`  Source errors:      ${summary.sourceErrors.length}`);
    for (const e of summary.sourceErrors) console.log(`    ${e.source} — ${e.message}`);
  }

  console.log("");
  if (summary.failures.length > 0 || summary.sourceErrors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\n${describeApiError(err)}\n`);
  process.exit(1);
});
