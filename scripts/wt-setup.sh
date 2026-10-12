#!/bin/zsh
# Creates a task worktree <worktreeRoot>/<name> on a new branch and gives it its own copy of git-ignored data
# (project config key worktreeSetup): for each ignored path under the "scan" directories of the main checkout -
#   matches "skip" -> not copied; matches "link" -> symlinked; anything else -> a copy-on-write clone, never a symlink:
#   guards and server starts in a worktree must not write into the main checkout's data (a symlinked corpus was once
#   wiped by an orphan cleanup in a worktree). The clone is tried by what works, not by the name of the system: the
#   APFS clone (cp -c), then the GNU form (cp -r --reflink=auto: a reflink where the file system has one, a plain copy
#   otherwise), then a plain cp -R. A refused attempt may leave a partial target; it is removed before the next one, or
#   cp would copy into it as a nested directory.
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
