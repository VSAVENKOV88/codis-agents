#!/bin/zsh
# Tester's edges of U2b-2 (a runner not tied to one stack), next to tests/runner-neutral.test.sh:
#   - guardExclusive given through the project config with several globs (a blank and a quote inside one), the marker
#     indented, the marker taken literally (# and * are pattern characters of zsh extendedglob);
#   - the guards-all.sh log: two worktrees OUTSIDE worktreeRoot with the same basename get two logs, a worktree under
#     worktreeRoot given as a path with a trailing slash keeps guards-<name>.txt;
#   - a runner without {jobs}: its own exit code is the exit code (a red run is not retried, its 75 is not "no budget"),
#     guardCommandLegacy without {jobs} chosen by the probe runs the same way, and while it waits in the queue a later
#     single heavy job does not pass it (FIFO).
# On a TEMPORARY slot directory and a fake machine; the commands are sleeps and a fake pytest. Exit code 0 - all hold.
#   usage: tests/runner-neutral-edges.test.sh   (zsh)
H=${0:A:h:h}/scripts
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/runner-edges.XXXXXX")
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK=$T/guards.lock SLOT_POLL=0.3 SLOT_SAY=1 SLOT_JOURNAL=$T/journal.tsv
unset GUARDS_EXCLUSIVE_LOCK SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_THIRD_WINDOW SLOT_HIST_GAP GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
mkdir -p $T/wts $T/shared $T/bin $T/o1 $T/o2
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
cfg() { # cfg <file> <guardCommand> [extra json members]
  print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared", "guardCommand": "'$2'"'${3:+, $3}'}' > $1 }
cfg $T/py.json 'cd {wt} && pytest -q'
export CODIS_AGENTS_CONFIG=$T/py.json
# Fake pytest: "start <dir> <jobs of its slot>" in run.log; exits with the code in $T/rc (0 without it); runs on while
# $T/hold exists.
print -r -- '#!/bin/zsh
print -r -- "start ${PWD:h:t}/${PWD:t} $(<$SLOT_PATH.jobs 2>/dev/null)" >> '$T'/run.log
while [[ -e '$T'/hold ]]; do sleep 0.1; done
print -r -- "1 passed in 0.01s"
[[ -e '$T'/rc ]] && exit $(<'$T'/rc); exit 0' > $T/bin/pytest
chmod +x $T/bin/*; export PATH=$T/bin:$PATH
for d in wts/xp o1/xp o2/xp; do mkdir -p $T/$d; git -C $T/$d init -q; git -C $T/$d -c user.email=t@t -c user.name=t commit -q --allow-empty -m x; done
pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
waitlong() { local i; for i in {1..900}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
hjob() { "$H/heavy.sh" zsh -c 'touch '$T'/$1.start; while [[ ! -e '$T'/rel.$1 ]]; do sleep 0.1; done; touch '$T'/$1.end' _ $1 > $T/$1.out 2>&1 & }
trap 'touch $T/rel.{n1,n2}; rm -f $T/hold; wait 2>/dev/null; rm -rf $T' EXIT

# -- guardExclusive through the project config ----------------------------------------------------------------------
cfg $T/multi.json 'cd {wt} && pytest' '"guardExclusive": {"glob": ["test_*.py", "check *.py", "*_t'"'"'q.py"], "marker": "#"}'
cfg $T/star.json 'cd {wt} && pytest' '"guardExclusive": {"glob": ["test_*.py"], "marker": "*"}'
mkdir -p $T/wts/xp/t
for f in 'test_a.py' 'check b.py' "x_t'q.py" 'helper.py'; do print -r -- '    # guards:exclusive — fixed port' > "$T/wts/xp/t/$f"; done
print -r -- ' guards:exclusive — no marker, a blank before it' > $T/wts/xp/t/test_nomark.py
print -r -- '#### guards:exclusive — the marker four times' > $T/wts/xp/t/test_hashes.py
print -r -- 'foo guards:exclusive — not the marker *' > $T/wts/xp/t/test_starno.py
print -r -- '* guards:exclusive — the marker *' > $T/wts/xp/t/test_star.py
excl() { ( cd $T/wts/xp && CODIS_AGENTS_CONFIG=$1 zsh -c 'source "$1" || exit 9; shift; slot_is_exclusive_guard "$@"' _ $H/slots.zsh pytest -q "$2" ) }
ok 'the first glob of the config: t/test_a.py with an indented "# guards:exclusive — r" is exclusive' 'excl $T/multi.json t/test_a.py'
ok 'the second glob, with a blank in it: "t/check b.py" is exclusive' 'excl $T/multi.json "t/check b.py"'
ok 'the third glob, with a quote in it: "t/x_t'"'"'q.py" is exclusive' 'excl $T/multi.json "t/x_t'"'"'q.py"'
ok 'a name matching none of the globs (helper.py) is not' '! excl $T/multi.json t/helper.py'
ok 'marker "#" is literal: a line " guards:exclusive — r" without it is not exclusive' '! excl $T/multi.json t/test_nomark.py'
ok 'marker "#" is literal: "#### guards:exclusive — r" is not the marker followed by a blank' '! excl $T/multi.json t/test_hashes.py'
ok 'marker "*" is literal: "foo guards:exclusive — r" is not, "* guards:exclusive — r" is' '! excl $T/star.json t/test_starno.py && excl $T/star.json t/test_star.py'
c=$(node $H/config.js check $T/multi.json 2>/dev/null); ok 'config.js check: several globs with a blank and a quote - ok' '[[ $c == ok* ]]' "$c"

# -- the guards-all.sh log --------------------------------------------------------------------------------------------
rm -f $T/hold $T/rc; : > $T/run.log
$H/guards-all.sh $T/o1/xp > $T/g1.out 2>&1; r1=$?
$H/guards-all.sh $T/o2/xp > $T/g2.out 2>&1; r2=$?
logs=( $T/shared/guards-xp-*.txt(N) )
ok 'two worktrees outside worktreeRoot with the same basename: both run (none reused from the other)' \
  '(( r1 == 0 && r2 == 0 )) && ! grep -q reused $T/g2.out && grep -q "^start o1/xp" $T/run.log && grep -q "^start o2/xp" $T/run.log' "$r1 $r2 $(cat $T/g2.out; cat $T/run.log)"
ok '... two logs guards-xp-<cksum>.txt, each with its own .meta.json' '(( ${#logs} == 2 )) && [[ -f $logs[1].meta.json && -f $logs[2].meta.json && $logs[1] != $logs[2] ]]' "$(ls $T/shared)"
$H/guards-all.sh $T/o2/xp > $T/g3.out 2>&1
ok '... the second one again: reused from its own log' 'grep -q reused $T/g3.out' "$(cat $T/g3.out)"
$H/guards-all.sh $T/wts/xp/ > $T/g4.out 2>&1
ok 'a worktree under worktreeRoot given with a trailing slash: guards-xp.txt' '[[ -f $T/shared/guards-xp.txt ]]' "$(ls $T/shared)"

# -- a runner without {jobs}: its exit code ---------------------------------------------------------------------------
: > $T/run.log; print 3 > $T/rc
$H/guards-all.sh --force xp > $T/r3.out 2>&1; rc=$?
ok 'without {jobs}: a red runner (exit 3) - guards-all exits 3, the runner ran once' '(( rc == 3 )) && (( $(grep -c "^start wts/xp" $T/run.log) == 1 ))' "$rc $(cat $T/r3.out; cat $T/run.log)"
: > $T/run.log; print 75 > $T/rc
$H/guards-all.sh --force xp > $T/r75.out 2>&1; rc=$?
ok 'without {jobs}: a runner that itself exits 75 is not taken for "no budget" - exit 75, ran once' '(( rc == 75 )) && (( $(grep -c "^start wts/xp" $T/run.log) == 1 ))' "$rc $(cat $T/r75.out; cat $T/run.log)"
rm -f $T/rc

# -- guardCommandLegacy without {jobs}, chosen by the probe -------------------------------------------------------------
cfg $T/leg.json 'cd {wt} && run --limit-file {limitFile}' '"guardCommandLegacy": "cd {wt} && pytest -q", "guardAdaptiveProbe": {"file": "runner.txt", "contains": "limit-file"}'
: > $T/run.log
CODIS_AGENTS_CONFIG=$T/leg.json $H/guards-all.sh --force xp > $T/leg.out 2>&1; rc=$?
ok 'legacy command without {jobs} (probe fails): counted as the whole budget, "fixed 6"' \
  '(( rc == 0 )) && grep -q "counted as the whole budget 6" $T/leg.out && grep -q "^start wts/xp fixed 6$" $T/run.log' "$rc $(cat $T/leg.out; cat $T/run.log)"

# -- FIFO: a single heavy job that comes later does not pass a waiting run without {jobs} ------------------------------
: > $T/run.log
# The window between the run's admission and its plan in the slot is short (sourcing slots.zsh there): a node that
# reads the config 1.5 s slower inside a slot (SLOT_PATH set) makes it wide enough for n2 every time.
mkdir -p $T/slow; real_node=${commands[node]}
print -r -- '#!/bin/zsh
[[ -n $SLOT_PATH && $1 == *config.js ]] && sleep 1.5
exec '${(q)real_node}' "$@"' > $T/slow/node; chmod +x $T/slow/node
path=( $T/slow $path )
hjob n1; waitlong '[[ -e $T/n1.start ]]'
$H/guards-all.sh --force xp > $T/f.out 2>&1 & GA=$!
waitlong 'grep -q "whole budget" $T/f.out || ! kill -0 $GA 2>/dev/null'
# n2 polls fast (as a real waiter may well do between two polls of the run): it must still not pass the run
SLOT_POLL=0.05 hjob n2; sleep 2
ok 'a later single heavy job waits behind the queued run without {jobs} (a slot is free, but FIFO)' '[[ ! -e $T/n2.start ]] && ! grep -q "^start" $T/run.log' "$(cat $T/n2.out; cat $T/f.out)"
touch $T/rel.n1
waitlong 'grep -q "^start" $T/run.log || [[ -e $T/n2.start ]]'
# n2 holds its slot until the run has either started or gone back to the queue (released at once, it would be gone
# before the run's plan looks at its neighbours)
waitlong 'grep -q "^start" $T/run.log || grep -q "waiting for workers outside the slot" $T/f.out || ! kill -0 $GA 2>/dev/null'
# n2 is released whatever happened: a run bumped back to the queue waits for it (no deadlock of the test)
touch $T/rel.n2; wait $GA; rc=$?; waitlong '[[ -e $T/n2.end ]]'
# The order is the order of admission, from the journal (acquire time, column 3): once the run holds its slot, n2 may
# take the next one at once (as next to a fixed run) and start before the runner's first line, which comes only after
# guards-result.js meta-start. Bumped back means a "whole" record with 75, and n2 acquired before the run's real start.
wacq=$(awk -F'\t' '$7 == "whole" && $9 != 75 { print $3 }' $T/journal.tsv | tail -1)
nacq=$(awk -F'\t' '$7 == "single" { print $3 }' $T/journal.tsv | tail -1)
first=none; [[ -n $wacq && -n $nacq ]] && { (( wacq < nacq )) && first=run || first=n2 }
ok '... the first heavy job ended: the queued run is admitted BEFORE the single one behind it (it is not bumped back to the queue by it)' \
  '[[ $first == run ]] && ! awk -F"\t" "\$7 == \"whole\" && \$9 == 75 { f = 1 } END { exit !f }" $T/journal.tsv && ! grep -q "waiting for workers outside the slot" $T/f.out' "first=$first wacq=$wacq nacq=$nacq; $(grep -v '^waiting for slot' $T/f.out | head -5; cut -f3,5-9 $T/journal.tsv | tail -4)"
ok '... and it ran with the whole budget "fixed 6", exit 0' '(( rc == 0 )) && grep -q "^start wts/xp fixed 6$" $T/run.log' "$rc $(cat $T/run.log)"

print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
