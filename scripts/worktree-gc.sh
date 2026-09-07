#!/bin/bash
# Agent-worktree GC: remove the throwaway worktrees under `.claude/worktrees/`
# whose work has fully landed on origin/main, and leave everything else alone.
#
# A worktree is ELIGIBLE only if ALL of these hold:
#   1. clean   — `git status --porcelain --untracked-files=all` is empty
#                (a worktree whose path is gone is a prunable stale record)
#   2. landed  — either its HEAD is an ancestor of origin/main (every commit it
#                carries is on main; a worktree still sitting on its branch
#                point has no unique commits and passes here), or its branch is
#                the head of a MERGED pull request whose merged tip is exactly
#                this HEAD. The second leg is what this repo actually needs:
#                PRs land SQUASHED, so a landed branch tip is never an ancestor
#                of main. It asks `gh` for the merged-PR head refs once per run
#                and requires an exact SHA match, so a branch that gained
#                commits after its PR merged is not eligible.
#   3. older than 24 h — judged by the newest mtime among its `.git` file and
#                the HEAD/index in its gitdir, so a live agent's worktree
#                always reads as young
#
# Only paths under `.claude/worktrees/` are candidates: the primary checkout
# and any other worktree are never touched, and BRANCHES ARE NEVER DELETED —
# in this repo the branches are the audit trail.
#
# Default mode is a DRY RUN. `--apply` performs `git worktree remove` (never
# `--force`: dirtiness is the guard) followed by `git worktree prune`.
#
# Usage: bash scripts/worktree-gc.sh [--apply] [--json] [--offline]
set -euo pipefail

APPLY=0
JSON=0
OFFLINE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --json) JSON=1 ;;
    --offline) OFFLINE=1 ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "worktree-gc: unknown argument '$arg' (accepts --apply, --json, --offline)" >&2
      exit 2
      ;;
  esac
done

# Act on the repo that CONTAINS this script, whichever worktree it was invoked
# from: the shared worktree list is the same seen from every one of them.
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMMON_DIR=$(cd "$REPO_DIR" && git rev-parse --path-format=absolute --git-common-dir)
PRIMARY=$(cd "$COMMON_DIR/.." && pwd)
HERE=$(cd "$REPO_DIR" && git rev-parse --show-toplevel)

MIN_AGE_SECONDS=$((24 * 60 * 60))
NOW=$(date +%s)

log() { if [ "$JSON" -eq 0 ]; then echo "$@"; fi; }

log "[worktree-gc] repo: $PRIMARY"
if ! (cd "$REPO_DIR" && git fetch --quiet origin main 2>/dev/null); then
  log "[worktree-gc] WARNING: 'git fetch origin main' failed — judging merge state against the origin/main already on disk"
