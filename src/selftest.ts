import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCredentials, describeApiError } from "./claude.js";
import { extractDecisions } from "./extract.js";
import { ingest } from "./ingest.js";
import { folderSource } from "./sources/folder.js";
import { upsertUser } from "./auth.js";
import { closeDb } from "./db.js";
import { answerFrom, askCognira, formatAnswer, type ChatTurn } from "./ask.js";
import type { Corpus } from "./store.js";

/**
 * End-to-end check of the two things that have to work: extraction, and the
 * conversation on top of it. Runs against an in-memory corpus so it never
 * touches data/cognira.json.
 *
 *   npm run selftest
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, "..", "samples", "workspace", "notes", "payments-kickoff.md");

let failures = 0;

function check(label: string, passed: boolean, detail = ""): void {
  if (passed) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

async function main(): Promise<void> {
  assertCredentials();

  console.log("Cognira self-test\nModel calls are real, so this takes a minute and costs a few cents.");

  // ---- 1. Extraction -----------------------------------------------------
  section("1. Extraction");

  const content = await fs.readFile(SAMPLE, "utf8");
  const extracted = await extractDecisions({
    title: "Payments Integration Review",
    source: "meeting notes",
    content,
  });

  check("returned at least one decision", extracted.length >= 1, `got ${extracted.length}`);
  if (extracted.length === 0) {
    console.log("\nNothing else can be tested without a decision. Stopping.");
    process.exit(1);
  }

  const first = extracted[0]!;
  const blob = JSON.stringify(extracted).toLowerCase();

  check("identified Stripe as the choice", first.decision.toLowerCase().includes("stripe"), first.decision);
  check("recorded the rejected alternatives", first.alternatives.length >= 2, `got ${first.alternatives.length}`);
  check("named PayPal and Adyen among them", blob.includes("paypal") && blob.includes("adyen"));
  check("caught the unverified volume assumption", blob.includes("10k") || blob.includes("10,000") || blob.includes("volume"));
  check("attached supporting quotes", first.evidence.length >= 1);
  check("confidence is a sane 0-1 value", first.confidence > 0 && first.confidence <= 1, String(first.confidence));

  console.log(`\n  Decision:    ${first.decision}`);
  console.log(`  Reasoning:   ${first.reasoning}`);
  console.log(`  Assumptions: ${first.assumptions.join(" | ") || "(none)"}`);
  console.log(`  Confidence:  ${Math.round(first.confidence * 100)}%`);

  // ---- 2. Answering ------------------------------------------------------
  const now = new Date().toISOString();
  const corpus: Corpus = {
    documents: [
      {
        id: "selftest-doc",
        title: "Payments Integration Review",
        source: "meeting notes",
        content,
        addedAt: now,
      },
    ],
    decisions: extracted.map((d, i) => ({
      ...d,
      id: `selftest-${i}`,
      documentId: "selftest-doc",
      documentTitle: "Payments Integration Review",
      documentSource: "meeting notes",
      extractedAt: now,
    })),
  };

  section("2. First question");

  const q1 = "Why did we choose Stripe?";
  const a1 = await answerFrom(corpus, q1);

  check("found an answer", a1.found === true);
  check("explains the deciding factor", /integration time|two weeks|2 weeks|six|compliance/i.test(a1.answer));
  check("cited a source", a1.sources.length >= 1);

  console.log(`\n  Q: ${q1}\n`);
  console.log(formatAnswer(a1).split("\n").map((l) => `  ${l}`).join("\n"));

  // ---- 3. Follow-up (the actual chat test) -------------------------------
  section("3. Follow-up with conversation memory");

  const history: ChatTurn[] = [
    { role: "user", content: q1 },
    { role: "assistant", content: a1.answer },
  ];

  // Deliberately elliptical: this is unanswerable without the previous turn.
  const q2 = "And what about the other one we ruled out?";
  const a2 = await answerFrom(corpus, q2, history);

  check("resolved the follow-up against the earlier turn", a2.found === true);
  check(
    "understood it meant PayPal or Adyen",
    /paypal|adyen/i.test(a2.answer),
    "answer never named either rejected option",
  );

  console.log(`\n  Q: ${q2}\n`);
  console.log(formatAnswer(a2).split("\n").map((l) => `  ${l}`).join("\n"));

  // ---- 4. Refusing to invent --------------------------------------------
  section("4. Refusing to invent an answer");

  const q3 = "Why did we pick AWS over Azure for hosting?";
  const a3 = await answerFrom(corpus, q3);

  check("admitted it does not know", a3.found === false, "claimed to find an answer that is not in the corpus");

  console.log(`\n  Q: ${q3}\n`);
  console.log(formatAnswer(a3).split("\n").map((l) => `  ${l}`).join("\n"));

  // ---- 5. Ingestion across real sources (opt-in) -------------------------
  if (process.argv.includes("--with-ingest")) {
    section("5. Ingesting a whole workspace");

    const workspace = path.join(here, "..", "samples", "workspace");
    const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "cognira-selftest-"));
    // Point the database at a throwaway file so the real one is untouched.
    process.env.COGNIRA_DB = path.join(scratchDir, "test.db");
    const tester = upsertUser("selftest");

    const result = await ingest(tester.id, [folderSource(workspace)], { concurrency: 3 });

    check("read documents from every format in the workspace", result.documentsSeen >= 6, `saw ${result.documentsSeen}`);
    check("ingested without failures", result.failures.length === 0, JSON.stringify(result.failures));
    check("found decisions across the workspace", result.decisionsFound >= 3, `found ${result.decisionsFound}`);

    console.log(
      `\n  Seen ${result.documentsSeen}, ingested ${result.documentsIngested}, ` +
        `skipped ${result.documentsSkipped}, decisions ${result.decisionsFound}`,
    );

    // Re-running must cost nothing: every hash is already known.
    const second = await ingest(tester.id, [folderSource(workspace)], { concurrency: 3 });
    check(
      "re-running ingestion extracts nothing new",
      second.documentsIngested === 0,
      `re-ingested ${second.documentsIngested} document(s) — dedupe is broken`,
    );

    // The payoff: four separate files describe the Stripe decision. A good
    // answer should draw on more than one of them.
    section("6. Cross-document reasoning");

    const q4 = "Why did we choose Stripe, and what are we assuming about it?";
    const a4 = await askCognira(tester.id, q4);

    check("answered from the ingested workspace", a4.found === true);
    check("cited more than one document", a4.sources.length >= 2, `cited ${a4.sources.length}`);
    check(
      "surfaced the unverified volume assumption",
      /10k|10,000|volume/i.test(a4.answer),
      "never mentioned the transaction-volume assumption",
    );

    console.log(`\n  Q: ${q4}\n`);
    console.log(formatAnswer(a4).split("\n").map((l) => `  ${l}`).join("\n"));

    closeDb();
    await fs.rm(scratchDir, { recursive: true, force: true });
  } else {
    console.log("\n(Skipping ingestion tests. Add --with-ingest to run them.)");
  }

  // ---- Summary -----------------------------------------------------------
  section("Result");
  if (failures === 0) {
    console.log("  All checks passed. Extraction and chat both work.\n");
  } else {
    console.log(`  ${failures} check${failures === 1 ? "" : "s"} failed. See above.\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nSelf-test could not run: ${describeApiError(err)}\n`);
  process.exit(1);
});
