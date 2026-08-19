# Hosting review — April 2

Attendees: Dana Reyes, Marcus Hill

We compared Vercel, Fly.io and a plain VPS for the API.

Chose Fly.io. Vercel's serverless timeout capped us at 60s and our extraction
calls run longer than that. A VPS was cheaper but nobody wanted to own patching.

Assumption nobody checked: that our extraction calls stay under 5 minutes.
