// Forwards GitHub webhook deliveries to a Claude Code routine fire endpoint.

export interface Filters {
  ALLOWED_OWNERS: readonly string[];
  COMMENT_KEYWORDS: readonly string[];
  LABELS: readonly string[];
  ASSIGNEES: readonly string[];
  IGNORED_SENDERS: readonly string[];
}

const encoder = new TextEncoder();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
    }

    const event = request.headers.get("X-GitHub-Event");
    const delivery = request.headers.get("X-GitHub-Delivery");
    const signature = request.headers.get("X-Hub-Signature-256");
    // The signature covers the exact bytes GitHub sent, so verify before decoding.
    const raw = new Uint8Array(await request.arrayBuffer());

    if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, raw, signature))) {
      log("rejected", { event, delivery });
      return new Response("invalid signature", { status: 401 });
    }
    if (!event) return new Response("missing X-GitHub-Event", { status: 400 });

    const body = new TextDecoder().decode(raw);
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("expected application/json payload", { status: 400 });
    }
    const skip = skipReason(event, payload, env);
    if (skip) {
      log("skipped", { event, delivery, action: payload.action, reason: skip });
      return new Response(`skipped: ${skip}`, { status: 202 });
    }

    const text = routineText(event, delivery, payload);
    const res = await fetch(env.ROUTINE_FIRE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ROUTINE_TOKEN}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    const detail = await res.text();
    log("forwarded", { event, delivery, action: payload.action, status: res.status });

    // A non-2xx reply makes the failure visible in GitHub's Recent Deliveries and allows redelivery.
    return new Response(detail, { status: res.ok ? 200 : 502 });
  },
} satisfies ExportedHandler<Env>;

// Returns why a delivery is dropped, or undefined when it should reach the routine.
export function skipReason(event: string, payload: any, f: Filters): string | undefined {
  if (!includesName(f.ALLOWED_OWNERS, payload.repository?.owner?.login)) return "owner not allowed";
  if (includesName(f.IGNORED_SENDERS, payload.sender?.login)) return "ignored sender";
  // The routine skips bots (including Dependabot) and fork PRs, so don't spend a run on them.
  if (payload.sender?.type === "Bot") return "bot sender";
  const pr = payload.pull_request;
  if (pr?.head?.repo && pr.head.repo.full_name !== pr.base?.repo?.full_name) return "fork pull request";
  const action = payload.action;

  if (event === "issue_comment") {
    if (action !== "created" && action !== "edited") return `action ${action}`;
    const matched = f.COMMENT_KEYWORDS.filter((k) => mentions(payload.comment?.body ?? "", k));
    if (matched.length === 0) return "no keyword";
    // Edits fire only when they add a keyword, so fixing a typo doesn't re-run the routine.
    if (action === "edited" && matched.every((k) => mentions(payload.changes?.body?.from ?? "", k))) {
      return "keyword already present";
    }
    return undefined;
  }

  if (event === "issues" || event === "pull_request") {
    if (action === "opened" && event === "pull_request") return undefined;
    if (action === "labeled") return includesName(f.LABELS, payload.label?.name) ? undefined : "label not watched";
    if (action === "assigned") {
      return includesName(f.ASSIGNEES, payload.assignee?.login) ? undefined : "assignee not watched";
    }
    return `action ${action}`;
  }

  return `event ${event}`;
}

// The routine's input: the event name, then only the payload fields it acts on.
export function routineText(event: string, delivery: string | null, payload: any): string {
  return `X-GitHub-Event: ${event}\n${JSON.stringify(slimPayload(delivery, payload), null, 2)}`;
}

// Undefined fields are omitted by JSON.stringify, so absent parts of the payload simply don't appear.
export function slimPayload(delivery: string | null, p: any): object {
  const names = (list: any[] | undefined, key: string) => list?.map((x) => x[key]);
  const target = p.pull_request ?? p.issue;
  const pr = p.pull_request;
  return {
    delivery: delivery ?? undefined,
    action: p.action,
    repository: p.repository?.full_name,
    sender: p.sender?.login,
    label: p.label?.name,
    assignee: p.assignee?.login,
    [pr ? "pull_request" : "issue"]: target && {
      number: target.number,
      // issue_comment events on a PR carry the PR as an `issue` with a `pull_request` link.
      is_pull_request: pr ? undefined : Boolean(target.pull_request),
      title: target.title,
      url: target.html_url,
      state: target.state,
      draft: target.draft,
      author: target.user?.login,
      author_association: target.author_association,
      labels: names(target.labels, "name"),
      assignees: names(target.assignees, "login"),
      head: pr && { ref: pr.head?.ref, sha: pr.head?.sha, repo: pr.head?.repo?.full_name },
      base: pr && { ref: pr.base?.ref, sha: pr.base?.sha },
      body: target.body,
    },
    comment: p.comment && {
      id: p.comment.id,
      url: p.comment.html_url,
      author: p.comment.user?.login,
      author_association: p.comment.author_association,
      body: p.comment.body,
      previous_body: p.changes?.body?.from,
    },
  };
}

// A missing or non-array list matches nothing, so a broken ALLOWED_OWNERS drops everything.
function includesName(list: readonly string[] | undefined, name: unknown): boolean {
  const n = String(name ?? "").toLowerCase();
  return n !== "" && Array.isArray(list) && list.some((x) => String(x).toLowerCase() === n);
}

export function mentions(text: string, mention: string): boolean {
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `/` is excluded so paths and scoped packages such as `@boticorn/cli` don't count as mentions.
  return new RegExp(`(^|[^\\w-/])${escaped}(?![\\w-/])`, "i").test(text);
}

export async function verifySignature(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  const hex = header?.match(/^sha256=([0-9a-f]{64})$/i)?.[1];
  if (!hex) return false;
  const sig = new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  // subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", key, sig, body);
}

function log(msg: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ msg, ...fields }));
}
