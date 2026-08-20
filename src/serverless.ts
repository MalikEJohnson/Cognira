/**
 * Entry point for a serverless host.
 *
 * Vercel invokes a function per request instead of running a process, so this
 * exports the Express app rather than starting a listener. src/server.ts skips
 * listen() whenever VERCEL is set, which lets local development and serverless
 * share one file.
 */
import app from "./server.js";

export default app;
