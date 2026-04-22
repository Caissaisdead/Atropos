# atropos — implementation plan

> Named for Atropos, the Fate who cuts the thread. Greek *a-tropos*, "unturnable." What she did to lives, this tool does to dead commits — final, but here, recoverable.

## 0. What this document is

An implementation plan for `atropos`, a CLI that reshapes messy agent-authored git history into clean, reviewable commits. It is opinionated. Where the previous plan kept decisions open, this one picks. Where it punted detail, this one fills in. Read disagreements as things to push back on, not things already decided.

The plan is in four layers:
1. **§1–§4** — what we're building and for whom.
2. **§5–§13** — how it works, in enough detail to implement without inventing.
3. **§14–§16** — how we build and verify it.
4. **§17–§19** — risks, answered open questions, and reference material.

---

## 1. The problem, concretely

A typical Claude Code session that adds one HTTP endpoint produces something like this in `git log`:

```
a1b2c3  update handler to use new config shape
b2c3d4  wip
c3d4e5  try alternate approach with middleware
d4e5f6  revert middleware, doesn't work
e5f6g7  fix typo in handler
f6g7h8  add /invoices endpoint
g7h8i9  also update tests
h8i9j0  fix test env var
i9j0k1  🤖 Generated with Claude Code
```

Nine commits for what a human would ship as two:

```
feat(api): add /invoices endpoint
test(api): cover /invoices happy + error paths
```

The reshape is mechanical. With `git rebase -i` it takes ~15 minutes. A developer who delegated the *writing* now also has to delegate the *cleanup* — or give back the time savings. `atropos` is that cleanup delegate.

The shape of the mess is mechanical too, which is why this is tractable:

- **Turn-boundary commits, not thought-boundary commits.** Commits reflect agent execution cadence.
- **Backtracking leaves scars.** Dead approaches are committed before being reverted.
- **`git add -A` everywhere.** Typos, config tweaks, and unrelated touches absorb into whichever commit is active.
- **Diff-describing messages.** "update handler to use new config shape" instead of "fix crash on missing env var."
- **Attribution noise.** `Co-authored-by: Claude`, `🤖 Generated with Claude Code`, bot committer emails.

None of this requires cleverness to detect. It requires a disciplined pipeline.

---

## 2. Non-negotiables

These are invariants, not principles to be weighed. A build that violates any of them is broken.

1. **Tree equality.** The tree at the tip of a reshaped branch must byte-match the tree at the original tip. Always.
2. **Reversibility.** Every mutation is preceded by a backup branch. `atropos restore` returns to pre-mutation state with no loss.
3. **No silent network.** Nothing leaves the machine without an explicit user action. `--no-cloud` skips the network entirely.
4. **No silent identity writes.** Every author/committer change and every stripped trailer is listed in the plan before apply.
5. **No push without `--force-push`.** No push at all without it. Default tooling ends at a local ref update.
6. **No touching pushed commits** without `--rewrite-pushed`. Verified by consulting every remote-tracking ref, not just `@{upstream}`.

Everything else is a choice. These six are not.

---

## 3. Scope

### 3.1 v1 ships

- Range reshape — default `@{upstream}..HEAD`, falls back to `main..HEAD` / `master..HEAD` / asks.
- File-level dead-path detection.
- Whole-commit clustering: 1 original commit → 1 new commit.
- LLM-driven cluster assignment via Anthropic API (default model: Claude Sonnet 4.6).
- Heuristic fallback when `--no-cloud` or API unavailable.
- Authorship normalization — agent trailers and bot committers stripped, visible in plan.
- Conventional Commits output format.
- `.atropos/plan.md` — generated, human-editable, re-parsed on apply.
- `atropos apply` — cherry-pick-and-squash, backup branch, tree-equality gate.
- `atropos restore` — revert to most recent backup.
- `atropos apply --dry-run` — print the git commands without running them.
- macOS and Linux. Windows via WSL only.

### 3.2 v1 does not ship

- Hunk-level splitting. One commit always stays one commit.
- Conflict-resolution assistance. v1 aborts on conflict and invokes rollback.
- TUI / web plan editor.
- Monorepo scope inference.
- Non-Anthropic LLM providers. Plug point exists; only Anthropic wired in.
- Submodules, LFS, worktrees — detected and refused with a clear error.
- Windows-native support.

### 3.3 Never

- Automatic push. A flag per invocation, always.
- Rewriting commits outside the requested range.
- Silent authorship changes.

---

## 4. User journey

**First run** (plan):

```
$ cd repo
$ atropos
Reading commits a1b2c3..HEAD (9 commits)…
Dead-path analysis: 4 dead-in-range files, 2 full-drop commits.
Clustering 7 surviving commits… 8.4s, 3,204 tokens ($0.01).
Wrote plan to .atropos/plan.md.

9 commits → 2 commits (2 dropped, 5 merged).
Review the plan, then: atropos apply
```

The user opens `.atropos/plan.md`, reads the proposed commits, edits commit 2's subject, saves.

**Second run** (apply):

