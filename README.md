# atropos

> Agents commit on turn boundaries, not thought boundaries. `atropos` reads the mess an agent leaves behind, drops dead paths, clusters survivors into logical commits, and normalizes authorship — so history reads like *you* wrote it. Never force-pushes. Always reversible. The cut is final, but recoverable.

## What it does

Reshapes a typical agent-authored branch from this:

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

into this:

```
feat(api): add /invoices endpoint
test(api): cover /invoices happy + error paths
```

## Install

```sh
npm install -g atropos
# or run via npx:
npx atropos
```

Requires Node ≥ 20. macOS and Linux supported; Windows via WSL only.

## Quick start

```sh
# 1. plan: writes .atropos/plan.md, no mutations
atropos
atropos main..HEAD          # explicit range

# 2. review .atropos/plan.md, edit if needed

# 3. apply: backup → reshape → tree-equality verify → promote
atropos apply
atropos apply --dry-run     # see the git commands first

# 4. if anything looks wrong:
atropos restore             # restores from the most recent backup ref
```

## Safety model

Five non-negotiable invariants:

1. **Tree equality** — the tree at the tip of the reshaped branch byte-matches the original. Always.
2. **Reversibility** — every mutation is preceded by an `atropos/backup-<ISO>` ref. `atropos restore` is the undo button.
3. **No silent network** — `--no-cloud` skips the LLM entirely; the SDK isn't even loaded.
4. **No silent identity writes** — every authorship change is listed in the plan before apply.
5. **No push without your hand on the keyboard** — atropos *literally never* calls `git push`. After apply, you run `git push --force-with-lease` yourself.

Pushed commits are refused unless you pass `--rewrite-pushed`. The check walks every remote-tracking ref, not just `@{upstream}`.

## Authorship & disclosure

By default, atropos strips agent attribution from commit messages:

- `Co-authored-by: Claude <noreply@anthropic.com>` and similar bot trailers
- `🤖 Generated with [Claude Code]` footer lines
- `[bot]` GitHub no-reply addresses

This matches the most common use case (personal repos, portfolio cleanup, private team work). **Real human `Co-authored-by:` and `Signed-off-by:` trailers are preserved verbatim** — that's the trust property the test suite verifies on every fixture.

If your context requires AI disclosure (some OSS contribution guidelines, certain company policies), pass `--preserve-agent-attribution` or set `authorship.normalize: false` in `.atropos.json`.

## LLM clustering

When `ANTHROPIC_API_KEY` is set, atropos uses Claude Sonnet 4.6 to cluster commits. The system prompt and schema are sent with `cache_control: ephemeral` for cost amortization. On any failure (network, schema-fail-twice), atropos falls back to a deterministic heuristic clusterer and surfaces the failure as a plan warning. You always get a usable plan.

`--no-cloud` skips the LLM entirely and uses heuristic clustering only.

## v1 limitations

- One commit always becomes part of one cluster. No hunk splitting.
- Conflicts during cherry-pick abort the apply; `atropos restore` returns to the backup.
- Submodules, LFS, and additional worktrees are detected and refused with a clear error.
- Merges in the range are skipped (no `--include-merges` in v1).
- Windows-native is not supported (use WSL).

## Common commands

```sh
atropos doctor              # check git, identity, API key
atropos --no-cloud          # plan without the LLM
atropos --author "Sid <sid@example.com>"
atropos apply --rewrite-pushed
atropos apply --plan path/to/plan.md
atropos restore --force     # if the working tree is dirty
```

## Exit codes

Per spec §10.3:

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | usage error |
| 10 | config / identity missing |
| 20 | network / API error |
| 21 | LLM response invalid after retry |
| 30 | plan parse error |
| 31 | preflight failed (dirty tree, pushed commits) |
| 32 | conflict during cherry-pick |
| 33 | tree-equality mismatch |
| 40 | lock held |
| 130 | user interrupt |

## License

MIT.
