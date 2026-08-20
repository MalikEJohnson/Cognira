import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5";

/**
 * The SDK resolves credentials from the environment (ANTHROPIC_API_KEY, or an
 * `ant auth login` profile). We check explicitly so a missing key surfaces as a
 * readable startup error instead of a 401 on the first request.
 */
export function assertCredentials(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and paste your key from https://console.anthropic.com/settings/keys",
    );
  }
}

let cached: Anthropic | null = null;

/**
 * Built on first use, never at import time.
 *
 * The SDK constructor throws when no API key is present. At module scope on a
 * serverless host that becomes an opaque FUNCTION_INVOCATION_FAILED before any
 * route can run, so the error can never be reported. Deferring it means a
 * missing key surfaces as a readable message from the route that needed it.
 */
export function client(): Anthropic {
  if (!cached) cached = new Anthropic();
  return cached;
}

/** Turns an SDK error into a message that is safe and useful to show a user. */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in your .env file.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the Anthropic API. Wait a moment and try again.";
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `The request was rejected: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API. Check your network connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
