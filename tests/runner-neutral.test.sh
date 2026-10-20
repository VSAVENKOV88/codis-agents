#!/bin/zsh
# A runner not tied to one stack (U2b-2): guardCommand without {jobs} (the runner sets its own workers, counted as the
# whole budget jobsAlone), guardExclusive {glob, marker} (a Python guard marked "# guards:exclusive — <reason>" runs
# under the exclusive lock), and the guards-all.sh log named without a basename collision. On a TEMPORARY slot
# directory and a fake project; the commands are sleeps and a fake pytest. Exit code 0 - everything holds.
#   usage: tests/runner-neutral.test.sh   (zsh; the exclusive cases need lockf(1) or flock(1), as slots.zsh does)
H=${0:A:h:h}/scripts
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/runner-neutral.XXXXXX")
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK=$T/guards.lock SLOT_POLL=0.3 SLOT_SAY=1 SLOT_JOURNAL=$T/journal.tsv
# An outer slot (heavy.sh node tests/run.js) exports its own lock, counts and markers, and the thresholds may be set
# outside (SLOT_SWAP_MIN_MB=0 on Linux): the test must not see them - the fake machine below decides.
unset GUARDS_EXCLUSIVE_LOCK SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_THIRD_WINDOW SLOT_HIST_GAP GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
mkdir -p $T/wts $T/shared $T/bin $T/other
# Fake machine (as in slots-check.test.sh): plenty of free memory and swap, nothing grows.
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
cfg $T/py.json 'cd {wt} && pytest -q -rf' '"guardExclusive": {"glob": ["test_*.py"], "marker": "#"}'
cfg $T/jobs.json 'cd {wt} && pytest -q -n {jobs}'
cfg $T/lim.json 'cd {wt} && pytest -q --limit-file {limitFile}'
export CODIS_AGENTS_CONFIG=$T/py.json
# Fake pytest: "start <tag> <jobs of its slot> | <args>" in run.log; runs on while $T/hold.<tag> exists; "1 passed".
print -r -- '#!/bin/zsh
tag=${PWD:t}; [[ $PWD == '$T'/other/* ]] && tag=other-$tag
print -r -- "start $tag $(<$SLOT_PATH.jobs 2>/dev/null) | $*" >> '$T'/run.log
while [[ -e '$T'/hold.$tag ]]; do sleep 0.1; done
print -r -- "end $tag" >> '$T'/run.log
print -r -- "1 passed in 0.01s"' > $T/bin/pytest
chmod +x $T/bin/*; export PATH=$T/bin:$PATH
for d in wts/xp wts/xq other/xp; do mkdir -p $T/$d; git -C $T/$d init -q; git -C $T/$d -c user.email=t@t -c user.name=t commit -q --allow-empty -m x; done
pass=0 fail=0 skipped=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
skip() { (( skipped++ )); print -r -- "  skip $1 - skipped: $2" }
waitlong() { local i; for i in {1..900}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
hold() { touch $T/hold.$1 }
unhold() { local n; for n; do rm -f $T/hold.$n; done }
hjob() { "$H/heavy.sh" zsh -c 'touch '$T'/$1.start; while [[ ! -e '$T'/rel.$1 ]]; do sleep 0.1; done; touch '$T'/$1.end' _ $1 > $T/$1.out 2>&1 & }
started() { [[ -e $T/$1.start ]] }
chk() { c=$(node $H/config.js check $1 2>$T/chk.err); crc=$? }   # stdout "ok <file>"; notes go to stderr
trap 'touch $T/rel.{n1,n2}; rm -f $T/hold.*(N); wait 2>/dev/null; rm -rf $T' EXIT

# -- A. guardCommand without {jobs} --------------------------------------------------------------------------------
chk $T/py.json; ok 'A1. config.js check: guardCommand without {jobs} - ok' '(( crc == 0 )) && [[ $c == ok* ]]' "$crc $c $(<$T/chk.err)"
: > $T/run.log
$H/guards-all.sh xp > $T/a4.out 2>&1; rc=$?
ok 'A4. alone: guards-all.sh runs the runner and exits with its code 0' '(( rc == 0 )) && grep -q "^start xp " $T/run.log' "$rc $(cat $T/a4.out)"
ok 'A4. ... "workers: set by the runner itself (guardCommand has no {jobs}), counted as the whole budget 6"' \
  'grep -qF "workers: set by the runner itself (guardCommand has no {jobs}), counted as the whole budget 6" $T/a4.out' "$(cat $T/a4.out)"
ok 'A4. ... its slot says "fixed 6" to the neighbours while it runs' 'grep -q "^start xp fixed 6 | -q -rf$" $T/run.log' "$(cat $T/run.log)"

# A5. a single heavy neighbour: the run without {jobs} does not start until the whole budget is free
: > $T/run.log; hjob n1; waitlong 'started n1'
$H/guards-all.sh --force xp > $T/a5.out 2>&1 & GA=$!
waitlong 'grep -q "whole budget" $T/a5.out || ! kill -0 $GA 2>/dev/null'
ok 'A5. a heavy neighbour holds a slot: the run waits and says why ("whole budget")' '! grep -q "^start xp" $T/run.log && grep -q "waiting.*whole budget of 6" $T/a5.out' "$(cat $T/a5.out; cat $T/run.log)"
touch $T/rel.n1; waitlong '[[ -e $T/n1.end ]]'; wait $GA; rc=$?
ok 'A5. ... the neighbour ended: the run started after it and exits 0' '(( rc == 0 )) && grep -q "^start xp fixed 6 " $T/run.log' "$rc $(cat $T/a5.out)"

# A6. the run without {jobs} is going: a new full run with {jobs} waits for workers outside the slot
: > $T/run.log; hold xp
$H/guards-all.sh --force xp > $T/a6a.out 2>&1 & GA=$!
waitlong 'grep -q "^start xp" $T/run.log || ! kill -0 $GA 2>/dev/null'
CODIS_AGENTS_CONFIG=$T/jobs.json $H/guards-all.sh --force xq > $T/a6b.out 2>&1 & GB=$!
waitlong 'grep -q "waiting for workers outside the slot" $T/a6b.out || ! kill -0 $GB 2>/dev/null'
ok 'A6. a newcomer with {jobs} next to it gets no workers and waits outside the slot' '! grep -q "^start xq" $T/run.log && grep -q "waiting for workers outside the slot" $T/a6b.out' "$(cat $T/a6b.out; cat $T/run.log)"
unhold xp; wait $GA $GB
ok 'A6. ... and starts with -n 6 only after it ended' 'awk '"'"'/^end xp/{e=NR} /^start xq/{s=NR} END{exit !(e && s > e)}'"'"' $T/run.log && grep -q "^start xq fixed 6 | -q -n 6$" $T/run.log' "$(cat $T/run.log)"

# A7. {limitFile} without {jobs}: the adaptive runner as before
chk $T/lim.json; ok 'A7. config.js check: {limitFile} without {jobs} - ok' '(( crc == 0 )) && [[ $c == ok* ]]' "$crc $c $(<$T/chk.err)"
: > $T/run.log
CODIS_AGENTS_CONFIG=$T/lim.json $H/guards-all.sh --force xp > $T/a7.out 2>&1; rc=$?
ok 'A7. ... guards-all.sh: adaptive, "workers at start: 6", the limit file passed' '(( rc == 0 )) && grep -q "workers at start: 6" $T/a7.out && grep -q "^start xp adaptive | -q --limit-file .*heavy.[123].lock.limit$" $T/run.log' "$rc $(cat $T/a7.out; cat $T/run.log)"
# A8. with {jobs}: the count is substituted as before
: > $T/run.log
CODIS_AGENTS_CONFIG=$T/jobs.json $H/guards-all.sh --force xp > $T/a8.out 2>&1; rc=$?
ok 'A8. {jobs}: "-n 6" substituted, "workers: 6 for the whole run"' '(( rc == 0 )) && grep -q "workers: 6 for the whole run" $T/a8.out && grep -q "^start xp fixed 6 | -q -n 6$" $T/run.log' "$rc $(cat $T/a8.out; cat $T/run.log)"

# -- G. the log name ----------------------------------------------------------------------------------------------
rm -f $T/shared/guards-*(N)
$H/guards-all.sh xp > /dev/null 2>&1
ok 'G1. a name under worktreeRoot -> <sharedDir>/guards-<name>.txt' '[[ -f $T/shared/guards-xp.txt && -f $T/shared/guards-xp.txt.meta.json ]]' "$(ls $T/shared)"
$H/guards-all.sh $T/wts/xp > $T/g1.out 2>&1
ok 'G1. ... the absolute path of the same worktree -> the same log (reused)' 'grep -q "reused" $T/g1.out && [[ $(ls $T/shared | grep -c "^guards-.*\.txt$") == 1 ]]' "$(cat $T/g1.out; ls $T/shared)"
: > $T/run.log
$H/guards-all.sh $T/other/xp > $T/g2.out 2>&1; rc=$?
ok 'G2. a path outside worktreeRoot with the same basename is not reused from the other log' '(( rc == 0 )) && ! grep -q "reused" $T/g2.out && grep -q "^start other-xp" $T/run.log' "$rc $(cat $T/g2.out)"
logs=( $T/shared/guards-*.txt(N) )
ok 'G2. ... it has its own log and .meta.json; guards-xp.txt is untouched' '(( ${#logs} == 2 )) && [[ -f ${logs[(r)*guards-xp?*.txt]}.meta.json ]] && ! grep -q other $T/shared/guards-xp.txt.meta.json' "$(ls $T/shared)"
ok 'G2. ... the log name still starts with guards-<basename>' '[[ -n ${logs[(r)*/guards-xp-*.txt]} ]]' "$(ls $T/shared)"

