import { describe, expect, test } from "bun:test";
import { type Filters, mentions, routineText, skipReason as rawSkipReason, verifySignature } from "../src/index";

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
    COMMENT_KEYWORDS: ["@boticorn"],
    LABELS: ["boticorn-review"],
    ASSIGNEES: ["boticorn"],
    IGNORED_SENDERS: ["boticorn", "boticorn[bot]"],
  };
  const sender = { login: "david" };
  const comment = (body: string, action = "created", login = "david") => ({
    action,
    comment: { body },
    sender: { login },
  });

  test("drops repositories outside the allowed owners", () => {
    const pr = (owner?: string) => ({ action: "opened", sender, repository: owner ? { owner: { login: owner } } : undefined });
    expect(skipReason("pull_request", pr("MicrofnHQ"), f)).toBeUndefined();
    expect(skipReason("pull_request", pr("someone-else"), f)).toBe("owner not allowed");
    expect(skipReason("pull_request", pr(), f)).toBe("owner not allowed");
  });
  test("issue_comment: forwards keyword comments only", () => {
    expect(skipReason("issue_comment", comment("@boticorn go"), f)).toBeUndefined();
    expect(skipReason("issue_comment", comment("lgtm"), f)).toBe("no keyword");
    expect(skipReason("issue_comment", comment("@boticorn", "deleted"), f)).toBe("action deleted");
  });
  test("issue_comment: forwards edits only when they add a keyword", () => {
    const edit = (from: string) => ({ ...comment("@boticorn go", "edited"), changes: { body: { from } } });
    expect(skipReason("issue_comment", edit("go"), f)).toBeUndefined();
    expect(skipReason("issue_comment", edit("@boticorn gp"), f)).toBe("keyword already present");
  });
  test("drops ignored senders but not similar names", () => {
    expect(skipReason("issue_comment", comment("@boticorn", "created", "boticorn[bot]"), f)).toBe("ignored sender");
    expect(skipReason("issue_comment", comment("@boticorn", "created", "boticornfan"), f)).toBeUndefined();
  });
  test("drops bots and fork pull requests", () => {
    const bot = { login: "dependabot[bot]", type: "Bot" };
    expect(skipReason("pull_request", { action: "opened", sender: bot }, f)).toBe("bot sender");
    const pr = (head: string) => ({
      action: "opened",
      sender,
      pull_request: { head: { repo: { full_name: head } }, base: { repo: { full_name: "dvcrn/zot" } } },
    });
    expect(skipReason("pull_request", pr("stranger/zot"), f)).toBe("fork pull request");
    expect(skipReason("pull_request", pr("dvcrn/zot"), f)).toBeUndefined();
  });
  test("tolerates missing filter lists", () => {
    const broken = { ...f, LABELS: undefined } as unknown as Filters;
    expect(skipReason("issues", { action: "labeled", label: { name: "boticorn-review" }, sender }, broken)).toBe(
      "label not watched",
    );
  });
  test("pull_request opened is always forwarded; issues opened is not", () => {
    expect(skipReason("pull_request", { action: "opened", sender }, f)).toBeUndefined();
    expect(skipReason("issues", { action: "opened", sender }, f)).toBe("action opened");
  });
  test("labeled: forwards watched labels on issues and PRs", () => {
    for (const event of ["issues", "pull_request"]) {
      expect(skipReason(event, { action: "labeled", label: { name: "Boticorn-Review" }, sender }, f)).toBeUndefined();
      expect(skipReason(event, { action: "labeled", label: { name: "bug" }, sender }, f)).toBe("label not watched");
    }
  });
  test("assigned: forwards watched assignees on issues and PRs", () => {
    for (const event of ["issues", "pull_request"]) {
      expect(skipReason(event, { action: "assigned", assignee: { login: "boticorn" }, sender }, f)).toBeUndefined();
      expect(skipReason(event, { action: "assigned", assignee: { login: "david" }, sender }, f)).toBe(
        "assignee not watched",
      );
    }
  });
  test("drops other actions and events", () => {
    expect(skipReason("pull_request", { action: "synchronize", sender }, f)).toBe("action synchronize");
    expect(skipReason("issues", { action: "unlabeled", label: { name: "boticorn-review" }, sender }, f)).toBe(
      "action unlabeled",
    );
    expect(skipReason("ping", { sender }, f)).toBe("event ping");
  });
});
