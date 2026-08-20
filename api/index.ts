/**
 * Vercel's entry point.
 *
 * Vercel invokes a function per request rather than running a long-lived
 * process, so this imports the Express app and hands each request to it.
 * src/server.ts skips listen() when VERCEL is set, which keeps `npm run dev`
 * working locally at the same time.
 */
export { default } from "../src/server.js";
