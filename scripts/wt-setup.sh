#!/bin/zsh
# Creates a task worktree <worktreeRoot>/<name> on a new branch and gives it its own copy of git-ignored data
# (project config key worktreeSetup): for each ignored path under the "scan" directories of the main checkout -
#   matches "skip" -> not copied; matches "link" -> symlinked; anything else -> a copy-on-write clone, never a symlink:
#   guards and server starts in a worktree must not write into the main checkout's data (a symlinked corpus was once
#   wiped by an orphan cleanup in a worktree). The clone is tried by what works, not by the name of the system: the
#   APFS clone (cp -c), then the GNU form (cp -r --reflink=auto: a reflink where the file system has one, a plain copy
#   otherwise), then a plain cp -R. A refused attempt may leave a partial target; it is removed before the next one, or
#   cp would copy into it as a nested directory.
# The base is the third argument, else the project's default branch (config.js default-branch: key defaultBranch, else
# origin/HEAD); when that is unknown, exit 78 with the reason and nothing is created.
# --detach: a worktree detached at <commit>, no branch created (the train dispatcher, scripts/train.js: its temporary
# tree must not add a branch; the ignored data is cloned the same way).
# usage: wt-setup.sh <name> <branch> [base=the default branch]
#        wt-setup.sh --detach <name> <commit>
set -e
H=${0:A:h}
DETACH=0; [[ $1 == --detach ]] && { DETACH=1; shift }
[[ -n $1 && -n $2 ]] || { print -u2 "usage: wt-setup.sh <name> <branch> [base=the default branch] | --detach <name> <commit>"; exit 64; }
cfg() { node "$H/config.js" get "$1" }
MAIN=$(cfg repoDir); ROOT=$(cfg worktreeRoot)
base=$3; (( DETACH )) && base=$2
if [[ -z $base ]]; then
  rc=0; base=$(node "$H/config.js" default-branch) || rc=$?
  (( rc == 78 )) && { print -u2 -r -- "wt-setup.sh: no worktree created - $base; or pass the base branch as the third argument"; exit 78 }
  (( rc == 0 )) || exit $rc
fi
WT=$ROOT/$1
scan=( ${(f)"$(node -e 'for (const x of JSON.parse(process.argv[1])) console.log(x)' "$(cfg worktreeSetup.scan)")"} )
skip=( ${(f)"$(node -e 'for (const x of JSON.parse(process.argv[1])) console.log(x)' "$(cfg worktreeSetup.skip)")"} )
link=( ${(f)"$(node -e 'for (const x of JSON.parse(process.argv[1])) console.log(x)' "$(cfg worktreeSetup.link)")"} )
if (( DETACH )); then git -C "$MAIN" worktree add --detach "$WT" "$base"; else git -C "$MAIN" worktree add "$WT" -b "$2" "$base"; fi
matches() { local p=$1 g; shift; for g in "$@"; do [[ -n $g && $p == ${~g} ]] && return 0; done; return 1 }
clone() {
  cp -cR "$1" "$2" 2>/dev/null && return
  rm -rf -- "$2"; cp -r --reflink=auto "$1" "$2" 2>/dev/null && return
  rm -rf -- "$2"; cp -R "$1" "$2"
}
(( ${#scan} )) && git -C "$MAIN" status --porcelain --ignored -- $scan | grep '^!!' | sed 's/^!! //; s#/$##' | while read -r p; do
  if [[ -z $p ]] || matches "$p" $skip; then continue
  elif matches "$p" $link; then mkdir -p "$WT/${p:h}"; ln -s "$MAIN/$p" "$WT/$p"
  else mkdir -p "$WT/${p:h}"; clone "$MAIN/$p" "$WT/$p"
  fi
done
print -r -- "ready $WT"
