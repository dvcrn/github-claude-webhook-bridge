import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import worker, {
  type Filters,
  mentions,
  parseRoutines,
  routineText,
  skipReason as rawSkipReason,
  verifySignature,
} from "../src/index";

// Most cases are about event filtering, so default to a repository from an allowed owner.
const repository = { owner: { login: "dvcrn" } };
const skipReason = (event: string, payload: object, f: Filters) => rawSkipReason(event, { repository, ...payload }, f);
const bytes = (s: string) => new TextEncoder().encode(s);

describe("verifySignature", () => {
  // Test vector from https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
  const secret = "It's a Secret to Everybody";
  const body = "Hello, World!";
  const good = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  test("accepts GitHub's documented vector", async () => {
    expect(await verifySignature(secret, bytes(body), good)).toBe(true);
  });
  test("rejects tampered body, wrong secret, and malformed headers", async () => {
    expect(await verifySignature(secret, bytes(body + "!"), good)).toBe(false);
    expect(await verifySignature("nope", bytes(body), good)).toBe(false);
    expect(await verifySignature(secret, bytes(body), null)).toBe(false);
    expect(await verifySignature(secret, bytes(body), "sha1=abc")).toBe(false);
  });
  test("rejects everything when the secret is unset", async () => {
    expect(await verifySignature("", bytes(body), good)).toBe(false);
    expect(await verifySignature(undefined as unknown as string, bytes(body), good)).toBe(false);
  });
});

describe("routineText", () => {
  // Trimmed real-shape payload: the noise fields below must not reach the routine.
  const noise = { node_id: "X", avatar_url: "https://avatars", reactions: { total_count: 0 } };
  const user = (login: string) => ({ login, ...noise });

  test("issue_comment on a PR keeps only the fields the routine needs", () => {
    const payload = {
      action: "edited",
      repository: { full_name: "dvcrn/zot", ...noise },
      sender: user("david"),
      changes: { body: { from: "go" } },
      issue: {
        number: 42,
        title: "Fix it",
        html_url: "https://github.com/dvcrn/zot/pull/42",
        user: user("alice"),
        author_association: "CONTRIBUTOR",
        state: "open",
        labels: [{ name: "bug", color: "f00" }],
        assignees: [user("boticorn")],
        pull_request: { url: "https://api.github.com/..." },
        body: "PR body",
        ...noise,
      },
      comment: {
        id: 7,
        user: user("david"),
        author_association: "OWNER",
        html_url: "https://github.com/dvcrn/zot/pull/42#c7",
        body: "@boticorn go",
        ...noise,
      },
    };
    const text = routineText("issue_comment", "abc", payload);
    const [header, ...json] = text.split("\n");
    expect(header).toBe("X-GitHub-Event: issue_comment");
    expect(JSON.parse(json.join("\n"))).toEqual({
      delivery: "abc",
      action: "edited",
      repository: "dvcrn/zot",
      sender: "david",
      issue: {
        number: 42,
        is_pull_request: true,
        title: "Fix it",
        url: "https://github.com/dvcrn/zot/pull/42",
        state: "open",
        author: "alice",
        author_association: "CONTRIBUTOR",
        labels: ["bug"],
        assignees: ["boticorn"],
        body: "PR body",
      },
      comment: {
        id: 7,
        url: "https://github.com/dvcrn/zot/pull/42#c7",
        author: "david",
        author_association: "OWNER",
        body: "@boticorn go",
        previous_body: "go",
      },
    });
    expect(text).not.toContain("avatar");
  });

  test("pull_request labeled includes branches and the added label", () => {
    const payload = {
      action: "labeled",
      label: { name: "boticorn-review", color: "0f0" },
      repository: { full_name: "dvcrn/zot" },
      sender: user("david"),
      pull_request: {
        number: 5,
        title: "Add X",
        html_url: "https://github.com/dvcrn/zot/pull/5",
        state: "open",
        draft: true,
        user: user("david"),
        labels: [{ name: "boticorn-review" }],
        assignees: [],
        head: { ref: "feat", sha: "aaa", repo: { full_name: "dvcrn/zot", ...noise } },
        base: { ref: "main", sha: "bbb", repo: { full_name: "dvcrn/zot" } },
        body: null,
      },
    };
    const slim = JSON.parse(routineText("pull_request", "d", payload).split("\n").slice(1).join("\n"));
    expect(slim.label).toBe("boticorn-review");
    expect(slim.issue).toBeUndefined();
    expect(slim.pull_request).toMatchObject({
      number: 5,
      draft: true,
      head: { ref: "feat", sha: "aaa", repo: "dvcrn/zot" },
      base: { ref: "main", sha: "bbb" },
      body: null,
    });
    expect(slim.pull_request.is_pull_request).toBeUndefined();
  });
});