```
$ atropos apply
Parsing .atropos/plan.md… ok.
Validating against current HEAD… ok (HEAD unchanged since plan generated).
Creating backup: atropos/backup-2026-04-21T14-32-00Z
Reshaping onto scratch branch…
  [1/2] feat(api): add /invoices endpoint
  [2/2] test(api): cover /invoices paths  ← subject edited by user
Tree equality check: ok.
Updating branch ref feature/invoices → reshaped.

Done. Backup: atropos/backup-2026-04-21T14-32-00Z.
Next step is yours: git push --force-with-lease (atropos will not do this).
```

**Mid-apply failure path.** If any step after backup creation fails, the tool:
1. Leaves the scratch branch in place for inspection.
2. Does **not** move the original branch ref.
3. Prints the exact `atropos restore` command.
4. Exits non-zero.

---

## 5. Architecture

```
src/
  cli/
    index.ts              commander entry, subcommand routing
    reshape.ts            default command: analyze + plan
    apply.ts              apply command
    restore.ts            restore command
    config.ts             config resolution (file + env + flags)
  git/
    shell.ts              typed execa wrapper; one place that spawns git
    refs.ts               branch / remote / upstream queries
    commits.ts            rev-list, show, diff helpers
    types.ts              Commit, Trailer, Range, Tree
    guards.ts             precondition checks (clean tree, no rebase in progress, …)
  analyze/
    collect.ts            gather commits + diffs in range
    dead-paths.ts         file-level dead-path detection
    net-diff.ts           compute base..head summary
    normalize-input.ts    shape data for prompt + for fallback
  cluster/
    prompt.ts             prompt template + render
    schema.ts             zod Plan schema
    llm.ts                Anthropic client, retry, token accounting
    validate.ts           structural validation of LLM response
    fallback.ts           heuristic-only clustering
  authorship/
    patterns.ts           default strip patterns (agent trailers, bot emails)
    strip.ts              trailer-aware message cleaning
    identity.ts           resolve target author from flags/config/git
    report.ts             per-cluster authorship diff for plan
  plan/
    render.ts             write plan.md
    parse.ts              re-read edited plan.md
    validate-plan.ts      semantic checks before apply
    schema.ts             internal Plan type
  apply/
    preflight.ts          all preconditions for apply
    backup.ts             backup branch creation
    rebase.ts             cherry-pick + squash execution
    verify.ts             tree-equality gate
    commit-writer.ts      compose message, set author/committer env, commit
    rollback.ts           restore-from-backup + cleanup
  util/
    logger.ts             leveled, colored, redacts API keys
    errors.ts             typed error hierarchy (see §13)
    tokens.ts             rough token counting for budgeting
tests/
  fixtures/
    build.sh              produces known-messy repos in a tmp dir
    scenarios/            one subdir per scenario (see §14)
  unit/
  integration/            exercise CLI against fixture repos
```

**Runtime dependencies.** Keep the tree shallow.

- `@anthropic-ai/sdk` — LLM call.
- `commander` — CLI parsing.
- `zod` — response + config validation.
- `execa` — git subprocess. Never raw `child_process` outside `git/shell.ts`.
- `kleur` — color. No deps.
- `@inquirer/prompts` — confirms and `--yes` short-circuits it.

No `simple-git`. Direct git calls make error surfaces explicit.

**Build:** `tsup` → single ESM + CJS bundle, Node ≥ 20.
**Tests:** `vitest`, snapshot + integration fixtures.
**Lint:** `eslint` + `prettier`, but not a blocker for v1.

---

## 6. Data model

Types that appear in multiple modules live in `git/types.ts` or `cluster/schema.ts`.

```ts
// git/types.ts
export type Sha = string & { __sha: never };

export interface Commit {
  sha: Sha;
  parents: Sha[];
  author: Identity;
  committer: Identity;
  authoredAt: string;   // ISO8601
  committedAt: string;
  subject: string;
  body: string;
  trailers: Trailer[];
  files: FileChange[];  // from --numstat
}

export interface Identity { name: string; email: string; }
export interface Trailer   { key: string; value: string; raw: string; }
export interface FileChange {
  path: string;
  oldPath?: string;     // set on rename
  added: number;
  deleted: number;
  status: "A" | "M" | "D" | "R" | "C" | "T";
}

export interface Range { base: Sha; head: Sha; baseRef: string; headRef: string; }
```

```ts
// cluster/schema.ts
export const Cluster = z.object({
  id: z.string(),                        // "c1", "c2", … assigned by tool, not LLM
  type: z.enum(["feat","fix","refactor","chore","test","docs","perf","build","ci"]),
  scope: z.string().optional(),
  subject: z.string().min(1).max(72),
  body: z.string().optional(),
  memberShas: z.array(z.string()).min(1),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const PlanDocument = z.object({
  version: z.literal(1),
  range: z.object({ base: z.string(), head: z.string(), baseRef: z.string(), headRef: z.string() }),
  generatedAt: z.string(),
  model: z.string().optional(),          // null in --no-cloud
  clusters: z.array(Cluster),
  dropped: z.array(z.object({ sha: z.string(), reason: z.string() })),
  warnings: z.array(z.string()).default([]),
  authorship: z.object({
    targetAuthor: z.object({ name: z.string(), email: z.string() }),
    strippedSummary: z.array(z.object({ pattern: z.string(), count: z.number() })),
    preservedSummary: z.array(z.object({ key: z.string(), count: z.number() })),
  }),
});
```

