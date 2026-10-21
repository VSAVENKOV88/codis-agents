#!/bin/zsh
# guardExclusive.glob (U2b-2, after review 1): config.js check and the runtime (heavy.sh -> slots.zsh
# slot_is_exclusive_guard, ${a:t} == ${~g} under extendedglob) agree on every glob - what check accepts never aborts
# heavy.sh with "bad pattern", what it refuses makes heavy.sh exit 78 without running the command - and a glob is a
# pattern only: command substitution in it never runs, neither in check nor in heavy.sh. A valid extendedglob pattern
# accepted by check matches at runtime (the guard takes the exclusive lock). Temporary slot directory, fake machine.
#   usage: tests/runner-neutral-globs.test.sh   (zsh; the exclusive cases need lockf(1) or flock(1), as slots.zsh does)
H=${0:A:h:h}/scripts
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/runner-globs.XXXXXX")
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK=$T/guards.lock SLOT_POLL=0.3 SLOT_SAY=1 SLOT_JOURNAL=$T/journal.tsv
unset GUARDS_EXCLUSIVE_LOCK SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_PROC SLOT_THIRD_WINDOW SLOT_HIST_GAP GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
# the fake machine below is a macOS one, on Linux too: the readings follow SLOT_OS, not the box
export SLOT_OS=darwin
trap 'rm -rf $T' EXIT
mkdir -p $T/wts/w/tests $T/shared $T/bin
print -r -- '#!/bin/zsh
[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"
print -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"' > $T/bin/sysctl
print -r -- '#!/bin/zsh
print -r -- "System-wide memory free percentage: 80%"' > $T/bin/memory_pressure
print -r -- '#!/bin/zsh
print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
print -r -- "Swapins:                                    5."
print -r -- "Swapouts:                                   5."' > $T/bin/vm_stat
print -r -- '#!/bin/zsh
print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"
print -r -- "/dev/disk3s6 100000 0 50000 50% /System/Volumes/VM"' > $T/bin/df
chmod +x $T/bin/*; export PATH=$T/bin:$PATH
# The worktrees are linked worktrees of one repository: guards-all.sh refuses a main working copy (main-checkout.js).
git init -q $T/repo && git -C $T/repo -c user.email=t@t -c user.name=t commit -q --allow-empty -m x
git -C $T/repo worktree add -q --detach $T/wts/w && cd $T/wts/w
print -r -- '# guards:exclusive — a fixed port' > tests/test_2.py
pass=0 fail=0 skipped=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
skip() { (( skipped++ )); print -r -- "  skip $1 - skipped: $2" }
# cfg <glob>: a config with guardExclusive {glob: [<glob>], marker: #}; JSON-quoted by node
cfg() { print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared", "guardCommand": "cd {wt} && true", "guardExclusive": {"glob": ['"$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$1")"'], "marker": "#"}}' > $T/c.json }
export CODIS_AGENTS_CONFIG=$T/c.json
tool=; for t in /usr/bin/lockf /usr/bin/flock /bin/flock; do [[ -x $t ]] && { tool=$t; break }; done

# -- E. check and runtime agree, glob by glob -----------------------------------------------------------------------
# bad: zsh cannot compile them under extendedglob; good: extendedglob patterns that compile (some match test_2.py)
typeset -A MATCH=( 'test_<1-3>.py' 1 '(#i)TEST_*.py' 1 '*.py~x*' 1 '(#a1)test_2.py' 1 '^x*' 1 'test_[0-9].py' 1
  'test_<.py' 0 'x##' 0 '[[:bogus:]]*' 0 '(|)' 0 '|x' 0 '[]' 0 '(#qN)x' 0 )
BAD=( 'test_[.py' '((((' 'test_?.py(' ')x' '(#X)x' '(#' '*(' )
for g in ${(k)MATCH}; do
  cfg $g; c=$(node $H/config.js check $T/c.json 2>&1); crc=$?
  : > $T/journal.tsv; rm -f $T/ran
  $H/heavy.sh touch $T/ran tests/test_2.py > $T/h.out 2>&1; rc=$?
  ok "E1. [$g] check ok and heavy.sh runs the command (no \"bad pattern\")" '(( crc == 0 && rc == 0 )) && [[ -e $T/ran ]] && ! grep -q "bad pattern" $T/h.out' "check $crc: $c | heavy $rc: $(<$T/h.out)"
  if [[ -z $tool ]]; then skip "E2. [$g] exclusive iff it matches test_2.py" 'no lockf/flock'
  elif (( MATCH[$g] )); then ok "E2. [$g] matches test_2.py: heavy.sh takes the exclusive lock" 'grep -q exclusive $T/journal.tsv' "$(<$T/journal.tsv)"
  else ok "E2. [$g] does not match test_2.py: no exclusive lock" '! grep -q exclusive $T/journal.tsv' "$(<$T/journal.tsv)"; fi
done
for g in $BAD; do
  cfg $g; c=$(node $H/config.js check $T/c.json 2>&1); crc=$?
  rm -f $T/ran; $H/heavy.sh touch $T/ran tests/test_2.py > $T/h.out 2>&1; rc=$?
  ok "E3. [$g] check refuses it by name and heavy.sh exits 78, the command not run" \
    '(( crc != 0 )) && [[ $c == *"not a valid zsh pattern"* ]] && (( rc == 78 )) && [[ ! -e $T/ran ]] && ! grep -q "bad pattern" $T/h.out' "check $crc: $c | heavy $rc: $(<$T/h.out)"
done

# -- I. a glob is a pattern, not a command -------------------------------------------------------------------------
for g in '$(touch '$T'/pwn1)x' '`touch '$T'/pwn2`' '${$(touch '$T'/pwn3)}'; do
  cfg $g; node $H/config.js check $T/c.json > /dev/null 2>&1
  $H/heavy.sh true tests/test_2.py > /dev/null 2>&1
done
ok 'I1. command substitution in a glob runs neither in config.js check nor in heavy.sh' '[[ -z $(print -l $T/pwn*(N)) ]]' "$(print -l $T/pwn*(N))"

print -r -- "$pass ok, $fail failed$( (( skipped )) && print -n ", $skipped skipped: no lockf/flock")"
(( fail == 0 ))