# -- D. guardExclusive {glob, marker} -----------------------------------------------------------------------------
mkdir -p $T/wts/xp/tests
print -r -- '# guards:exclusive — fixed port 8099' > $T/wts/xp/tests/test_port.py
print -r -- 'def test_x(): pass' > $T/wts/xp/tests/test_plain.py
print -r -- '#guards:exclusive —' > $T/wts/xp/tests/test_noreason.py
print -r -- '// guards:exclusive — fixed port' > $T/wts/xp/tests/x-run.js
print -r -- '  [x]  guards:exclusive — literal marker' > $T/wts/xp/tests/test_lit.py
print -r -- 'x guards:exclusive — not the marker' > $T/wts/xp/tests/test_notlit.py
cfg $T/lit.json 'cd {wt} && pytest' '"guardExclusive": {"glob": ["test_*.py"], "marker": "[x]"}'
cfg $T/def.json 'cd {wt} && pytest'
excl() { # excl <config> <file> -> 0 when slot_is_exclusive_guard says exclusive
  ( cd $T/wts/xp && CODIS_AGENTS_CONFIG=$1 zsh -c 'source "$1" || exit 9; shift; slot_is_exclusive_guard "$@"' _ $H/slots.zsh pytest -q $2 ) }
ok 'D1. no key: x-run.js with "// guards:exclusive — r" is exclusive (the default)' 'excl $T/def.json tests/x-run.js'
ok 'D1. ... no key: a test_*.py with "#" is not' '! excl $T/def.json tests/test_port.py'
ok 'D2. {glob: [test_*.py], marker: #}: test_port.py with "# guards:exclusive — fixed port" is exclusive' 'excl $T/py.json tests/test_port.py'
ok 'D3. ... a test_*.py without the marker is not' '! excl $T/py.json tests/test_plain.py'
ok 'D4. ... x-run.js with "//" is not (the key replaces the default)' '! excl $T/py.json tests/x-run.js'
ok 'D5. ... the marker without a reason after "—" is not' '! excl $T/py.json tests/test_noreason.py'
ok 'D2. a marker with pattern characters ([x]) is matched literally' 'excl $T/lit.json tests/test_lit.py && ! excl $T/lit.json tests/test_notlit.py'
chk $T/py.json; ok 'D2. config.js check: guardExclusive {glob, marker} - ok' '(( crc == 0 )) && [[ $c == ok* ]]' "$crc $c $(<$T/chk.err)"
tool=; for t in /usr/bin/lockf /usr/bin/flock /bin/flock; do [[ -x $t ]] && { tool=$t; break }; done
if [[ -z $tool ]]; then
  skip 'D2. heavy.sh pytest tests/test_port.py runs under the exclusive lock' 'no lockf(1) or flock(1)'
  skip 'D2. ... waits out loud while the lock is held' 'no lockf(1) or flock(1)'
