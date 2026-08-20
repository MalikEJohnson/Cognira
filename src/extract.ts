import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, MODEL } from "./claude.js";

const AlternativeSchema = z.object({
  option: z.string().describe("The option that was considered but not chosen"),
  why_rejected: z
    .string()
    .describe("The stated reason it lost, in the source's own terms"),
});

const DecisionSchema = z.object({
  decision: z
    .string()
    .describe("The decision itself, stated in one sentence. E.g. 'Use Stripe as the payment processor'"),
  reasoning: z
    .string()
    .describe(
      "Why this was chosen. Ground every clause in the source text. Do not invent business rationale that is not there.",
    ),
  alternatives: z
    .array(AlternativeSchema)
    .describe("Options that were considered and rejected. Empty array if none were named."),
  people: z
    .array(z.string())
    .describe("Names or roles of people who made, argued for, or influenced this decision."),
  decided_on: z
    .string()
    .describe("The date the decision was made, as YYYY-MM-DD. Use 'unknown' if the source does not say."),
  assumptions: z
    .array(z.string())
    .describe(
      "Things the decision treats as true without proving them. These are what will later be worth re-checking.",
    ),
  outcome: z
    .string()
    .describe("What resulted or was expected to result. Use 'not stated' if the source does not say."),
  evidence: z
    .array(z.string())
    .describe("Short verbatim quotes from the source that support this extraction. 1-3 quotes."),
  confidence: z
    .number()
    .describe(
      "0 to 1. How well-supported this extraction is by the text. 0.9+ means the decision and its reasoning are stated outright. 0.5 means the reasoning is inferred from context. Below 0.4 means you are largely guessing.",
    ),
});

const ExtractionSchema = z.object({
  decisions: z
    .array(DecisionSchema)
    .describe("Every distinct decision this document records. Empty array if it records none."),
});

export type ExtractedDecision = z.infer<typeof DecisionSchema>;

const SYSTEM_PROMPT = `You are the extraction engine for Cognira, a system that preserves an organisation's institutional memory.

Your job is to read a document — meeting notes, an email thread, a Slack export, a design doc, a commit message — and pull out the DECISIONS it records, along with the reasoning behind them.

What counts as a decision: a choice between options, a commitment to a course of action, a policy set, a direction reversed, an idea explicitly rejected. A document may contain several, one, or none.

Rules you must follow:

1. GROUND EVERYTHING. Every claim in "reasoning", "alternatives", and "assumptions" must trace back to something actually in the document. If the document says Stripe was chosen but never says why, the reasoning is "Not stated in this document" and the confidence is low. Inventing plausible rationale is the single worst failure mode here — a confidently wrong institutional memory is more damaging than an empty one.

2. SEPARATE STATED FROM INFERRED. If reasoning is implied rather than written, say so in the reasoning field ("Implied by X...") and lower the confidence accordingly.

3. ASSUMPTIONS ARE THE VALUABLE PART. An assumption is something the decision depends on being true, that nobody verified. "We assumed our volume would stay under 10k transactions/month." "We assumed the team would still have Go expertise next year." Surface these even when they are only implicit — they are what makes a decision worth revisiting later. Mark implicit ones as such.

4. CALIBRATE CONFIDENCE HONESTLY. It is a measure of textual support, not of how good the decision was.

5. If the document records no decision at all — it is a status update, a spec, a receipt — return an empty decisions array. Do not manufacture one.`;

export async function extractDecisions(input: {
  title: string;
  source: string;
  content: string;
}): Promise<ExtractedDecision[]> {
  const userContent = [
    `Document title: ${input.title}`,
    `Source: ${input.source || "not specified"}`,
    "",
    "--- BEGIN DOCUMENT ---",
    input.content,
    "--- END DOCUMENT ---",
    "",
    "Extract every decision this document records.",
  ].join("\n");

  const response = await client().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    thinking: { type: "adaptive" },
    output_config: {
      format: zodOutputFormat(ExtractionSchema),
      effort: "high",
    },
    messages: [{ role: "user", content: userContent }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      "Claude declined to process this document. If it contains sensitive material, try a redacted version.",
    );
  }

  if (!response.parsed_output) {
    throw new Error("Extraction returned no structured result. Try again, or shorten the document.");
  }

  return response.parsed_output.decisions;
}
