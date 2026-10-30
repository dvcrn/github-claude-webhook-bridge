// Forwards GitHub webhook deliveries to a Claude Code routine fire endpoint.

export interface Filters {
  ALLOWED_OWNERS: readonly string[];
  ALLOWED_ACTORS: readonly string[];
  COMMENT_KEYWORDS: readonly string[];
  LABELS: readonly string[];
  ASSIGNEES: readonly string[];
  IGNORED_SENDERS: readonly string[];
}

// Only the payload fields this worker reads; GitHub sends many more.
interface User {
  login?: string;
  type?: string;
}

interface Repo {
  full_name?: string;
  owner?: User;
}

interface GitRef {
  ref?: string;
  sha?: string;
  repo?: Repo | null;
}

// Covers both `issue` and `pull_request`. On an issue, `pull_request` is only a link object.
interface Item {
  number?: number;
  title?: string;
  html_url?: string;
  state?: string;
  draft?: boolean;
  user?: User | null;
  author_association?: string;
  labels?: { name?: string }[];
  assignees?: User[];
  pull_request?: object;
  head?: GitRef;
  base?: GitRef;
  body?: string | null;
}

export interface WebhookPayload {
  action?: string;
  repository?: Repo;
  sender?: User;
  label?: { name?: string };
  assignee?: User | null;
  issue?: Item;
  pull_request?: Item;
  comment?: {
    id?: number;
    html_url?: string;
    user?: User | null;
    author_association?: string;
    body?: string | null;
  };
  changes?: { body?: { from?: string } };
}

const ROUTINE_HEADERS = {
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "experimental-cc-routine-2026-04-01",
  "Content-Type": "application/json",
};
// GitHub abandons a delivery after 10 seconds, so give up just before it does.
const ROUTINE_TIMEOUT_MS = 9_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

    const payload = parsePayload(raw);
    if (!payload) return new Response("expected a JSON object payload", { status: 400 });

    const skip = skipReason(event, payload, env);
    if (skip) {
      log("skipped", { event, delivery, action: payload.action, reason: skip });
      return new Response(`skipped: ${skip}`, { status: 202 });
    }

    try {
      const res = await fetch(env.ROUTINE_FIRE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.ROUTINE_TOKEN}`, ...ROUTINE_HEADERS },
        body: JSON.stringify({ text: routineText(event, delivery, payload) }),
        signal: AbortSignal.timeout(ROUTINE_TIMEOUT_MS),
      });
      const detail = await res.text();
      log("forwarded", { event, delivery, action: payload.action, status: res.status });

      // A non-2xx reply makes the failure visible in GitHub's Recent Deliveries and allows redelivery.
      return new Response(detail, { status: res.ok ? 200 : 502 });
    } catch (err) {
      log("forward_failed", { event, delivery, action: payload.action, error: String(err) });
      return new Response("routine request failed", { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;

function parsePayload(raw: Uint8Array): WebhookPayload | undefined {
  try {
    const value: unknown = JSON.parse(decoder.decode(raw));
    return typeof value === "object" && value !== null ? (value as WebhookPayload) : undefined;
  } catch {
    return undefined;
  }
}

// Returns why a delivery is dropped, or undefined when it should reach the routine.
export function skipReason(event: string, payload: WebhookPayload, f: Filters): string | undefined {
  if (!includesName(f.ALLOWED_OWNERS, payload.repository?.owner?.login)) return "owner not allowed";
  const sender = payload.sender;
  if (includesName(f.IGNORED_SENDERS, sender?.login)) return "ignored sender";
  if (sender?.type === "Bot" || nameKey(sender?.login).endsWith("[bot]")) return "bot sender";
  const isActor = (user?: User | null) => includesName(f.ALLOWED_ACTORS, user?.login, loginKey);
  const action = payload.action;

  switch (event) {
    case "issue_comment": {
      if (action !== "created" && action !== "edited") return `action ${action}`;
      // On an edit the sender is the editor, so an allowed actor can't relay someone else's comment.
      if (!isActor(sender) || !isActor(payload.comment?.user)) return "actor not allowed";
      const keywords = Array.isArray(f.COMMENT_KEYWORDS) ? f.COMMENT_KEYWORDS : [];
      const matched = keywords.filter((k) => mentions(payload.comment?.body ?? "", k));
      if (matched.length === 0) return "no keyword";
      // Edits fire only when they add a keyword, so fixing a typo doesn't re-run the routine.
      if (action === "edited" && matched.every((k) => mentions(payload.changes?.body?.from ?? "", k))) {
        return "keyword already present";
      }
      return undefined;
    }

    case "issues":
    case "pull_request":
      // Opened PRs skip the actor check, so any non-bot author, forks included, is forwarded.
      if (event === "pull_request" && action === "opened") return undefined;
      if (action !== "labeled" && action !== "assigned") return `action ${action}`;
      if (!isActor(sender)) return "actor not allowed";
      if (action === "labeled") return includesName(f.LABELS, payload.label?.name) ? undefined : "label not watched";
      return includesName(f.ASSIGNEES, payload.assignee?.login) ? undefined : "assignee not watched";

    default:
      return `event ${event}`;
  }
}

// The routine's input: the event name, then only the payload fields it acts on.
export function routineText(event: string, delivery: string | null, payload: WebhookPayload): string {
  return `X-GitHub-Event: ${event}\n${JSON.stringify(slimPayload(delivery, payload), null, 2)}`;
}

// Undefined fields are omitted by JSON.stringify, so absent parts of the payload simply don't appear.
export function slimPayload(delivery: string | null, p: WebhookPayload): object {
  const pr = p.pull_request;
  const target = pr ?? p.issue;
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
      labels: target.labels?.map((l) => l.name),
      assignees: target.assignees?.map((a) => a.login),
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

const nameKey = (s: unknown) => String(s ?? "").toLowerCase();
// Config entries may be written as GitHub mentions, so "@dvcrn" matches the login "dvcrn".
const loginKey = (s: unknown) => nameKey(s).replace(/^@/, "");

// A missing or non-array list matches nothing, so a broken ALLOWED_OWNERS drops everything.
function includesName(list: readonly string[] | undefined, name: unknown, key = nameKey): boolean {
  const n = key(name);
  return n !== "" && Array.isArray(list) && list.some((x) => key(x) === n);
}

export function mentions(text: string, mention: string): boolean {
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `/` is excluded so paths and scoped packages such as `@boticorn/cli` don't count as mentions.
  return new RegExp(`(^|[^\\w/-])${escaped}(?![\\w/-])`, "i").test(text);
}

export async function verifySignature(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  // An unset secret would otherwise become the HMAC key "undefined", which anyone could sign with.
  if (!secret) return false;
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
