# Runs the real server: a stateful, long-lived process with a SQLite file on a
# mounted volume. Works as-is on Railway, Render, Fly.io and any container host.
#
# Node 22.5+ is required — the database driver is node:sqlite, which is built
# into the runtime and did not exist before then.
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

# Mount a persistent volume here, or every deploy wipes accounts and payments.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["npm", "start"]
