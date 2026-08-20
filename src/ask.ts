import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, MODEL } from "./claude.js";
import { loadCorpus, type Corpus } from "./store.js";

/**
 * The MVP sends the whole corpus to the model rather than doing retrieval.
 * That is deliberate — with a few hundred documents it gives strictly better
 * answers than naive chunk retrieval, because cross-document reasoning is the
 * whole point. Past this ceiling it needs real retrieval, and we say so out
 * loud rather than silently dropping context on the floor.
 */
const MAX_CONTEXT_CHARS = 1_500_000;

/** Turns of conversation kept when answering a follow-up. */
export const MAX_HISTORY_TURNS = 20;

const AnswerSchema = z.object({
  found: z
    .boolean()
    .describe("True if the stored knowledge actually answers the question. False if it does not."),
  answer: z
    .string()
    .describe(
      "The answer, written for a colleague. Use plain line breaks for structure, not markdown syntax. If found is false, explain what is missing instead.",
    ),
  confidence: z
    .number()
    .describe("0 to 1. How well the stored evidence supports this answer."),
  sources: z
    .array(z.string())
    .describe("Titles of the documents this answer draws on, most important first."),
  caveats: z
    .array(z.string())
    .describe(
      "Gaps, contradictions between sources, or places where you inferred rather than read. Empty array if none.",
    ),
});

const SYSTEM_PROMPT = `You are Cognira, an organisation's institutional memory.

You are given everything the organisation has recorded: raw documents, and decisions already extracted from them. Someone asks you a question — usually a "why" question about a past decision, or a question about what the organisation is currently assuming.

How to answer:

RECONSTRUCT, DON'T RETRIEVE. Do not hand back a list of matching documents. Work out what actually happened and explain it: what was decided, when, what the alternatives were, why each one lost, who drove it, and what it led to. Connect evidence across documents — a decision made in a meeting and confirmed in later notes is a stronger answer than either alone, and you should say so.

CITE AS YOU GO. Attribute claims to the document they came from, by title and date, inline in the answer.

SAY WHEN YOU DON'T KNOW. If the stored knowledge does not contain the answer, set found to false and say specifically what is missing — "nothing here records the PayPal evaluation, only the final choice" is useful; a vague hedge is not. Never fill a gap with a plausible guess. An organisation trusting a fabricated memory is the failure mode that makes this product worthless.

FLAG DISAGREEMENT. If two documents conflict, surface the conflict rather than silently picking one.

THIS IS A CONVERSATION. Earlier turns are part of the context. When someone asks "what about Adyen?" or "why not?", resolve it against what was just discussed rather than treating it as a fresh question. Don't repeat an explanation you have already given in this conversation — build on it. If a follow-up is genuinely ambiguous, say which reading you took.

For questions about assumptions or risk — "what are we assuming", "what might we regret" — reason from the assumptions recorded against each decision, plus what has happened since. Be concrete about which assumption, from which decision, and what would have to change for it to break.`;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AskResult {
  found: boolean;
  answer: string;
  confidence: number;
  sources: string[];
  caveats: string[];
}

function buildContext(corpus: Corpus): string {
  const decisionsBlock = JSON.stringify(corpus.decisions, null, 2);
  const documentsBlock = corpus.documents
    .map(
      (d, i) =>
        [
          `### Document ${i + 1}: ${d.title}`,
          `Source: ${d.source || "not specified"} | Added: ${d.addedAt.slice(0, 10)}`,
          "",
          d.content,
        ].join("\n"),
    )
    .join("\n\n---\n\n");

  return [
    "## Decisions already extracted from these documents",
    decisionsBlock,
    "",
    "## The full source documents",
    documentsBlock,
  ].join("\n");
}

const EMPTY_STORE: AskResult = {
  found: false,
  answer:
    "Cognira has no knowledge stored yet. Paste a meeting note, email, or decision record into the Add Knowledge panel, or run an ingestion, then ask again.",
  confidence: 1,
  sources: [],
  caveats: [],
};

/**
 * Answers a question against an explicit corpus. The corpus goes in the system
 * prompt behind a cache breakpoint, so every follow-up in a conversation reuses
 * it at roughly a tenth of the input cost instead of paying full price again.
 */
export async function answerFrom(
  corpus: Corpus,
  question: string,
  history: ChatTurn[] = [],
): Promise<AskResult> {
  if (corpus.documents.length === 0) return { ...EMPTY_STORE };

  const context = buildContext(corpus);
  if (context.length > MAX_CONTEXT_CHARS) {
    throw new Error(
      `The stored corpus is ${Math.round(context.length / 1000)}k characters, past what this MVP sends to the model in one request (${Math.round(
        MAX_CONTEXT_CHARS / 1000,
      )}k). Answering now would mean silently dropping documents. This is the point where Cognira needs a real retrieval layer.`,
    );
  }

  const recent = history.slice(-MAX_HISTORY_TURNS);

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: [
      { type: "text", text: SYSTEM_PROMPT },
      // Cache breakpoint sits after the corpus: stable across a conversation,
      // invalidated only when a document is added.
      { type: "text", text: context, cache_control: { type: "ephemeral" } },
    ],
    thinking: { type: "adaptive" },
    output_config: {
      format: zodOutputFormat(AnswerSchema),
      effort: "high",
    },
    messages: [
      ...recent.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user" as const, content: question },
    ],
  });

  if (response.usage.cache_read_input_tokens) {
    console.log(
      `[ask] cache hit: ${response.usage.cache_read_input_tokens} tokens reused`,
    );
  }

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to answer this question.");
  }

  if (!response.parsed_output) {
    throw new Error("Cognira could not produce a structured answer. Try rephrasing the question.");
  }

  return response.parsed_output;
}

/** Answers a question against everything one user has stored. */
export async function askCognira(
  userId: string,
  question: string,
  history: ChatTurn[] = [],
): Promise<AskResult> {
  return answerFrom(await loadCorpus(userId), question, history);
}

/** Renders an AskResult into the plain text the front end displays. */
export function formatAnswer(result: AskResult): string {
  const parts: string[] = [result.answer.trim()];

  if (result.sources.length > 0) {
    parts.push(`Sources: ${result.sources.join(" · ")}`);
  }
  if (result.caveats.length > 0) {
    parts.push(`Caveats:\n${result.caveats.map((c) => `  – ${c}`).join("\n")}`);
  }
  parts.push(`Confidence: ${Math.round(result.confidence * 100)}%`);

  return parts.join("\n\n");
}
