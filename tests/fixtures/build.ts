import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
export { rmSync };
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";

export interface FixtureRepo {
  dir: string;
  branch: string;
  cleanup(): void;
}

const FIX_AUTHOR = { name: "Fix Author", email: "fixture@example.com" };
const BASE_DATE = new Date("2026-04-21T00:00:00Z").getTime();

async function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const r = await execa("git", args, {
    cwd,
    env: { ...process.env, ...env },
    reject: true,
    encoding: "utf8",
    stripFinalNewline: true,
  });
  return typeof r.stdout === "string" ? r.stdout : "";
}

function makeTmpRepo(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `atropos-${prefix}-`));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function commitEnv(seconds: number, identity = FIX_AUTHOR): NodeJS.ProcessEnv {
  const date = new Date(BASE_DATE + seconds * 1000).toISOString();
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

function writeFile(dir: string, relPath: string, contents: string): void {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

async function initRepo(dir: string, branch: string): Promise<void> {
  await run(["init", "-q", "-b", branch], dir);
  await run(["config", "user.name", FIX_AUTHOR.name], dir);
  await run(["config", "user.email", FIX_AUTHOR.email], dir);
  await run(["config", "commit.gpgsign", "false"], dir);
}

async function commit(
  dir: string,
  message: string,
  seconds: number,
): Promise<string> {
  await run(["add", "-A"], dir);
  await run(["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", message], dir, commitEnv(seconds));
  return run(["rev-parse", "HEAD"], dir);
}

export async function buildHappyFixture(): Promise<FixtureRepo> {
  const { dir, cleanup } = makeTmpRepo("happy");
  await initRepo(dir, "main");
  writeFile(dir, "README.md", "# happy\n");
  await commit(dir, "chore: init", 0);
  await run(["checkout", "-q", "-b", "feature/invoices"], dir);

  writeFile(dir, "src/api/invoices.ts", "export const list = () => [];\n");
  await commit(dir, "feat: add invoices stub", 60);

  writeFile(dir, "src/api/invoices.ts", "export const list = () => [{ id: 1 }];\n");
  await commit(dir, "wip", 120);

  writeFile(dir, "src/api/invoices.test.ts", "import { list } from './invoices';\nlist();\n");
  await commit(dir, "test: cover invoices", 180);

  writeFile(dir, "src/api/invoices.ts", "export const list = (): Array<{ id: number }> => [{ id: 1 }];\n");
  await commit(dir, "fix typo in handler", 240);

  return { dir, branch: "feature/invoices", cleanup };
}

export async function buildPushedFixture(): Promise<FixtureRepo> {
  const { dir, cleanup } = makeTmpRepo("pushed");
  await initRepo(dir, "main");
  writeFile(dir, "README.md", "# pushed\n");
  await commit(dir, "chore: init", 0);
  await run(["checkout", "-q", "-b", "feature/x"], dir);

  writeFile(dir, "src/x.ts", "export const x = 1;\n");
  await commit(dir, "feat: add x", 60);

  writeFile(dir, "src/x.ts", "export const x = 2;\n");
  await commit(dir, "wip", 120);

  // Simulate "pushed" by creating a fake remote-tracking ref pointing at HEAD.
  await run(["update-ref", "refs/remotes/origin/feature/x", "HEAD"], dir);
  await run(["remote", "add", "origin", dir], dir).catch(() => undefined);

  return { dir, branch: "feature/x", cleanup };
}

export async function buildDeadFileFixture(): Promise<FixtureRepo> {
  const { dir, cleanup } = makeTmpRepo("dead-file");
  await initRepo(dir, "main");
  writeFile(dir, "README.md", "# dead-file\n");
  await commit(dir, "chore: init", 0);
  await run(["checkout", "-q", "-b", "feature/df"], dir);

  // Live work in src/api/
  writeFile(dir, "src/api/users.ts", "export const users = [];\n");
  await commit(dir, "feat: add users module", 60);

  // Spike: create scratch file...
  writeFile(dir, "src/api/scratch.ts", "// experimental\n");
  await commit(dir, "wip: try scratch helper", 120);

  // ...then delete it (file is dead in range — exists in neither base nor head).
  rmSync(join(dir, "src/api/scratch.ts"), { force: true });
  await commit(dir, "revert: drop scratch helper", 180);

  // More live work
  writeFile(dir, "src/api/users.ts", "export const users = [{ id: 1 }];\n");
  await commit(dir, "feat: seed users", 240);

  return { dir, branch: "feature/df", cleanup };
}

export async function buildDeadLinesFixture(): Promise<FixtureRepo> {
  const { dir, cleanup } = makeTmpRepo("dead-lines");
  await initRepo(dir, "main");
  writeFile(dir, "src/lib.ts", "export const a = 1;\n");
  await commit(dir, "chore: init", 0);
  await run(["checkout", "-q", "-b", "feature/dl"], dir);

  // Modification (added then later reverted on a surviving file)
  writeFile(dir, "src/lib.ts", "export const a = 1;\nexport const b = 2;\n");
  await commit(dir, "feat: add b", 60);

  writeFile(dir, "src/lib.ts", "export const a = 1;\n");
  await commit(dir, "revert: drop b", 120);

  writeFile(dir, "src/lib.ts", "export const a = 11;\n");
  await commit(dir, "fix: bump a", 180);

  return { dir, branch: "feature/dl", cleanup };
}

export async function buildRenameFixture(): Promise<FixtureRepo> {
  const { dir, cleanup } = makeTmpRepo("rename");
  await initRepo(dir, "main");
  writeFile(dir, "src/old.ts", "export const x = 1;\n");
  await commit(dir, "chore: init", 0);
  await run(["checkout", "-q", "-b", "feature/r"], dir);

  // Rename (git detects via -M)
  await run(["mv", "src/old.ts", "src/new.ts"], dir);
  await commit(dir, "refactor: rename old → new", 60);

  // Modify after rename
  writeFile(dir, "src/new.ts", "export const x = 2;\n");
  await commit(dir, "feat: bump x", 120);

  return { dir, branch: "feature/r", cleanup };
}

export async function buildEmptyRangeFixture(): Promise<FixtureRepo> {
  const { dir, cleanup } = makeTmpRepo("empty");
  await initRepo(dir, "main");
  writeFile(dir, "README.md", "# empty\n");
  await commit(dir, "chore: init", 0);
  // No feature branch commits — collectRange against itself yields zero commits.
  return { dir, branch: "main", cleanup };
}

export async function buildMultiAreaFixture(): Promise<FixtureRepo> {
  const { dir, cleanup } = makeTmpRepo("multi");
  await initRepo(dir, "main");
  writeFile(dir, "README.md", "# multi\n");
  await commit(dir, "chore: init", 0);
  await run(["checkout", "-q", "-b", "feature/m"], dir);

  // Cluster A — api/ work
  writeFile(dir, "src/api/orders.ts", "export const orders = [];\n");
  await commit(dir, "feat: add orders endpoint", 60);
  writeFile(dir, "src/api/orders.ts", "export const orders: number[] = [];\n");
  await commit(dir, "wip", 120);

  // Cluster B — tests, separated by > 30 min and different top-dir
  writeFile(
    dir,
    "tests/orders.test.ts",
    "import { orders } from '../src/api/orders';\norders;\n",
  );
  await commit(dir, "test: cover orders endpoint", 60 * 60 + 60);

  return { dir, branch: "feature/m", cleanup };
}

export async function buildMixedConcernsFixture(): Promise<FixtureRepo> {
  const { dir, cleanup } = makeTmpRepo("mixed");
  await initRepo(dir, "main");
  writeFile(dir, "README.md", "# mc\n");
  await commit(dir, "chore: init", 0);
  await run(["checkout", "-q", "-b", "feature/mc"], dir);

  // commit 1: api work
  writeFile(dir, "src/api/users.ts", "export const u = [];\n");
  await commit(dir, "feat: add users endpoint", 60);

  // commit 2: ONE commit spans api + docs (the "mixed concerns" pattern)
  writeFile(dir, "src/api/users.ts", "export const u: number[] = [];\n");
  writeFile(dir, "docs/users.md", "# Users\n");
  await commit(dir, "wip: types and docs", 120);

  // commit 3: docs work
  writeFile(dir, "docs/users.md", "# Users\n\nList users via /users.\n");
  await commit(dir, "docs: expand users page", 180);

  return { dir, branch: "feature/mc", cleanup };
}

export async function buildHugeFixture(commitCount = 60): Promise<FixtureRepo> {
  const { dir, cleanup } = makeTmpRepo("huge");
  await initRepo(dir, "main");
  writeFile(dir, "README.md", "# huge\n");
  await commit(dir, "chore: init", 0);
  await run(["checkout", "-q", "-b", "feature/huge"], dir);

  for (let i = 1; i <= commitCount; i++) {
    const area = i % 3 === 0 ? "src/api" : i % 3 === 1 ? "src/lib" : "tests";
    const file = `${area}/file_${i}.ts`;
    // ~30 lines per file to exercise diff truncation
    const content = Array.from({ length: 30 }, (_, j) => `export const v${i}_${j} = ${j};`).join("\n") + "\n";
    writeFile(dir, file, content);
    await commit(dir, `feat: add ${file}`, 60 * i);
  }

  return { dir, branch: "feature/huge", cleanup };
}

export async function buildAgentTrailersFixture(): Promise<FixtureRepo> {
  const { dir, cleanup } = makeTmpRepo("agent-trailers");
  await initRepo(dir, "main");
  writeFile(dir, "README.md", "# at\n");
  await commit(dir, "chore: init", 0);
  await run(["checkout", "-q", "-b", "feature/at"], dir);

  writeFile(dir, "src/api/orders.ts", "export const orders = [];\n");
  await commit(
    dir,
    [
      "feat: add orders endpoint",
      "",
      "Builds the initial orders endpoint with an in-memory store.",
      "",
      "🤖 Generated with [Claude Code](https://claude.ai/code)",
      "",
      "Co-authored-by: Claude <noreply@anthropic.com>",
    ].join("\n"),
    60,
  );

  writeFile(dir, "src/api/orders.ts", "export const orders: number[] = [];\n");
  await commit(
    dir,
    [
      "fix: type orders array",
      "",
      "🤖 Generated with [Claude Code](https://claude.ai/code)",
      "",
      "Co-authored-by: Claude <noreply@anthropic.com>",
    ].join("\n"),
    120,
  );

  return { dir, branch: "feature/at", cleanup };
}

export async function buildHumanPairFixture(): Promise<FixtureRepo> {
  const { dir, cleanup } = makeTmpRepo("human-pair");
  await initRepo(dir, "main");
  writeFile(dir, "README.md", "# hp\n");
  await commit(dir, "chore: init", 0);
  await run(["checkout", "-q", "-b", "feature/hp"], dir);

  writeFile(dir, "src/lib/jobs.ts", "export const run = () => {};\n");
  await commit(
    dir,
    [
      "feat: add jobs runner",
      "",
      "Pair work with Priya.",
      "",
      "Signed-off-by: Sid Nigam <sid@example.com>",
      "Co-authored-by: Priya Patel <priya@example.com>",
      "Closes: #42",
    ].join("\n"),
    60,
  );

  writeFile(dir, "src/lib/jobs.ts", "export const run = (): void => {};\n");
  await commit(
    dir,
    [
      "refactor: type jobs runner",
      "",
      "Co-authored-by: Priya Patel <priya@example.com>",
    ].join("\n"),
    120,
  );

  return { dir, branch: "feature/hp", cleanup };
}

export async function buildConflictFixture(): Promise<{
  repo: FixtureRepo;
  parentSha: string;
  childSha: string;
}> {
  const { dir, cleanup } = makeTmpRepo("conflict");
  await initRepo(dir, "main");
  // Single-line file at base. Both parent and child modify the same line.
  writeFile(dir, "src/c.ts", "version: 1\n");
  await commit(dir, "chore: init", 0);
  await run(["checkout", "-q", "-b", "feature/c"], dir);

  writeFile(dir, "src/c.ts", "version: 2\n");
  const parentSha = await commit(dir, "feat: bump to 2", 60);

  // Child changes the line again. Drop parent and the context "version: 2" is missing.
  writeFile(dir, "src/c.ts", "version: 3\n");
  const childSha = await commit(dir, "feat: bump to 3", 120);

  return {
    repo: { dir, branch: "feature/c", cleanup },
    parentSha,
    childSha,
  };
}
