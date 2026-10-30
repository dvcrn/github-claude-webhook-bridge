# github-claude-webhook-bridge

A Cloudflare Worker that receives GitHub webhooks and starts a Claude Code routine.

GitHub can't call a Claude routine's fire endpoint directly: the endpoint needs an `Authorization: Bearer` header and a `{"text": "..."}` body. This Worker verifies the webhook signature, drops events the routine doesn't act on, and posts the rest to the routine.

## Setup

### Create a Claude routine

Create one at [claude.ai/code/routines](https://claude.ai/code/routines). The UI may call it a scheduled task. The prompt is what the run does; this Worker only decides whether to fire it. Keep the prompt's keywords, labels, and assignees in sync with `wrangler.jsonc`.

Edit the routine and add an API trigger. Copy the Fire URL. That is `ROUTINE_FIRE_URL`, shaped like `https://api.anthropic.com/v1/claude_code/routines/<trigger id>/fire`.

Generate a token and copy it, that is `ROUTINE_TOKEN`.

Pick a webhook secret yourself, then upload all three values as Worker secrets:

```sh
bunx wrangler secret put ROUTINE_FIRE_URL
bunx wrangler secret put ROUTINE_TOKEN
bunx wrangler secret put GITHUB_WEBHOOK_SECRET
```

### Add GitHub webhooks

On each repo, or once per org in `ALLOWED_OWNERS`, add a webhook:

- Payload URL: `https://github-claude-webhook-bridge.xxxxx.workers.dev`
- Content type: `application/json`
- Secret: the same value as `GITHUB_WEBHOOK_SECRET`

Subscribe only to these events:

- [`issue_comment`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment)
- [`issues`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issues)
- [`pull_request`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request)

```sh
gh api --method POST orgs/ORG/hooks \
  -f name=web -F active=true \
  -f config[url]='https://github-claude-webhook-bridge.xxxxx.workers.dev' \
  -f config[content_type]=json \
  -f config[secret]="$GITHUB_WEBHOOK_SECRET" \
  -f events[]=issue_comment -f events[]=issues -f events[]=pull_request
```

Use `repos/OWNER/REPO/hooks` for a single repository.

### Set `vars` in `wrangler.jsonc`

These lists are what the Worker actually forwards. Anything else is dropped.

| Var                | Forwards when                                                    |
| ------------------ | ---------------------------------------------------------------- |
| `ALLOWED_OWNERS`   | The repository owner is in the list                              |
| `COMMENT_KEYWORDS` | An `issue_comment` is created with that word, or an edit adds it |
| `LABELS`           | An `issues` or `pull_request` event adds that label              |
| `ASSIGNEES`        | An `issues` or `pull_request` event assigns that login           |
| `IGNORED_SENDERS`  | Never. Stops the bot from triggering itself                      |

`pull_request` `opened` is always forwarded, including drafts. Bots are dropped. Pull requests opened from forks are dropped; comments on those PRs are not.

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