---

## 7. Core algorithms

### 7.1 Data collection

```
range = resolve_range(flags)                  // §5.4 resolution rules
commits = git rev-list --reverse --no-merges range
for each sha in commits:
  meta = git show -s --format=%H%n%P%n%aN%n%aE%n%aI%n%cN%n%cE%n%cI%n%B <sha>
  files = git show --numstat --format= <sha>
  diff  = git show --format= <sha>           // stored lazily; truncated before prompt
net = git diff --numstat range.base range.head
```

`git merge-base range.base range.head` is computed once and cached; all range operations go through it so "range" means the same thing everywhere in a run.

**Diff truncation for the prompt.** Per-commit cap: 400 lines. Per-range cap: 6,000 lines. Overflow is replaced with `[…N lines truncated…]` and the commit is flagged so the clustering step knows to weight file-path signals higher than content signals on oversized commits.

### 7.2 Dead-path detection

A file path `p` is **dead in range** iff:
- `p` does not exist in the tree at `range.base`, AND
- `p` does not exist in the tree at `range.head`, AND
- `p` appears in at least one commit's diff in the range.

```
baseTree = git ls-tree -r --name-only range.base
headTree = git ls-tree -r --name-only range.head
touched  = union of files across commits in range

dead = { p in touched | p ∉ baseTree && p ∉ headTree }
```

Per-commit classification:
- `DROP` — every file touched by this commit is dead.
- `MIXED` — some files dead, some live.
- `LIVE` — no dead files.

**Renames.** v1 uses git's own rename detection (`-M`). Following renames across the range is heavy and often wrong on agent-generated branches (renames happen then get reverted). A file that was renamed and then deleted is still dead; the rename detection picks that up automatically. Heavy-rename branches get a known-limitation note in the plan warnings.

**Mid-range modification reverts.** A file that existed at base, was modified, and the modifications were reverted inside the range is **not** dead — the file survives. The modifications are dead *lines*, which is the hunk problem. v1 does not solve this; such commits pass to clustering as MIXED when they touch otherwise-live files, and the clustering step decides whether to fold them into a neighbor or drop them.

### 7.3 Clustering — LLM path

**Model.** Claude Sonnet 4.6 by default (`claude-sonnet-4-6`). Opus 4.7 via `--model opus` for branches where the extra cost is justified (>50 commits, or when the user explicitly opts in). Haiku 4.5 as a `--model haiku` option for cost-sensitive runs; quality degrades visibly below ~30 commits of context.

**Prompt caching.** The system prompt, the schema description, and the invariant instructions are all cached with `cache_control: { type: "ephemeral" }`. On a typical repo the per-call variable payload (commits + diffs) is 3–15k tokens; the cacheable prefix is ~1.5k tokens and amortizes after the second call in a 5-minute window (retries, re-prompts).

**Prompt skeleton** (abbreviated; full template in Appendix A):

```
<system cache_control="ephemeral">
You reshape messy agent-generated git history into clean commits. You output
only JSON conforming to the provided schema. Obey these invariants: …
</system>

<user>
<schema cache_control="ephemeral">{…zod schema as JSON schema…}</schema>

<range>
  base: <sha> "<msg>" (<ref>)
  head: <sha> "<msg>" (<ref>)
  commits in range: N, dead-path dropped: K
</range>

<net_diff>
  files changed: X, +Y -Z lines
  areas:
    - src/api/       +210 -12
    - src/api/tests/ +88  -0
    …
</net_diff>

<commits>
  <commit id="c1" sha="…" status="LIVE|MIXED">
    <message>…</message>
    <files>src/api/invoices.ts (+120 -0), …</files>
    <dead_files>…</dead_files>                  only if MIXED
    <diff truncated="false">…</diff>
  </commit>
  …
</commits>

<instructions>
Group LIVE and MIXED commits into clusters. Produce JSON matching the schema.
Do not emit any Co-authored-by or generated-with lines in body; downstream
strips those. Keep subject ≤ 72 chars, imperative, lower-case after type.
Confidence reflects your certainty about the grouping, not the message.
</instructions>
</user>
```

**Response validation.** Every field goes through zod. Then:

- Every non-DROP `sha` in the range is in exactly one `memberShas` array or in `dropped`.
- Every sha in `memberShas` is a real range sha (no hallucination).
- Cluster order respects the dependency heuristic: if cluster B touches only paths first *created* in cluster A, A must come before B.
- No cluster is empty.
- Subject ≤ 72 chars, no trailing period, first word lowercase after the type.

**Re-prompt on failure.** Exactly one retry with the failures appended verbatim. If the retry fails validation too, render a plan with `confidence: 0` clusters and a `[NEEDS REVIEW]` header rather than silently bailing. The user can still edit the plan by hand.

**Token budgeting.** Rough `tokens.ts` estimator keys on whitespace splitting × 1.3. If the estimated prompt exceeds 150k tokens after truncation, drop diffs entirely and send message+files only, with a warning in the plan. Branches beyond that are rare enough to punt.

