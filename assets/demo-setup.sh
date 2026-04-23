#!/bin/bash
# Sets up a deterministic "messy agent commit" repo for the VHS demo.
set -e

DIR="${1:-/tmp/atropos-demo}"
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"

git init -q -b main
git config user.name "Sid"
git config user.email "sid@example.com"
git config commit.gpgsign false

# helper
commit() {
  git add -A
  GIT_AUTHOR_DATE="2026-04-22T10:00:00Z" GIT_COMMITTER_DATE="2026-04-22T10:00:00Z" \
    git commit -q --no-verify -m "$1"
}

echo "# invoices service" > README.md
commit "chore: init"

git checkout -q -b feature/invoices

mkdir -p src/api
cat > src/api/invoices.ts <<'TS'
export const list = () => [];
TS
commit "feat: add /invoices endpoint

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"

cat > src/api/invoices.ts <<'TS'
export const list = () => [{ id: 1 }];
TS
commit "wip"

cat > src/api/middleware.ts <<'TS'
export const auth = () => {};
TS
commit "try alternate approach with middleware

Co-Authored-By: Claude <noreply@anthropic.com>"

rm src/api/middleware.ts
commit "revert middleware, doesn't work

Co-Authored-By: Claude <noreply@anthropic.com>"

cat > src/api/invoices.ts <<'TS'
export const list = (): Array<{ id: number }> => [{ id: 1 }];
TS
commit "fix typo in handler"

mkdir -p tests
cat > tests/invoices.test.ts <<'TS'
import { list } from '../src/api/invoices';
test('list returns invoices', () => expect(list()).toHaveLength(1));
TS
commit "test: cover /invoices

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