fi
if ! (cd "$REPO_DIR" && git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null); then
  echo "worktree-gc: refs/remotes/origin/main does not exist — cannot judge merge state" >&2
  exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mtime_of() {
  # macOS stat first, GNU stat as the fallback; 0 when the path is absent.
  if [ ! -e "$1" ]; then
    echo 0
    return 0
  fi
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

newest_mtime() {
  local newest=0 candidate m
  for candidate in "$@"; do
    m=$(mtime_of "$candidate")
    if [ "$m" -gt "$newest" ]; then newest="$m"; fi
  done
  echo "$newest"
}

human_age() {
  local seconds=$1
  if [ "$seconds" -lt 3600 ]; then
    echo "$((seconds / 60))m"
  elif [ "$seconds" -lt 172800 ]; then
    echo "$((seconds / 3600))h"
  else
    echo "$((seconds / 86400))d"
  fi
}

# The merged-PR table: "<merged head sha> <branch> <pr number>" per line. It is
# loaded ONCE, before the walk — the per-worktree lookup runs inside a command
# substitution, where any state it set would be lost with the subshell.
PR_TABLE_STATE=untried
load_pr_table() {
  if [ "$OFFLINE" -eq 1 ]; then
    PR_TABLE_STATE=unavailable
    log "[worktree-gc] --offline: squash-merged branches are judged unmerged (the ancestor leg only)"
    return 0
  fi
  if ! command -v gh >/dev/null 2>&1; then
    PR_TABLE_STATE=unavailable
    log "[worktree-gc] WARNING: 'gh' not found — squash-merged branches will read as unmerged"
    return 0
  fi
  if (cd "$REPO_DIR" && gh pr list --state merged --limit 1000 \
    --json headRefName,headRefOid,number \
    --jq '.[] | "\(.headRefOid) \(.headRefName) \(.number)"') >"$WORK/merged-prs" 2>"$WORK/gh.err"; then
    PR_TABLE_STATE=ready
    log "[worktree-gc] merged PRs consulted: $(wc -l <"$WORK/merged-prs" | tr -d ' ')"
  else
    PR_TABLE_STATE=unavailable
    log "[worktree-gc] WARNING: 'gh pr list' failed — squash-merged branches will read as unmerged"
    if [ -s "$WORK/gh.err" ]; then log "[worktree-gc]   $(head -1 "$WORK/gh.err")"; fi
  fi
}

merged_pr_number() {
  # merged_pr_number <head sha> <branch>; prints the PR number when that exact
  # tip is the merged head of a PR for that branch.
  if [ "$PR_TABLE_STATE" != ready ]; then return 1; fi
  awk -v sha="$1" -v branch="$2" \
    '$1 == sha && $2 == branch { print $3; found = 1; exit } END { exit(found ? 0 : 1) }' \
    "$WORK/merged-prs"
}

load_pr_table
(cd "$REPO_DIR" && git worktree list --porcelain) >"$WORK/porcelain"

ELIGIBLE=0
SKIP_DIRTY=0
SKIP_UNMERGED=0
SKIP_YOUNG=0
SKIP_SELF=0
NON_CANDIDATES=0
REMOVED=0
REMOVE_FAILED=0

if [ "$JSON" -eq 1 ]; then
  echo "["
  JSON_FIRST=1
else
  printf '%-46s  %-40s  %5s  %-8s  %s\n' PATH BRANCH AGE VERDICT REASON
  printf '%-46s  %-40s  %5s  %-8s  %s\n' \
    "----------------------------------------------" \
    "----------------------------------------" \
    "-----" "--------" "------"
fi

emit() {
  # emit <path> <branch> <age> <verdict> <reason>
  if [ "$JSON" -eq 1 ]; then
    if [ "$JSON_FIRST" -eq 0 ]; then echo ","; fi
    JSON_FIRST=0
    printf '  {"path": "%s", "branch": "%s", "age": "%s", "verdict": "%s", "reason": "%s"}' \
      "$1" "$2" "$3" "$4" "$5"
  else
    printf '%-46s  %-40s  %5s  %-8s  %s\n' "$1" "$2" "$3" "$4" "$5"
  fi
}

consider() {
  local wt_path=$1 wt_head=$2 wt_branch=$3
  local display=${wt_path#"$PRIMARY"/}
  local branch=${wt_branch#refs/heads/}
  if [ -z "$branch" ]; then branch="(detached)"; fi

  case "$wt_path" in
    */.claude/worktrees/*) ;;
    *)
      NON_CANDIDATES=$((NON_CANDIDATES + 1))
      return 0
      ;;
  esac

  if [ "$wt_path" = "$HERE" ]; then
    SKIP_SELF=$((SKIP_SELF + 1))
    emit "$display" "$branch" "-" SKIPPED "self (this run is executing inside it)"
    return 0
  fi

  # A gone path is a stale record: nothing to inspect, `prune` reclaims it.
  if [ ! -d "$wt_path" ]; then
    ELIGIBLE=$((ELIGIBLE + 1))
    emit "$display" "$branch" "-" ELIGIBLE "stale record (path no longer on disk)"
    if [ "$APPLY" -eq 1 ]; then
      log "[worktree-gc] stale record left to 'git worktree prune': $display"
    fi
    return 0
  fi

  local gitdir="" head_file="" index_file=""
  if [ -f "$wt_path/.git" ]; then
    gitdir=$(sed -n 's/^gitdir: //p' "$wt_path/.git" | head -1)
  fi
  if [ -n "$gitdir" ] && [ -d "$gitdir" ]; then
    head_file="$gitdir/HEAD"
    index_file="$gitdir/index"
  fi
  local newest age age_text
  newest=$(newest_mtime "$wt_path/.git" "$head_file" "$index_file")
  age=$((NOW - newest))
  if [ "$age" -lt 0 ]; then age=0; fi
  age_text=$(human_age "$age")

  local dirty_count
  if ! dirty_count=$(cd "$wt_path" && git status --porcelain --untracked-files=all 2>/dev/null | wc -l | tr -d ' '); then
    SKIP_DIRTY=$((SKIP_DIRTY + 1))
    emit "$display" "$branch" "$age_text" SKIPPED "unreadable (git status failed here)"
    return 0
  fi
  if [ "$dirty_count" -ne 0 ]; then
    SKIP_DIRTY=$((SKIP_DIRTY + 1))
    emit "$display" "$branch" "$age_text" SKIPPED "dirty ($dirty_count uncommitted path(s))"
    return 0
  fi

  local landed_reason=""
  if (cd "$REPO_DIR" && git merge-base --is-ancestor "$wt_head" refs/remotes/origin/main 2>/dev/null); then
    landed_reason="merged into origin/main"
  else
    local pr=""
    if [ "$branch" != "(detached)" ]; then
      pr=$(merged_pr_number "$wt_head" "$branch" || true)
    fi
    if [ -n "$pr" ]; then
      landed_reason="landed as squash-merged PR #$pr"
    else
      local ahead
      ahead=$(cd "$REPO_DIR" && git rev-list --count refs/remotes/origin/main.."$wt_head" 2>/dev/null || echo "?")
      SKIP_UNMERGED=$((SKIP_UNMERGED + 1))
      emit "$display" "$branch" "$age_text" SKIPPED "unmerged ($ahead commit(s) not on origin/main, no merged PR at this tip)"
      return 0
    fi
  fi

  if [ "$age" -lt "$MIN_AGE_SECONDS" ]; then
    SKIP_YOUNG=$((SKIP_YOUNG + 1))
    emit "$display" "$branch" "$age_text" SKIPPED "young (touched $age_text ago, under 24h)"
    return 0
  fi

  ELIGIBLE=$((ELIGIBLE + 1))
  emit "$display" "$branch" "$age_text" ELIGIBLE "$landed_reason, clean, idle $age_text"
  if [ "$APPLY" -eq 1 ]; then
    if (cd "$REPO_DIR" && git worktree remove "$wt_path" 2>>"$WORK/remove.err"); then
      REMOVED=$((REMOVED + 1))
    else
      REMOVE_FAILED=$((REMOVE_FAILED + 1))
      log "[worktree-gc] FAILED to remove $display (not retried with --force by design)"
    fi
  fi
}

wt_path=""
wt_head=""
wt_branch=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "worktree "*)
      wt_path=${line#worktree }
      wt_head=""
      wt_branch=""
      ;;
    "HEAD "*) wt_head=${line#HEAD } ;;
    "branch "*) wt_branch=${line#branch } ;;
    "")
      if [ -n "$wt_path" ]; then consider "$wt_path" "$wt_head" "$wt_branch"; fi
      wt_path=""
      ;;
  esac
done <"$WORK/porcelain"
if [ -n "$wt_path" ]; then consider "$wt_path" "$wt_head" "$wt_branch"; fi

if [ "$JSON" -eq 1 ]; then
  echo ""
  echo "]"
  exit 0
fi

if [ "$APPLY" -eq 1 ]; then
  (cd "$REPO_DIR" && git worktree prune)
  if [ -s "$WORK/remove.err" ]; then cat "$WORK/remove.err" >&2; fi
fi

CANDIDATES=$((ELIGIBLE + SKIP_DIRTY + SKIP_UNMERGED + SKIP_YOUNG + SKIP_SELF))
echo ""
echo "[worktree-gc] candidates under .claude/worktrees/: $CANDIDATES (other worktrees, the primary included: $NON_CANDIDATES — never touched)"
echo "[worktree-gc] eligible: $ELIGIBLE   skipped: dirty $SKIP_DIRTY · unmerged $SKIP_UNMERGED · young $SKIP_YOUNG · self $SKIP_SELF"
if [ "$APPLY" -eq 1 ]; then
  echo "[worktree-gc] removed: $REMOVED   failed: $REMOVE_FAILED   (branches untouched — they are the audit trail)"
else
  echo "[worktree-gc] DRY RUN — nothing removed. Re-run with --apply to remove the eligible worktrees (branches are never deleted)."
fi