### 7.4 Clustering — heuristic fallback

Used when `--no-cloud` is set, the API is unreachable, or both retries fail. Not as good as the LLM path; meant to be *usable*, not *great*.

```
1. For each LIVE/MIXED commit, compute a signature:
     top_dir(files), fingerprint = hash(sort(top_dirs))
2. Sort commits by authoredAt.
3. Greedy merge: walk commits in order; merge into the current cluster if
     fingerprint matches OR >=50% of files overlap with the cluster's file set
     AND the authored-at gap is < 30 minutes.
   Start a new cluster otherwise.
4. Synthesize subject: "<type>(<scope>): <verb> <joined-top-paths>"
     type  = most common type keyword in original messages, else "chore"
     scope = longest common directory of the cluster's files, trimmed
     verb  = "update" unless the cluster only adds files ("add") or only deletes ("remove")
5. Flag every cluster with confidence 0.4 and a "heuristic fallback" reasoning.
```

The fallback never silently ships a wrong message because the plan is still reviewed by a human before apply. The point of the fallback is that the tool still does *something* useful when offline.

### 7.5 Authorship normalization

Runs after clustering, before apply. Its output is visible in the plan so the user can audit every identity change.

**Target identity resolution**, first hit wins:

1. `--author "Name <email>"` flag.
2. `authorship.author` in `.atropos.json` (repo-local).
3. `user.name` + `user.email` from git config (local, then global).
4. Error out with `ERR_NO_IDENTITY`.

**Strip targets** (applied per commit in the range to collect stats, then applied again to the final squashed message):

1. **Trailers matching any strip pattern.** Default list (regex, case-insensitive, anchored):
   - `^Co-authored-by:.*(claude|anthropic|copilot|cursor|aider|codex|devin|github-actions).*$`
   - `^Co-authored-by:.*\[bot\].*$`
   - `^Co-authored-by:.*noreply@anthropic\.com.*$`
   - `^Co-authored-by:.*users\.noreply\.github\.com.*$` — *only* when the local part matches `*[bot]*`.
2. **Footer lines** matching:
   - `🤖 Generated with .*`
   - `Generated with \[Claude Code\].*`
   - Any line containing `claude.ai/code`.
   - Markdown-link-only lines pointing at known agent domains.
3. **Author / committer identity** if the email matches any configured bot email pattern. Overwritten with the target identity.

**Preserved regardless** (conservative — false-strips are worse than false-keeps):
- `Signed-off-by:` lines.
- `Co-authored-by:` lines whose email does *not* match any strip pattern. Real human pairs survive.
- Issue-tracker trailers: `Closes #`, `Fixes #`, `Refs #`, `Resolves`.
- `Reviewed-by:`, `Tested-by:`, `Reported-by:`.

**Pattern config.**

```json
{
  "authorship": {
    "normalize": true,
    "author": "Sid <sid@example.com>",
    "stripPatterns": null,           // null = use defaults
    "additionalStripPatterns": [
      "^Co-authored-by:.*my-internal-bot.*$"
    ],
    "preserveTrailers": ["Signed-off-by", "Reviewed-by", "Closes", "Refs", "Fixes"]
  }
}
```

`stripPatterns: null` means use defaults; most users only touch `additionalStripPatterns`.

**Disclosure.** Defaulting to strip is a choice that matches the most common use — personal repos, portfolio cleanup, private team work. Contexts requiring AI disclosure (some OSS contribution guidelines; certain company policies) should set `authorship.normalize: false` or pass `--preserve-agent-attribution`. The README has a dedicated section on this so no one can say the tool hid it.

### 7.6 Apply

```
preflight():
  assert working tree clean  (or --allow-dirty stashes and restores)
  assert not in the middle of rebase / merge / cherry-pick
  assert HEAD unchanged since plan generated (compare plan.range.head to HEAD)
  assert range is fully unpushed unless --rewrite-pushed
     for each remote:
       for each ref in git for-each-ref refs/remotes/<remote>:
         if any sha in range is reachable from that ref → reject
  assert lock file .git/atropos.lock is absent; create it

backup():
  ts = now in UTC, file-safe
  backupRef = atropos/backup-<ts>
  git branch <backupRef> <range.head>

reshape():
  workRef = atropos/work-<ts>
  git checkout -b <workRef> <range.base>
  for each cluster in plan order:
    git cherry-pick -n --allow-empty --keep-redundant-commits <memberShas…>
    # -n = no commit; we compose and commit ourselves
    if conflict:
      git cherry-pick --abort
      rollback(backupRef); release lock; exit with ERR_CONFLICT
    msg = compose_message(cluster, preserved_trailers)
    env:
      GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL       = targetIdentity
      GIT_AUTHOR_DATE                         = earliest authoredAt among cluster members
      GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL = targetIdentity
      GIT_COMMITTER_DATE                      = now
    git commit -m "<msg>"

verify():
  originalTree = git rev-parse <range.head>^{tree}
  newTree      = git rev-parse <workRef>^{tree}
  if originalTree != newTree:
    rollback(backupRef); release lock; exit with ERR_TREE_MISMATCH

promote():
  originalBranch = plan.range.headRef   # e.g. "feature/invoices"
  git branch -f <originalBranch> <workRef>
  git checkout <originalBranch>
  git branch -D <workRef>
  release lock
```

