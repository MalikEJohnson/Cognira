/**
 * Serverless entry point — hand written, not generated.
 *
 * Its only job is to load the bundled app and, if that fails, say why. A
 * module that throws while being imported gives the platform nothing to
 * report but a generic crash page, which hides the actual error. Catching it
 * here turns an opaque 500 into the stack trace that explains it.
 */
let loading;

export default async function handler(req, res) {
  try {
    loading ??= import("../dist/app.js");
    const { default: app } = await loading;
    return app(req, res);
  } catch (err) {
    // A failed import must not be cached, or a transient fault is permanent.
    loading = undefined;

    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(
      [
        "Cognira failed to start.",
        "",
        "This is the real error, not the generic crash page:",
        "",
        err && err.stack ? err.stack : String(err),
      ].join("\n"),
    );
  }
}
