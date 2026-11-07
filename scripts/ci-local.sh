#!/usr/bin/env bash
# Local CI: the merge gate, run on this machine instead of GitHub Actions.
#
# Usage:
#   npm run ci:local                 # checks this checkout's changes against origin/main
#   npm run ci:local -- --pr 174     # merges PR 174 onto origin/main in a throwaway worktree and checks that
#   npm run ci:local -- --base <ref> # compare against another base
#   npm run ci:local -- --all-tests  # run every test file (the full suite; not on a loaded machine)
#
# It runs the test files the change touches plus every test file that names a changed module, with credentials
# unreachable (empty HOME, a minimal environment, so no test can bill), then the typecheck, the MCP docs check and the
# JS-primitives lint. It exits non-zero on any failure. The tested commit is printed so a merge can use
# --match-head-commit.
set -euo pipefail

BASE="origin/main"
PR=""
ALL=0
WORKERS="${CI_LOCAL_WORKERS:-3}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --pr) PR="$2"; shift 2 ;;
    --all-tests) ALL=1; shift ;;
    --workers) WORKERS="$2"; shift 2 ;;
    *) echo "ci-local: unknown argument $1" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
NODE_BIN=""
if [ -x "$HOME/.nvm/versions/node/v22.18.0/bin/node" ]; then
  NODE_BIN="$HOME/.nvm/versions/node/v22.18.0/bin"
else
  NODE_BIN="$(dirname "$(command -v node)")"
fi
NODE_MAJOR="$("$NODE_BIN/node" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ci-local: needs Node 22 or later (node:sqlite); found $("$NODE_BIN/node" -v)" >&2
  exit 2
fi

LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/ci-local.XXXXXX")"
WT=""
cleanup() { if [ -n "$WT" ]; then git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT

git -C "$ROOT" fetch -q origin "${BASE#origin/}" || true

if [ -n "$PR" ]; then
  command -v gh >/dev/null || { echo "ci-local: --pr needs the gh CLI" >&2; exit 2; }
  HEAD_REF="$(gh pr view "$PR" --json headRefName --jq .headRefName)"
  HEAD_SHA="$(gh pr view "$PR" --json headRefOid --jq .headRefOid)"
  git -C "$ROOT" fetch -q origin "$HEAD_REF"
  WT="$(mktemp -d "${TMPDIR:-/tmp}/ci-local-wt.XXXXXX")"
  rmdir "$WT"
  git -C "$ROOT" worktree add -q --detach "$WT" "$BASE"
  git -C "$WT" -c user.name=ci-local -c user.email=ci-local@localhost merge -q --no-ff -m "ci-local: PR $PR onto $BASE" "$HEAD_SHA" \
    || { echo "ci-local: PR $PR does not merge cleanly onto $BASE" >&2; exit 1; }
  # node_modules are not in a fresh worktree: share the installed ones, the root's and each package's own. A checkout
  # without its own install (a session worktree) borrows the main checkout's. Paths are matched relative to that
  # checkout, so one living under .claude/worktrees/ still finds its own.
  NM_SRC="$ROOT"
  [ -e "$NM_SRC/node_modules" ] || NM_SRC="$(git -C "$ROOT" worktree list --porcelain | sed -n '1s/^worktree //p')"
  while IFS= read -r rel; do
    rel="${rel#./}"
    [ -e "$WT/$rel" ] || { mkdir -p "$(dirname "$WT/$rel")"; ln -s "$NM_SRC/$rel" "$WT/$rel"; }
  done < <(cd "$NM_SRC" && find . -maxdepth 3 \( -type d -o -type l \) -name node_modules -not -path '*/node_modules/*' -not -path './.claude/*' 2>/dev/null)
  [ -e "$WT/node_modules" ] || { echo "ci-local: no installed node_modules found (run npm install in $NM_SRC)" >&2; exit 2; }
  WORK="$WT"
  TESTED="PR $PR head $HEAD_SHA merged onto $(git -C "$ROOT" rev-parse --short "$BASE")"
else
  WORK="$ROOT"
  TESTED="$(git -C "$ROOT" rev-parse HEAD) (plus uncommitted changes)"
  [ -e "$ROOT/node_modules" ] || { echo "ci-local: $ROOT has no node_modules; run npm install there, or check a pushed branch with --pr N" >&2; exit 2; }
fi
cd "$WORK"

MERGE_BASE="$(git merge-base HEAD "$BASE")"
CHANGED="$( { git diff --name-only "$MERGE_BASE" HEAD; if [ -z "$PR" ]; then git diff --name-only HEAD; fi; } | sort -u)"

TESTDIRS="packages/core/test packages/cli/test desktop-app/test"
TESTS_FILE="$LOGDIR/tests.txt"
if [ "$ALL" = 1 ]; then
  find $TESTDIRS -name '*.test.ts' 2>/dev/null | sort > "$TESTS_FILE"
else
  : > "$TESTS_FILE"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      *.test.ts) [ -f "$f" ] && echo "$f" >> "$TESTS_FILE"; continue ;;
    esac
    case "$f" in
      *.ts|*.tsx|*.hpp|*.cpp|*.h|*.py|*.mjs|*.js) ;;
      *) continue ;;
    esac
    name="$(basename "$f")"; stem="${name%.*}"
    # A test that names the module (by import path or file name) exercises it.
    grep -rlF --include='*.test.ts' "$stem" $TESTDIRS 2>/dev/null >> "$TESTS_FILE" || true
  done <<< "$CHANGED"
  # Instructions and tool declarations drift together; always check them.
  echo "packages/core/test/instruction-tool-drift.test.ts" >> "$TESTS_FILE"
  sort -u -o "$TESTS_FILE" "$TESTS_FILE"
fi

N="$(wc -l < "$TESTS_FILE" | tr -d ' ')"
echo "ci-local: testing $TESTED"
echo "ci-local: $(echo "$CHANGED" | grep -c . || true) changed files, $N test files; logs in $LOGDIR"

STATUS=0
EMPTY_HOME="$(mktemp -d)"
run() { # name, command...
  local name="$1"; shift
  if "$@" > "$LOGDIR/$name.log" 2>&1; then echo "  pass  $name"; else echo "  FAIL  $name (see $LOGDIR/$name.log)"; STATUS=1; fi
}

if [ "$N" -gt 0 ]; then
  run tests env -i PATH="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" HOME="$EMPTY_HOME" SCRATCHBOX_TEST=1 \
    xargs "$NODE_BIN/npx" vitest run --minWorkers=1 --maxWorkers="$WORKERS" --hookTimeout=300000 < "$TESTS_FILE"
  grep -E "Test Files|Tests  " "$LOGDIR/tests.log" | sed 's/^/        /' || true
  grep -E "^ FAIL " "$LOGDIR/tests.log" | sort -u | sed 's/^/        /' || true
fi
run typecheck env PATH="$NODE_BIN:$PATH" npm run -s typecheck
run docs-mcp env PATH="$NODE_BIN:$PATH" npm run -s docs:mcp:check
run lint-primitives env PATH="$NODE_BIN:$PATH" npm run -s lint:primitives

if [ "$STATUS" = 0 ]; then
  echo "ci-local: PASS ($TESTED)"
else
  echo "ci-local: FAIL ($TESTED)"
  echo "ci-local: a failure that also fails on $BASE alone is not this change's; check with --base and an unchanged checkout."
fi
exit "$STATUS"