**The tree-equality check in `verify()` is the single most important safety gate.** Authorship and message changes do not affect tree hashes; only file content does. If the trees differ by one byte, the user's work is at risk and the tool aborts loudly.

**`--dry-run`** prints each git command that would run, with resolved SHAs and env vars (identity redacted to `<configured author>`). It does not create the backup branch or the lock file.

---

## 8. Safety model

Invariants from §2 are enforced as follows:

| Invariant | Enforced where | How |
|---|---|---|
| Tree equality | `apply/verify.ts` | Compare `rev-parse work^{tree}` vs `rev-parse orig-head^{tree}`; abort + rollback on mismatch |
| Reversibility | `apply/backup.ts` → `apply/rollback.ts` | Backup ref created before any mutation; rollback restores the original branch ref and deletes the work ref |
| No silent network | `cluster/llm.ts`, `cli/reshape.ts` | Network only inside `llm.ts`; `--no-cloud` routes to `fallback.ts`; log line every time the SDK is called |
| No silent identity writes | `plan/render.ts`, `authorship/report.ts` | Authorship section in `plan.md` lists every stripped pattern + target identity; apply refuses if the plan's authorship block was hand-edited away (section header is required) |
| No push | nowhere | The tool literally never calls `git push`. `--force-push` prints the command for the user to run |
| No touching pushed commits | `apply/preflight.ts` | Checks *every* remote's tracking refs, not just `@{upstream}` |

**Lock file.** `.git/atropos.lock` is created at the start of apply and deleted on success, failure, or rollback. Concurrent invocations are refused with `ERR_LOCKED`. A stale lock older than 30 minutes is reported with the recovery command.

**Signal handling.** `SIGINT` / `SIGTERM` during apply: release lock, call rollback, exit 130. The tool refuses to proceed from a partial state on the next run — the lock tells it what to clean up.

---

## 9. Config

### 9.1 File: `.atropos.json`

Loaded from the repo root. Validated by zod.

```json
{
  "range": {
    "defaultBase": "@{upstream}",
    "fallbackBases": ["main", "master"]
  },
  "cluster": {
    "model": "claude-sonnet-4-6",
    "maxCommits": 200,
    "maxPromptTokens": 150000
  },
  "format": {
    "convention": "conventional",
    "maxSubjectLength": 72,
    "allowedTypes": ["feat","fix","refactor","chore","test","docs","perf","build","ci"],
    "allowedScopes": null
  },
  "authorship": {
    "normalize": true,
    "author": null,
    "stripPatterns": null,
    "additionalStripPatterns": [],
    "preserveTrailers": ["Signed-off-by","Reviewed-by","Closes","Fixes","Refs","Resolves"]
  },
  "safety": {
    "refuseOnPushed": true,
    "allowDirty": false
  }
}
```

### 9.2 Precedence

Highest wins:

1. CLI flags.
2. Environment (`ATROPOS_MODEL`, `ATROPOS_AUTHOR`, `ATROPOS_NO_CLOUD`).
3. `.atropos.json` in repo root.
4. Built-in defaults.

### 9.3 Secrets

- `ANTHROPIC_API_KEY` from the environment only. Never read from files in the repo. Never logged; `util/logger.ts` redacts anything matching the key shape.

---

## 10. CLI surface

```
atropos [range]              plan (default; writes .atropos/plan.md)
atropos apply                apply the existing plan
atropos apply --dry-run      print git commands without executing
atropos restore              restore from the most recent backup
atropos doctor               check git version, config, identity, API key
atropos --version
atropos --help
```

### 10.1 Flags (plan)

| Flag | Effect |
|---|---|
| `[range]` positional | explicit range, e.g. `main..HEAD` |
| `--since "<gitdate>"` | convenience: commits since a date |
| `--model <name>` | override clustering model |
| `--no-cloud` | skip the LLM; use heuristic fallback |
| `--author "<Name> <<email>>"` | override target identity |
| `--preserve-agent-attribution` | disable authorship normalization |
| `--strip-pattern <regex>` | add a one-off strip pattern; repeatable |
| `--yes` | plan + apply in one shot, with confirm still printed |
| `--output <path>` | write plan somewhere other than `.atropos/plan.md` |

### 10.2 Flags (apply)

| Flag | Effect |
|---|---|
| `--dry-run` | print commands; do nothing |
| `--rewrite-pushed` | allow rewriting commits already on a remote |
| `--force-push` | **prints** the force-push command. does not run it |
| `--allow-dirty` | stash and restore working tree around apply |
| `--plan <path>` | apply a plan at a non-default path |

### 10.3 Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | generic unexpected error |
| 2 | usage error (bad flag, bad range) |
| 10 | config / identity missing |
| 20 | network / API error (plan) |
| 21 | LLM response invalid after retry (plan) |
| 30 | plan parse error (apply) |
| 31 | preflight failed (dirty tree, pushed commits, …) (apply) |
| 32 | conflict during cherry-pick (apply) |
| 33 | tree-equality mismatch (apply) |
| 40 | lock held |
| 130 | user interrupt |