else
  : > $T/journal.tsv
  ( cd $T/wts/xp && $H/heavy.sh pytest -q tests/test_port.py > $T/d2.out 2>&1 ); rc=$?
  ( cd $T/wts/xp && $H/heavy.sh pytest -q tests/test_plain.py > $T/d3.out 2>&1 )
  ok 'D2. heavy.sh pytest tests/test_port.py runs under the exclusive lock (journal class exclusive), exit 0' \
    '(( rc == 0 )) && (( $(grep -c $'"'"'\texclusive\t'"'"' $T/journal.tsv) == 1 )) && grep -q $'"'"'\texclusive\t.*test_port.py'"'"' $T/journal.tsv' "$rc $(cat $T/journal.tsv)"
  if [[ ${tool:t} == lockf ]]; then $tool -k $SLOTS_DIR/exclusive.lock zsh -c 'touch '$T'/x.held; while [[ ! -e '$T'/rel.x ]]; do sleep 0.05; done' &
  else $tool -o $SLOTS_DIR/exclusive.lock zsh -c 'touch '$T'/x.held; while [[ ! -e '$T'/rel.x ]]; do sleep 0.05; done' & fi
  XH=$!; waitlong '[[ -e $T/x.held ]]'
  ( cd $T/wts/xp && $H/heavy.sh pytest -q tests/test_port.py > $T/d2b.out 2>&1 ) & HP=$!
  waitlong 'grep -q "waiting for the exclusive lock" $T/d2b.out || ! kill -0 $HP 2>/dev/null'
  ok 'D2. ... waits out loud while another holder has the exclusive lock' 'grep -q "waiting for the exclusive lock" $T/d2b.out && kill -0 $HP 2>/dev/null' "$(cat $T/d2b.out)"
  touch $T/rel.x; wait $XH $HP
fi

if (( skipped )); then print -r -- "TOTAL: $pass ok, $fail fail, $skipped skipped: no lockf(1) or flock(1)"; else print -r -- "TOTAL: $pass ok, $fail fail"; fi
(( fail == 0 ))
