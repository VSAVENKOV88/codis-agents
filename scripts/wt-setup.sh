#!/bin/zsh
# Creates a task worktree <worktreeRoot>/<name> on a new branch and gives it its own copy of git-ignored data
# (project config key worktreeSetup): for each ignored path under the "scan" directories of the main checkout -
#   matches "skip" -> not copied; matches "link" -> symlinked; anything else -> APFS clone (cp -c), never a symlink:
#   guards and server starts in a worktree must not write into the main checkout's data (a symlinked corpus was once
#   wiped by an orphan cleanup in a worktree).
# usage: wt-setup.sh <name> <branch> [base=main]
set -e
H=${0:A:h}
[[ -n $1 && -n $2 ]] || { print -u2 "usage: wt-setup.sh <name> <branch> [base=main]"; exit 64; }
cfg() { node "$H/config.js" get "$1" }
MAIN=$(cfg repoDir); ROOT=$(cfg worktreeRoot)
WT=$ROOT/$1
scan=( ${(f)"$(node -e 'for (const x of JSON.parse(process.argv[1])) console.log(x)' "$(cfg worktreeSetup.scan)")"} )
skip=( ${(f)"$(node -e 'for (const x of JSON.parse(process.argv[1])) console.log(x)' "$(cfg worktreeSetup.skip)")"} )
link=( ${(f)"$(node -e 'for (const x of JSON.parse(process.argv[1])) console.log(x)' "$(cfg worktreeSetup.link)")"} )
git -C "$MAIN" worktree add "$WT" -b "$2" "${3:-main}"
matches() { local p=$1 g; shift; for g in "$@"; do [[ -n $g && $p == ${~g} ]] && return 0; done; return 1 }
clone() { cp -cR "$1" "$2" 2>/dev/null || cp -R "$1" "$2" }   # -c is the APFS clone; plain copy elsewhere
(( ${#scan} )) && git -C "$MAIN" status --porcelain --ignored -- $scan | grep '^!!' | sed 's/^!! //; s#/$##' | while read -r p; do
  if matches "$p" $skip; then continue
  elif matches "$p" $link; then mkdir -p "$WT/${p:h}"; ln -s "$MAIN/$p" "$WT/$p"
  else mkdir -p "$WT/${p:h}"; clone "$MAIN/$p" "$WT/$p"
  fi
done
print -r -- "ready $WT"