---

## 11. Plan file format

`.atropos/plan.md` is the contract between tool and human. Both must be able to read it; the tool must be able to re-parse a human-edited version.

Two-block structure: a fenced `atropos-meta` block at the top that's machine-parseable, followed by human-readable Markdown.

```markdown
<!-- atropos:begin -->
```yaml
version: 1
range:
  base: a1b2c3d
  baseRef: main
  head: i9j0k1l
  headRef: feature/invoices
generatedAt: 2026-04-21T14:32:00Z
model: claude-sonnet-4-6
authorship:
  targetAuthor: "Sid <sid@example.com>"
clusters:
  - id: c1
    type: feat
    scope: api
    subject: "add /invoices endpoint"
    memberShas: [f6g7h8, a1b2c3]
    confidence: 0.92
  - id: c2
    type: test
    scope: api
    subject: "cover /invoices happy + error paths"
    memberShas: [g7h8i9, h8i9j0]
    confidence: 0.88
dropped:
  - sha: c3d4e5, reason: "middleware experiment, reverted in d4e5f6"
  - sha: d4e5f6, reason: "revert of c3d4e5"
  - sha: b2c3d4, reason: "wip — merged into c1"
  - sha: e5f6g7, reason: "typo fix — merged into c1"
  - sha: i9j0k1, reason: "generated-with footer only, empty tree change"
```
<!-- atropos:end -->

# Atropos plan

**Range:** `main..feature/invoices` (9 commits)
**Generated:** 2026-04-21T14:32:00Z
**Backup will be created at:** `atropos/backup-<ISO>`

## Authorship

**Target author:** `Sid <sid@example.com>` (from `.atropos.json`)
**Stripped across range:**
- 9 × `🤖 Generated with [Claude Code]`
- 9 × `Co-authored-by: Claude <noreply@anthropic.com>`

**Preserved:** *(none in this range)*

## Proposed history (2 commits)

### 1. `feat(api): add /invoices endpoint`

Groups: `a1b2c3`, `f6g7h8`
Confidence: 0.92

*Why:* Both commits touch `src/api/invoices.ts` and the router. `a1b2c3`'s
config-shape update is only meaningful because of the handler added in `f6g7h8`.

### 2. `test(api): cover /invoices happy + error paths`
…

## Dropped (5)
- `b2c3d4` — wip, merged into c1
- …

## Warnings
*(none)*

---

Apply: `atropos apply`
Edit: modify this file and run `atropos apply` (re-parses the yaml block).
Start over: `rm -rf .atropos/` and re-run.
```

**Parse rules.**
- The YAML block is the source of truth for apply. Markdown below it is cosmetic.
- Users who want to edit clusters edit the YAML. Users who want to tweak subjects can edit either; the YAML wins.
- Apply refuses if `version` doesn't match, if `range.head != HEAD`, or if any `memberShas` entry isn't in the range. Clear error with the fix.

---

## 12. Error taxonomy

One typed error per failure mode. Message format: `<code>: <what> — <why> — <fix>`.

| Code | Where | Message template |
|---|---|---|
| `ERR_NOT_A_REPO` | entry | "not a git repository — run atropos inside a repo" |
| `ERR_BAD_RANGE` | `git/refs.ts` | "range <spec> is empty or invalid — try `atropos main..HEAD`" |
| `ERR_NO_IDENTITY` | `authorship/identity.ts` | "no author found — set `user.email` in git or pass `--author`" |
| `ERR_NO_API_KEY` | `cluster/llm.ts` | "ANTHROPIC_API_KEY not set — export it or pass `--no-cloud`" |
| `ERR_LLM_INVALID` | `cluster/validate.ts` | "LLM returned invalid plan after retry — edit `.atropos/plan.md` by hand or re-run" |
| `ERR_PUSHED` | `apply/preflight.ts` | "<sha> is reachable from <remote>/<ref> — pass `--rewrite-pushed` if you mean it" |
| `ERR_DIRTY` | `apply/preflight.ts` | "working tree has uncommitted changes — commit, stash, or pass `--allow-dirty`" |
| `ERR_LOCKED` | `apply/preflight.ts` | ".git/atropos.lock held — another run in progress or stale (>30m); delete to recover" |
| `ERR_CONFLICT` | `apply/rebase.ts` | "conflict during cherry-pick of <sha>; rolled back to <backup>" |
| `ERR_TREE_MISMATCH` | `apply/verify.ts` | "reshaped tree ≠ original tree — aborting; restore with `atropos restore`" |
| `ERR_UNSUPPORTED` | various guards | "submodules / LFS / worktree detected — not supported in v1" |

All errors inherit from `AtroposError` with `code`, `exitCode`, `hint`.

---

## 13. Observability