describe("mentions", () => {
  test("matches whole handle only", () => {
    expect(mentions("hey @boticorn fix this", "@boticorn")).toBe(true);
    expect(mentions("@BotiCorn, please", "@boticorn")).toBe(true);
    expect(mentions("@boticorn-dev", "@boticorn")).toBe(false);
    expect(mentions("me@boticorn.com", "@boticorn")).toBe(false);
    expect(mentions("no handle", "@boticorn")).toBe(false);
    expect(mentions("npm i @boticorn/cli", "@boticorn")).toBe(false);
    expect(mentions("see npmjs.com/package/@boticorn", "@boticorn")).toBe(false);
  });
});

describe("skipReason", () => {
  const f: Filters = {
    ALLOWED_OWNERS: ["dvcrn", "digitalvibeshq", "microfnhq"],
    ALLOWED_ACTORS: ["dvcrn"],
    COMMENT_KEYWORDS: ["@boticorn"],
    LABELS: ["boticorn-review"],
    ASSIGNEES: ["boticorn"],
    IGNORED_SENDERS: ["boticorn", "boticorn[bot]"],
  };
  const sender = { login: "dvcrn" };
  const stranger = { login: "stranger" };
  const comment = (body: string, action = "created", login = "dvcrn", author = login) => ({
    action,
    comment: { body, user: { login: author } },
    sender: { login },
  });

  test("drops repositories outside the allowed owners", () => {
    const pr = (owner?: string) => ({ action: "opened", sender, repository: owner ? { owner: { login: owner } } : undefined });
    expect(skipReason("pull_request", pr("MicrofnHQ"), f)).toBeUndefined();
    expect(skipReason("pull_request", pr("someone-else"), f)).toBe("owner not allowed");
    expect(skipReason("pull_request", pr(), f)).toBe("owner not allowed");
  });
  test("issue_comment: forwards keyword comments from allowed actors only", () => {
    expect(skipReason("issue_comment", comment("@boticorn go"), f)).toBeUndefined();
    expect(skipReason("issue_comment", comment("lgtm"), f)).toBe("no keyword");
    expect(skipReason("issue_comment", comment("@boticorn", "deleted"), f)).toBe("action deleted");
    expect(skipReason("issue_comment", comment("@boticorn go", "created", "stranger"), f)).toBe("actor not allowed");
  });
  test("issue_comment: requires both the sender and the comment author to be allowed", () => {
    const edit = (login: string, author: string) => ({
      ...comment("@boticorn go", "edited", login, author),
      changes: { body: { from: "go" } },
    });
    expect(skipReason("issue_comment", edit("dvcrn", "dvcrn"), f)).toBeUndefined();
    expect(skipReason("issue_comment", edit("dvcrn", "stranger"), f)).toBe("actor not allowed");
    expect(skipReason("issue_comment", edit("stranger", "dvcrn"), f)).toBe("actor not allowed");
    expect(skipReason("issue_comment", { action: "created", comment: { body: "@boticorn" }, sender }, f)).toBe(
      "actor not allowed",
    );
  });
  test("issue_comment: forwards edits only when they add a keyword", () => {
    const edit = (from: string) => ({ ...comment("@boticorn go", "edited"), changes: { body: { from } } });
    expect(skipReason("issue_comment", edit("go"), f)).toBeUndefined();
    expect(skipReason("issue_comment", edit("@boticorn gp"), f)).toBe("keyword already present");
  });
  test("matches actors case-insensitively, with or without a leading @", () => {
    for (const actors of [["dvcrn"], ["@dvcrn"], ["DVCRN"], ["@DvCrN"]]) {
      const g = { ...f, ALLOWED_ACTORS: actors };
      expect(skipReason("issue_comment", comment("@boticorn go", "created", "DvCrn"), g)).toBeUndefined();
      expect(
        skipReason("issues", { action: "labeled", label: { name: "boticorn-review" }, sender }, g),
      ).toBeUndefined();
      expect(skipReason("issue_comment", comment("@boticorn go", "created", "dvcrn2"), g)).toBe("actor not allowed");
    }
  });
  test("drops ignored senders but not similar names", () => {
    expect(skipReason("issue_comment", comment("@boticorn", "created", "boticorn[bot]"), f)).toBe("ignored sender");
    expect(skipReason("pull_request", { action: "opened", sender: { login: "boticornfan" } }, f)).toBeUndefined();
  });
  test("drops bot senders by type or [bot] suffix", () => {
    const opened = (s: object) => ({ action: "opened", sender: s });
    expect(skipReason("pull_request", opened({ login: "dependabot[bot]", type: "Bot" }), f)).toBe("bot sender");
    expect(skipReason("pull_request", opened({ login: "renovate[BOT]" }), f)).toBe("bot sender");
    expect(skipReason("pull_request", opened({ login: "some-app", type: "Bot" }), f)).toBe("bot sender");
    // A bot is dropped even when its login is listed as an actor.
    const g = { ...f, ALLOWED_ACTORS: ["helper[bot]"] };
    expect(skipReason("issue_comment", comment("@boticorn go", "created", "helper[bot]"), g)).toBe("bot sender");
  });
  test("pull_request opened is forwarded for any author, forks included; issues opened is not", () => {
    expect(skipReason("pull_request", { action: "opened", sender }, f)).toBeUndefined();
    expect(skipReason("pull_request", { action: "opened", sender: stranger }, f)).toBeUndefined();
    const fork = (head: { full_name: string } | null) => ({
      action: "opened",
      sender: stranger,
      pull_request: { head: { repo: head }, base: { repo: { full_name: "dvcrn/zot" } } },
    });
    expect(skipReason("pull_request", fork({ full_name: "stranger/zot" }), f)).toBeUndefined();
    expect(skipReason("pull_request", fork(null), f)).toBeUndefined();
    expect(skipReason("issues", { action: "opened", sender }, f)).toBe("action opened");
  });
  test("tolerates missing filter lists", () => {
    const broken = { ...f, LABELS: undefined, COMMENT_KEYWORDS: undefined } as unknown as Filters;
    expect(skipReason("issues", { action: "labeled", label: { name: "boticorn-review" }, sender }, broken)).toBe(
      "label not watched",
    );
    expect(skipReason("issue_comment", comment("@boticorn go"), broken)).toBe("no keyword");
    const noActors = { ...f, ALLOWED_ACTORS: undefined } as unknown as Filters;
    expect(skipReason("issue_comment", comment("@boticorn go"), noActors)).toBe("actor not allowed");
  });
  test("labeled: forwards watched labels on issues and PRs from allowed actors", () => {
    for (const event of ["issues", "pull_request"]) {
      expect(skipReason(event, { action: "labeled", label: { name: "Boticorn-Review" }, sender }, f)).toBeUndefined();
      expect(skipReason(event, { action: "labeled", label: { name: "bug" }, sender }, f)).toBe("label not watched");
      expect(skipReason(event, { action: "labeled", label: { name: "boticorn-review" }, sender: stranger }, f)).toBe(
        "actor not allowed",
      );
    }
  });
  test("assigned: forwards watched assignees on issues and PRs from allowed actors", () => {
    for (const event of ["issues", "pull_request"]) {
      expect(skipReason(event, { action: "assigned", assignee: { login: "boticorn" }, sender }, f)).toBeUndefined();
      expect(skipReason(event, { action: "assigned", assignee: { login: "dvcrn" }, sender }, f)).toBe(
        "assignee not watched",
      );
      expect(skipReason(event, { action: "assigned", assignee: { login: "boticorn" }, sender: stranger }, f)).toBe(
        "actor not allowed",
      );
    }
  });
  test("drops other actions and events", () => {
    expect(skipReason("pull_request", { action: "synchronize", sender }, f)).toBe("action synchronize");
    expect(skipReason("issues", { action: "unlabeled", label: { name: "boticorn-review" }, sender }, f)).toBe(
      "action unlabeled",
    );
    expect(skipReason("pull_request_review", { action: "submitted", sender }, f)).toBe("event pull_request_review");
    expect(skipReason("ping", { sender }, f)).toBe("event ping");
  });
});

