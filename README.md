# github-claude-webhook-bridge

A Cloudflare Worker that receives GitHub webhooks and starts a Claude Code routine.

GitHub can't call a routine's fire endpoint directly: the endpoint needs an `Authorization: Bearer` header and a `{"text": "..."}` body. This Worker verifies the webhook signature, drops events the routine doesn't act on, and posts the rest to the routine.

## Forwarded events

| Event | Action | Condition |
|---|---|---|
| `issue_comment` | `created` | Comment contains a word from `COMMENT_KEYWORDS` |
| `issue_comment` | `edited` | The edit adds a keyword the old text didn't have |
| `pull_request` | `opened` | Always, including drafts |
| `issues`, `pull_request` | `labeled` | Added label is in `LABELS` |
| `issues`, `pull_request` | `assigned` | New assignee is in `ASSIGNEES` |

Everything else is dropped. Every event must also have a valid `X-Hub-Signature-256`, come from a repository owned by someone in `ALLOWED_OWNERS`, and not be sent by a bot or anyone in `IGNORED_SENDERS`. `pull_request` events for PRs opened from forks are dropped (comments on those PRs are not). Name and keyword matching is case-insensitive, and keywords must stand alone (`@boticorn-dev` and `@boticorn/cli` don't match).

The routine receives `X-GitHub-Event: <event>` followed by a trimmed JSON object: repository, sender, the added label or assignee, the issue or PR (number, title, URL, state, author, labels, assignees, body, and branches for PRs), and the triggering comment with its previous text on edits. GitHub's API URLs, node IDs, avatars, reactions, and repository metadata are left out.

## Responses

| Status | Meaning |
|---|---|
| `200` | Forwarded; the body is the routine's response, including the session URL |
| `202` | Dropped by a filter; the body gives the reason |
| `400` | Missing `X-GitHub-Event` or a body that isn't JSON |
| `401` | Signature missing or invalid |
| `502` | The routine endpoint returned an error; redeliver from GitHub once fixed |

GitHub shows these under the webhook's **Recent Deliveries**.

## Configuration

The filter lists are `vars` in `wrangler.jsonc`. The routine's prompt has its own copies of `COMMENT_KEYWORDS`, `LABELS`, and `ASSIGNEES`; keep both in sync.

Secrets are kept in a local, untracked `fnox.toml` and uploaded as Worker secrets:

| Secret | Value |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | The secret set on the GitHub webhook |
| `ROUTINE_TOKEN` | The routine's bearer token |
| `ROUTINE_FIRE_URL` | `https://api.anthropic.com/v1/claude_code/routines/<trigger id>/fire` |

```sh
for k in GITHUB_WEBHOOK_SECRET ROUTINE_TOKEN ROUTINE_FIRE_URL; do
  printf '%s' "$(fnox get "$k")" | bunx wrangler secret put "$k"
done
```

Logs go to New Relic and Axiom through Workers observability destinations. Forwarded, skipped, and rejected deliveries each log one JSON line (`forwarded`, `skipped` with a reason, `rejected`).

## GitHub webhook

Set the payload URL to `https://github-claude-webhook-bridge.dsh.workers.dev`, the content type to `application/json`, and the secret to `GITHUB_WEBHOOK_SECRET`. Subscribe to **Issue comments**, **Issues**, and **Pull requests**.

## Development

```sh
bun install
bun test             # unit tests
bun run typecheck
bun run types        # regenerate worker-configuration.d.ts after editing wrangler.jsonc
bun run deploy
```

`bun run dev` reads local secrets from `.dev.vars`; copy `.dev.vars.example` to start.