- `util/logger.ts`. Levels: `error | warn | info | debug | trace`. Default `info`. `-v` → `debug`, `-vv` → `trace`. JSON mode for CI via `--json`.
- Every git invocation is logged at `debug` with argv and duration.
- Every Anthropic call is logged at `info` with model, input/output tokens, cost estimate, and latency. Never the prompt or completion bodies.
- `.atropos/run.log` written on every run; rotated after 10 MB.
- No telemetry. No phone-home. This is a trust tool.

---

## 14. Testing strategy

### 14.1 Fixture repos

`tests/fixtures/build.sh` creates scenarios as temporary git repos:

1. **happy** — 5 commits, one logical feature, no dead paths. Expect 1 cluster.
2. **dead-file** — a file created and later deleted; full-drop commits in the middle. Expect dropped entries.
3. **dead-lines** — a modification added and reverted on a surviving file. Expect MIXED commits to fold into neighbors.
4. **agent-trailers** — Claude Code style messages with `Co-authored-by: Claude` and `🤖 Generated with…`. Expect all stripped, target author applied.
5. **human-pair** — real `Co-authored-by: Priya …`. Expect preserved.
6. **mixed-concerns** — one commit touches two areas. Expect warning on the assigned cluster.
7. **pushed** — commits reachable from a fake `origin/feature`. Expect refusal without `--rewrite-pushed`.
8. **conflict** — contrived to produce a cherry-pick conflict. Expect ERR_CONFLICT and successful rollback.
9. **rename** — a file renamed then modified. Expect no false dead-path, no false drop.
10. **empty-range** — nothing in the range. Expect ERR_BAD_RANGE.
11. **huge** — 200 commits, ~8k touched lines. Expect truncation warnings but successful plan.
12. **no-cloud** — run with `--no-cloud`. Expect a reasonable heuristic plan.

Every scenario has a golden plan in `tests/fixtures/scenarios/<name>/expected-plan.yaml` (meta block only; Markdown excluded from snapshots to avoid noise).

### 14.2 Property / invariant tests

Run against every fixture after apply:

- `T1 tree_equality`: `rev-parse HEAD^{tree} == rev-parse backup^{tree}`.
- `T2 member_coverage`: every non-DROP sha appears in exactly one cluster or in dropped.
- `T3 author_normalized`: every new commit's author email == target identity (when normalize is on).
- `T4 no_stripped_trailers`: no new commit body matches any active strip pattern.
- `T5 preserved_trailers`: every trailer in `preserveTrailers` present in source commits is present in the corresponding new commit.
- `T6 backup_exists`: `atropos/backup-*` ref points at the pre-apply head.
- `T7 no_lock`: no `.git/atropos.lock` after a successful run.

### 14.3 Coverage targets

- Unit: 80% line coverage on `authorship/`, `cluster/validate.ts`, `apply/verify.ts`, `plan/parse.ts`. These are the correctness-critical modules.
- Integration: all 12 fixtures green in CI on every PR.
- LLM: mocked by default. One opt-in smoke test that hits the real API on release branches only.

---

## 15. Implementation phases

Each phase has a concrete exit criterion. Not "feature done" — "this specific thing verifiable."

**Phase 0 — scaffold (0.5 day).**
Repo, `tsup`, `vitest`, `commander`, `atropos --version`, `atropos doctor`. Exit: `npx atropos doctor` prints git version, config presence, API key presence.

**Phase 1 — git layer (1–2 days).**
`git/shell.ts`, `git/refs.ts`, `git/commits.ts`. Collect a range, compute net diff, ls-tree at any sha. Exit: `atropos --no-cloud --debug` on the `happy` fixture prints a complete internal representation.

**Phase 2 — dead-path (1 day).**
`analyze/dead-paths.ts`. Exit: scenarios 1, 2, 3, 9 classify every commit correctly (snapshot-tested).

**Phase 3 — authorship (1 day, parallel with phase 2).**
`authorship/*`. Pure functions, heavy unit tests. Exit: fixtures 4 and 5 produce the expected strip/preserve summaries.

**Phase 4 — LLM clustering (2–3 days).**
`cluster/*`. Prompt + schema + validation + retry + fallback. Exit: scenarios 1 and 6 produce valid plans against a mocked LLM; scenario 12 produces a plan with `--no-cloud`.

**Phase 5 — plan render + parse (1 day).**
`plan/render.ts`, `plan/parse.ts`, `plan/validate-plan.ts`. Round-trip: render → parse → render is a fixed point. Exit: golden plans match for scenarios 1–6, 9, 11, 12.

**Phase 6 — apply (2–3 days).**
`apply/*`. Preflight, backup, rebase, verify, promote, rollback. Exit: all 12 fixtures pass T1–T7 invariants. This is the phase with the most rollback tests — inject a fake failure at every step and verify the repo is recoverable.

**Phase 7 — polish (1–2 days).**
Error messages reviewed for clarity, `--dry-run`, `restore`, `--no-cloud` end-to-end, README, a 30-second demo recording. Exit: a fresh user following the README can plan + apply + restore without asking for help.

**Phase 8 — release.**
npm publish (name TBD: `atropos`, `atropos-cli`, or `@whenlabs/atropos`). Blog post. HN + r/commandline + Claude Code community.

**Total:** ~11–14 focused days. Calendar: 3–4 weeks on evenings/weekends.