describe("parseRoutines", () => {
  test("accepts a map of route name to url and token", () => {
    const raw = JSON.stringify({ foo: { url: "https://a/fire", token: "t1" }, bar: { url: "https://b/fire", token: "t2" } });
    expect(parseRoutines(raw)).toEqual({ foo: { url: "https://a/fire", token: "t1" }, bar: { url: "https://b/fire", token: "t2" } });
  });
  test("rejects malformed JSON and shapes", () => {
    expect(parseRoutines(undefined)).toBeUndefined();
    expect(parseRoutines("{")).toBeUndefined();
    expect(parseRoutines("[]")).toBeUndefined();
    expect(parseRoutines('"foo"')).toBeUndefined();
    expect(parseRoutines(JSON.stringify({ foo: { url: "https://a/fire" } }))).toBeUndefined();
    expect(parseRoutines(JSON.stringify({ foo: { url: 1, token: "t" } }))).toBeUndefined();
    expect(parseRoutines(JSON.stringify({ foo: null }))).toBeUndefined();
  });
});

describe("fetch", () => {
  const secret = "s3cret";
  const env = {
    ALLOWED_OWNERS: ["dvcrn"],
    COMMENT_KEYWORDS: [],
    LABELS: [],
    ASSIGNEES: [],
    IGNORED_SENDERS: [],
    GITHUB_WEBHOOK_SECRET: secret,
    ROUTINES: JSON.stringify({ foo: { url: "https://a/fire", token: "t1" }, bar: { url: "https://b/fire", token: "t2" } }),
  } as unknown as Env;
  const body = JSON.stringify({
    action: "opened",
    repository: { full_name: "dvcrn/zot", owner: { login: "dvcrn" } },
    sender: { login: "david" },
    pull_request: { number: 1, head: { repo: { full_name: "dvcrn/zot" } }, base: { repo: { full_name: "dvcrn/zot" } } },
  });

  async function deliver(path: string, e: Env = env): Promise<Response> {
    const key = await crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, bytes(body))).toString("hex");
    const req = new Request(`https://bridge.test${path}`, {
      method: "POST",
      headers: { "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": `sha256=${sig}` },
      body,
    });
    return worker.fetch(req, e);
  }

  const realFetch = globalThis.fetch;
  const fetchMock = mock(async (_url: string | URL | Request, _init?: RequestInit) => new Response("ok"));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  afterEach(() => fetchMock.mockClear());
  afterAll(() => (globalThis.fetch = realFetch));

  test("forwards each route to its own routine and token", async () => {
    for (const [route, url, token] of [
      ["foo", "https://a/fire", "t1"],
      ["bar", "https://b/fire", "t2"],
    ]) {
      fetchMock.mockClear();
      expect((await deliver(`/webhook/${route}`)).status).toBe(200);
      const [calledUrl, init] = fetchMock.mock.calls[0]!;
      expect(calledUrl).toBe(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    }
  });
  test("404s unknown paths and route names without forwarding", async () => {
    expect((await deliver("/")).status).toBe(404);
    expect((await deliver("/webhook/baz")).status).toBe(404);
    expect((await deliver("/webhook/toString")).status).toBe(404);
    expect((await deliver("/webhook/foo/extra")).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test("500s when ROUTINES is malformed", async () => {
    expect((await deliver("/webhook/foo", { ...env, ROUTINES: "nope" })).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
