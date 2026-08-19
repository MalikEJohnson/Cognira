import type { RawDocument, Source } from "./types.js";

/**
 * Reads decision material out of a live GitHub repo.
 *
 * Two things here actually carry reasoning, and they are not the code:
 * substantial commit messages, and pull request discussions. A one-line "fix
 * typo" commit is noise, so commits are filtered to those with a real body.
 * PR review threads are where "why did we do it this way" gets argued out, so
 * each PR is assembled into one document with its comments attached.
 */

const API = "https://api.github.com";

export interface GithubSourceOptions {
  /** Personal access token. Required for private repos, raises rate limits otherwise. */
  token?: string;
  /** Most recent commits to consider. Defaults to 300. */
  maxCommits?: number;
  /** Most recent pull requests to read discussions from. Defaults to 60. */
  maxPullRequests?: number;
  /** Commit messages shorter than this with no body are skipped. Defaults to 120. */
  minCommitMessageLength?: number;
}

interface GhCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string };
  };
  author?: { login?: string } | null;
}

interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
  created_at: string;
  user?: { login?: string } | null;
}

interface GhComment {
  body: string | null;
  user?: { login?: string } | null;
  created_at: string;
}

export function githubSource(repo: string, options: GithubSourceOptions = {}): Source {
  const slug = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").trim();

  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
    throw new Error(`Expected a GitHub repo as "owner/name", got "${repo}"`);
  }

  const maxCommits = options.maxCommits ?? 300;
  const maxPulls = options.maxPullRequests ?? 60;
  const minLength = options.minCommitMessageLength ?? 120;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cognira",
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  async function get<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers });

    if (response.status === 401 || response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        const reset = response.headers.get("x-ratelimit-reset");
        const when = reset
          ? new Date(Number(reset) * 1000).toISOString().slice(11, 19)
          : "shortly";
        throw new Error(
          `GitHub rate limit reached (resets around ${when} UTC). Set GITHUB_TOKEN in .env to raise the limit from 60 to 5000 requests per hour.`,
        );
      }
      throw new Error(
        `GitHub denied access to ${slug}. A private repo needs GITHUB_TOKEN set in .env with the "repo" scope.`,
      );
    }

    if (response.status === 404) {
      throw new Error(
        `GitHub repo "${slug}" not found. Check the spelling, or set GITHUB_TOKEN if it is private.`,
      );
    }

    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} for ${url}`);
    }

    return (await response.json()) as T;
  }

  /** Walks a paginated list endpoint until `limit` items or the list runs out. */
  async function* paginate<T>(pathAndQuery: string, limit: number): AsyncIterable<T> {
    const perPage = Math.min(100, limit);
    let page = 1;
    let seen = 0;

    while (seen < limit) {
      const joiner = pathAndQuery.includes("?") ? "&" : "?";
      const batch = await get<T[]>(
        `${API}${pathAndQuery}${joiner}per_page=${perPage}&page=${page}`,
      );

      if (batch.length === 0) return;

      for (const item of batch) {
        if (seen >= limit) return;
        yield item;
        seen += 1;
      }

      if (batch.length < perPage) return;
      page += 1;
    }
  }

  return {
    id: "github",
    label: `GitHub ${slug}`,

    async *documents(): AsyncIterable<RawDocument> {
      // ---- commits with a real message body ----
      for await (const commit of paginate<GhCommit>(`/repos/${slug}/commits`, maxCommits)) {
        const message = commit.commit.message.trim();
        const hasBody = message.includes("\n");

        if (!hasBody && message.length < minLength) continue;

        const subject = message.split("\n")[0]!.slice(0, 120);
        const who = commit.author?.login ?? commit.commit.author?.name ?? "unknown";
        const when = commit.commit.author?.date;

        yield {
          title: `Commit: ${subject}`,
          source: `GitHub ${slug} commit ${commit.sha.slice(0, 7)}`,
          content: [
            `Repository: ${slug}`,
            `Author: ${who}`,
            when ? `Date: ${when}` : "",
            `Commit: ${commit.sha}`,
            "",
            message,
          ]
            .filter(Boolean)
            .join("\n"),
          externalId: `github:${slug}:commit:${commit.sha}`,
          occurredAt: when,
        };
      }

      // ---- pull requests, with their discussion attached ----
      for await (const pull of paginate<GhPull>(
        `/repos/${slug}/pulls?state=all&sort=updated&direction=desc`,
        maxPulls,
      )) {
        const sections: string[] = [
          `Repository: ${slug}`,
          `Pull request #${pull.number}: ${pull.title}`,
          `Opened by: ${pull.user?.login ?? "unknown"} on ${pull.created_at}`,
          `State: ${pull.merged_at ? `merged ${pull.merged_at}` : pull.state}`,
        ];

        if (pull.body?.trim()) sections.push("", "Description:", pull.body.trim());

        // Issue comments are the conversation; review comments are line-level notes.
        const discussion: string[] = [];
        for (const endpoint of [
          `/repos/${slug}/issues/${pull.number}/comments`,
          `/repos/${slug}/pulls/${pull.number}/comments`,
        ]) {
          try {
            const comments = await get<GhComment[]>(`${API}${endpoint}?per_page=100`);
            for (const c of comments) {
              if (!c.body?.trim()) continue;
              discussion.push(`${c.user?.login ?? "unknown"}: ${c.body.trim()}`);
            }
          } catch {
            // A missing or forbidden comment thread should not lose the PR itself.
          }
        }

        if (discussion.length > 0) {
          sections.push("", "Discussion:", discussion.join("\n\n"));
        }

        // A PR with no description and no discussion carries no reasoning.
        if (!pull.body?.trim() && discussion.length === 0) continue;

        yield {
          title: `PR #${pull.number}: ${pull.title}`,
          source: `GitHub ${slug} pull request #${pull.number}`,
          content: sections.join("\n"),
          externalId: `github:${slug}:pull:${pull.number}`,
          occurredAt: pull.merged_at ?? pull.created_at,
        };
      }
    },
  };
}