---

## 16. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Clustering is worse than the original | medium | medium | plan-first workflow, human-in-the-loop, confidence scores |
| Apply corrupts the tree | low | catastrophic | T1 tree-equality gate, backup branch always |
| Token cost on large branches | medium | low | per-commit + per-range caps, prompt caching, warn beyond 150k |
| Repo content sent to Anthropic | medium | medium-high | `--no-cloud`, clear README section, no body logging |
| Agent trailer format not matched | medium | low | user-extensible patterns, log unmatched bot-ish trailers for reporting |
| Accidentally strips a human's trailer | low | high (trust) | conservative anchored patterns, plan shows exactly what's stripped |
| Git edge cases (submodules, LFS, worktrees) | medium | medium | ERR_UNSUPPORTED with a clear message; handle post-v1 |
| Concurrent runs | low | medium | lock file with 30m staleness window |
| User doesn't trust enough to apply | high | product failure | strong plan output, reversible, `--dry-run` shows real commands |
| Disclosure obligations in some contexts | medium | policy | default-on is a choice, README documents it, `--preserve-agent-attribution` is first-class |

---

## 17. Open questions — answered

The previous plan left these open. My answers below. Revisit if wrong.

1. **Standalone or part of WhenLabs toolkit?** Standalone for v1. npm name: try `atropos`; fall back to `atropos-cli`. Bundling into `when` later is reversible; splitting later isn't.
2. **Default base detection.** `@{upstream}` if set. Else `git symbolic-ref refs/remotes/origin/HEAD`. Else the first of `main`, `master`, `develop` that exists. Else prompt. Don't guess silently.
3. **Multi-human squash.** Author = target identity (the person running atropos). Every other human across the cluster goes into `Co-authored-by:` trailers, deduplicated by email.
4. **Rewrite messages of singleton clusters?** Yes when `--rewrite-all` is passed; no by default. Agents write bad messages for singletons too, but surprise rewrites are worse than keeping bad ones. Authorship normalization still applies to singletons unconditionally.
5. **Merges in the range?** `rev-list --no-merges` by default. `--include-merges` flag collects them; clustering treats a merge's introduced commits as members of whatever cluster they'd land in. First-parent-only for the merge itself.
6. **What if the range contains no LIVE commits?** Emit a plan with zero clusters and a warning — "this entire range is dead or reverted; apply would reduce history to the base." Apply requires `--allow-empty-result`.
7. **Model default.** `claude-sonnet-4-6`. Good enough for the task, an order of magnitude cheaper than Opus on branches with big diffs.

---

## 18. Success criteria

v1 is done when:

- All 12 fixtures green in CI, including T1–T7 invariants.
- 10 self-dogfooded agent sessions produce plans the author would have written by hand (subjective; logged in a `DOGFOOD.md` that ships with v1).
- Apply produces byte-identical trees 10/10 times on those sessions.
- Zero false positives on human `Co-authored-by` lines across the dogfood corpus.
- README has a 15-second before/after recording.

30-day traction signals:

- 100+ GitHub stars.
- ≥ 1 external PR or meaningful issue.
- 500 weekly npm downloads by day 30.

---

## 19. Appendices

### A. Full prompt template

*(Rendered from `cluster/prompt.ts`. The `<schema>` block is the JSON Schema generated from the zod definition in `cluster/schema.ts`.)*

```
SYSTEM (cached):
You are reshaping agent-generated git history into clean, reviewable commits.
Output only a single JSON object conforming to the provided schema — no prose,
no code fences. Invariants:
- Every LIVE or MIXED commit in the range must appear in exactly one cluster's
  memberShas or in the dropped list.
- Every sha you output must be from the provided range. Do not invent shas.
- Cluster order = apply order. A cluster that depends on paths created by another
  must come after it.
- Subjects ≤ 72 chars, imperative, no trailing period, lowercase after the type.
- Do not include Co-authored-by or generated-with lines in body. Those are
  handled by a separate authorship pass.

USER (cached schema prefix):
<schema>…JSON Schema here…</schema>

USER (variable):
<range>…</range>
<net_diff>…</net_diff>
<commits>…</commits>
<instructions>Produce the JSON Plan now.</instructions>
```

### B. Positioning (README lede)

> Agents commit on turn boundaries, not thought boundaries. `atropos` reads the mess an agent leaves behind, drops dead paths, clusters survivors into logical commits, and normalizes authorship — so history reads like *you* wrote it. Never force-pushes. Always reversible. The cut is final, but recoverable.

### C. Glossary

- **Range** — `<base>..<head>`, a linear sequence of commits to reshape.
- **Dead path** — a file that neither exists at base nor head, but was touched somewhere in between.
- **DROP / MIXED / LIVE** — per-commit classification based on dead-path status.
- **Cluster** — a group of original commits that becomes one new commit.
- **Backup ref** — `atropos/backup-<ISO8601>`, created before any mutation.
- **Work ref** — `atropos/work-<ISO8601>`, the scratch branch the reshape happens on.
- **Tree equality** — `rev-parse A^{tree} == rev-parse B^{tree}`. The non-negotiable safety check.
