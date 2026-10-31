# github-claude-webhook-bridge

A Cloudflare Worker that receives GitHub webhooks and starts a Claude Code routine.

GitHub can't call a Claude routine's fire endpoint directly: the endpoint needs an `Authorization: Bearer` header and a `{"text": "..."}` body. This Worker verifies the webhook signature, drops events the routine doesn't act on, and posts the rest to the routine.

## Setup

### Create Claude routines

Create one at [claude.ai/code/routines](https://claude.ai/code/routines) for each webhook route you want. The UI may call it a scheduled task. The prompt is what the run does; this Worker only decides whether to fire it. Keep the prompt's keywords, labels, and assignees in sync with `wrangler.jsonc`.

Edit each routine and add an API trigger. Copy the Fire URL, shaped like `https://api.anthropic.com/v1/claude_code/routines/<trigger id>/fire`, and generate a token.

Put them in `config.json`, which maps route name to routine. `/webhook/<name>` forwards to that routine. Start from the example; `config.json` is gitignored:

```sh
cp config.example.json config.json
```

```json
{
  "foo": { "url": "https://api.anthropic.com/v1/claude_code/routines/<trigger id 1>/fire", "token": "..." },
  "bar": { "url": "https://api.anthropic.com/v1/claude_code/routines/<trigger id 2>/fire", "token": "..." }
}
```

Route names may contain letters, digits, `-` and `_`. Upload it as the `ROUTINES` Worker secret, then pick a webhook secret yourself and upload that too:

```sh
mise run config:push
bunx wrangler secret put GITHUB_WEBHOOK_SECRET
```

Run `mise run config:push` again after editing `config.json`. With fnox, `mise run secrets:push` uploads `GITHUB_WEBHOOK_SECRET` from `fnox.toml`.

### Add GitHub webhooks

On each repo, or once per org in `ALLOWED_OWNERS`, add a webhook:

- Payload URL: `https://github-claude-webhook-bridge.xxxxx.workers.dev/webhook/<name>`
- Content type: `application/json`
- Secret: the same value as `GITHUB_WEBHOOK_SECRET`

Subscribe only to these events:

- [`issue_comment`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment)
- [`issues`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issues)
- [`pull_request`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request)

```sh
gh api --method POST orgs/ORG/hooks \
  -f name=web -F active=true \
  -f config[url]='https://github-claude-webhook-bridge.xxxxx.workers.dev/webhook/foo' \
  -f config[content_type]=json \
  -f config[secret]="$GITHUB_WEBHOOK_SECRET" \
  -f events[]=issue_comment -f events[]=issues -f events[]=pull_request
```

Use `repos/OWNER/REPO/hooks` for a single repository.

### Set `vars` in `wrangler.jsonc`

These lists are what the Worker actually forwards, on every route. Anything else is dropped.

| Var                | Forwards when                                                     |
| ------------------ | ----------------------------------------------------------------- |
| `ALLOWED_OWNERS`   | The repository owner is in the list                               |
| `ALLOWED_ACTORS`   | The sender (and, for comments, the comment author) is in the list |
| `COMMENT_KEYWORDS` | An `issue_comment` is created with that word, or an edit adds it  |
| `LABELS`           | An `issues` or `pull_request` event adds that label               |
| `ASSIGNEES`        | An `issues` or `pull_request` event assigns that login            |
| `IGNORED_SENDERS`  | Never. Stops the bot from triggering itself                       |

`wrangler.jsonc` sets `ALLOWED_OWNERS` to `dvcrn`, `digitalvibeshq` and `microfnhq`, and `ALLOWED_ACTORS` to `dvcrn`. A missing list matches nothing. Logins match case-insensitively, and `ALLOWED_ACTORS` entries may start with `@`.

The checks run in this order:

1. Drop repositories whose owner isn't in `ALLOWED_OWNERS`.
2. Drop senders in `IGNORED_SENDERS` and bots (`sender.type` is `Bot`, or the login ends in `[bot]`).
3. `issue_comment` `created` or `edited`: forward when both the sender and the comment author are in `ALLOWED_ACTORS` and the body mentions a `COMMENT_KEYWORDS` entry. An edit forwards only if it adds the keyword.
4. `issues` or `pull_request` `labeled` / `assigned`: forward when the sender is in `ALLOWED_ACTORS` and the label or assignee is watched.
5. `pull_request` `opened`: forward for any author, including drafts and forks.
6. Drop everything else.

Filtered deliveries get a `202` with `skipped: <reason>` and a `skipped` log line, so they show as successful in Recent Deliveries.

Deploy after changing vars or secrets: `bun run deploy`.

## Development

```sh
bun install
bun test
bun run typecheck
bun run dev   # reads .dev.vars; copy .dev.vars.example
```

## License

MIT
