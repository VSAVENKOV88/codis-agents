#!/bin/zsh
# tests:quiet - slot queues and worker limits polled every 0.3 s with timed waits; red under the load of other test files
# Tester of p-runner-share: the train goes first in the worker budget (slots.zsh, slot_guard_plan "Priority"). The
# contract (slots.zsh): a run without the priority yields to the train - "a running one re-evaluates down to 1" - and the
# train counts it only by what it still runs. Cells the programmer's slots-runner-share.test.sh does not hold:
#   T1 a train that already runs with a limit below the whole budget (it started next to a selection that still ran some
#      guards): the selection's re-evaluation must still drop to 1, not stay at "budget minus the train's limit" (else the
#      two lock into an equilibrium and the train never gets the budget back while the selection runs);
#   T2 a train with the whole budget as its limit, its running guards still ramping up: the selection drops to 1;
#   T3 a train with a fixed share below the budget (fixed runner): a selection takes only the rest (the fixed train
#      never grows, so the rest is the selection's - no yield needed);
#   E1 end to end with guards-all.sh: a selection runs at its share 3 next to a single heavy job (heavy.sh), the train
#      comes and starts with 3; the single job ends - the selection must drain to 1 and the train grow to 5 (budget 6);
#      not stay 3/3 as without the priority (the measured defect: a train held at its share while a selection runs).
# Round 2 (the fix: a run without the priority subtracts an adaptive train as the whole budget):
#   T4 a fixed selection (runner without {limitFile}) comes while an adaptive train runs at 3 of 6: it waits outside the
#      slot ("0 0"), not takes 3 for its whole run (a fixed run never gives back - the train could not grow);
#   T5 two adaptive trains at 3 each and a running selection: the selection re-evaluates to 1 (the floor), no negative
#      or empty limit from subtracting the budget twice;
#   E2 end to end: a train runs, a selection already runs at 1 next to it, a second selection comes: the second never
#      starts while the train runs, the train goes 5 -> 6 when the first selection ends, the sum never exceeds 6; the
#      second starts after the train ends.
# Round 3 (review R1: the train counts a selection as max(limit, running)):
#   T6 a selection whose limit file holds garbage (not a number), nothing running - the train counts it as the whole
#      budget ("0 1"), as the old path does, not as 0;
#   E3 end to end: a selection has planned 6 and its runner is still looking for its guards (no worker started, no
#      .limit.active); the train that comes then does not start 6 next to it: it waits in the slot, the selection
#      re-evaluates to 1 before its runner starts, the train starts with 5 ("workers at start: 5"), the sum never
#      exceeds 6, and the train takes 6 after the selection ends (no deadlock between the two waits).
H=${0:A:h:h}/scripts
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-share-t.XXXXXX")
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK=$T/guards.lock SLOT_POLL=0.3 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
unset GUARDS_EXCLUSIVE_LOCK SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_PRIORITY SLOT_KILL_GRACE SLOT_EMPTY_WAIT SLOT_EXEC_NOTE GUARDS_EXCLUSIVE_HELD CODIS_SLOT_HELD SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_PROC GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
export SLOT_OS=darwin
mkdir -p $T/xdg; export XDG_CONFIG_HOME=$T/xdg; unset CODIS_AGENTS_MACHINE
mkdir -p $T/wts $T/shared
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared",
  "guardCommand": "cd {wt}/srv && npm run guards -- --all --concurrency {jobs} --concurrency-file {limitFile}"}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
mkdir -p $T/bin
setm() { print -r -- $2 > $T/m.$1 }
setm free 70; setm used 1000; setm swfree 20000
print -r -- '#!/bin/zsh
[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"
print -r -- "total = 30000,00M  used = $(<'$T'/m.used),00M  free = $(<'$T'/m.swfree),00M  (encrypted)"' > $T/bin/sysctl
print -r -- '#!/bin/zsh
print -r -- "System-wide memory free percentage: $(<'$T'/m.free)%"' > $T/bin/memory_pressure
print -r -- '#!/bin/zsh
print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
print -r -- "Swapouts:                                   0."' > $T/bin/vm_stat
print -r -- '#!/bin/zsh
print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"
print -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"' > $T/bin/df
# Fake adaptive npm runner (as in slots-runner-share.test.sh): running = limit, every 0.3 s; holds while $T/hold.<tag>.
print -r -- '#!/bin/zsh
zmodload zsh/datetime; tag=${PWD:h:t}; jf=; a=("$@")
for i in {1..$#a}; do [[ $a[i] == --concurrency-file ]] && jf=$a[i+1]; done
print -r -- "start $tag $EPOCHREALTIME $*" >> '$T'/npm.log
while [[ -e '$T'/disc.$tag ]]; do sleep 0.1; done
k=0
while (( k++ < 1 )) || [[ -e '$T'/hold.$tag ]]; do
  [[ -n $jf ]] && { l=$(<$jf); print -rn -- "$l " >> '$T'/npm.$tag.trace; print -r -- "$l" > $jf.active; print -r -- "$tag $l" >> '$T'/npm.ticks; }
  sleep 0.3
done
print -r -- "end $tag $EPOCHREALTIME" >> '$T'/npm.log; print -r -- "$tag 0" >> '$T'/npm.ticks
exit 0' > $T/bin/npm
chmod +x $T/bin/*; export PATH=$T/bin:$PATH
for d in tr se s2; do mkdir -p $T/wts/$d/srv; done

pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
waitlong() { local i; for i in {1..${2:-900}}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
hold() { touch $T/hold.$1 }
unhold() { local n; for n; do rm -f $T/hold.$n; done }
trace() { [[ -f $T/npm.$1.trace ]] && print -r -- "$(<$T/npm.$1.trace)" }
last() { local t=( $(trace $1) ); print -r -- ${t[-1]} }
started() { grep -q "^start $1 " $T/npm.log 2>/dev/null }

[[ -f $H/slots.zsh ]] || { print -r -- "  FAIL no $H/slots.zsh"; exit 1; }
typeset -A STUBS
trap 'unhold tr se s2; rm -f $T/single.hold $T/disc.se; for p in ${(k)STUBS}; do pkill -P $p 2>/dev/null; kill $p 2>/dev/null; done; wait 2>/dev/null; rm -rf $T' EXIT

# ---- T: slot_guard_plan with a stub neighbour (budget 6, share 3) ----
source $H/slots.zsh
stub() { rm -f $1.held; : >> $1; zsh -c 'zmodload zsh/system; zsystem flock -f _l "$1" || exit 9; touch "$1.held"; sleep 60' _ $1 & STUBS[$!]=1 }
H1=$SLOTS_DIR/heavy.1.lock H2=$SLOTS_DIR/heavy.2.lock
: > $H1; : > $H2; : > $SLOTS_DIR/admit.lock
stub $H1; stub $H2; waitlong '[[ -e $H1.held && -e $H2.held ]]'
nb() { rm -f $H2.jobs $H2.limit $H2.limit.active; print -r -- $1 > $H2.jobs; [[ -n $2 ]] && print -r -- $2 > $H2.limit; [[ -n $3 ]] && print -r -- $3 > $H2.limit.active; true }
plan() { slot_guard_plan $H1 "$@" }

nb 'adaptive priority' 4 4
r=$(plan adaptive run)
ok 'T1 a train runs with limit 4 of 6 (it started next to the selection) - the running selection re-evaluates to 1, not 2' '[[ "$r" == "1 0" && "$(<$H1.limit)" == 1 ]]' "plan: $r; limit $(<$H1.limit 2>/dev/null)"
r=$(plan adaptive start)
ok 'T1 ... and a selection that comes then waits outside the slot ("0 0"), not takes 2' '[[ "$r" == "0 0" ]]' "plan: $r"
nb 'adaptive priority' 6 2
r=$(plan adaptive run)
ok 'T2 a train with limit 6, 2 running so far - the running selection re-evaluates to 1' '[[ "$r" == "1 0" ]]' "plan: $r"
nb 'fixed 4 priority'
r=$(plan adaptive start)
ok 'T3 a fixed train with 4 (it never grows) - a selection takes the rest, 2' '[[ "$r" == "2 0" ]]' "plan: $r"
nb 'adaptive priority' 3 3
r=$(plan fixed start)
ok 'T4 an adaptive train at 3 of 6 - a fixed selection waits outside the slot ("0 0", "fixed 0"), not takes 3' '[[ "$r" == "0 0" && "$(<$H1.jobs)" == "fixed 0" ]]' "plan: $r; jobs $(<$H1.jobs 2>/dev/null)"
H3=$SLOTS_DIR/heavy.3.lock; : > $H3; stub $H3; waitlong '[[ -e $H3.held ]]'
print -r -- 'adaptive priority' > $H3.jobs; print -r -- 3 > $H3.limit; print -r -- 3 > $H3.limit.active
r=$(plan adaptive run)
ok 'T5 two adaptive trains at 3 each - a running selection re-evaluates to 1, limit 1' '[[ "$r" == "1 0" && "$(<$H1.limit)" == 1 ]]' "plan: $r; limit $(<$H1.limit 2>/dev/null)"
rm -f $H3.jobs $H3.limit $H3.limit.active
nb adaptive garbage
r=$(plan adaptive start priority)
ok 'T6 a selection with a garbage limit and nothing running - the train counts it as the whole budget ("0 1"), not 0' '[[ "$r" == "0 1" ]]' "plan: $r"
rm -f $H2.jobs $H2.limit $H2.limit.active
for p in ${(k)STUBS}; do pkill -P $p 2>/dev/null; kill $p 2>/dev/null; done; wait 2>/dev/null; STUBS=()
rm -f $SLOTS_DIR/heavy.*.lock.*(N)
allfree() { local f; for f in $SLOTS_DIR/heavy.{1,2,3}.lock; do _slot_busy $f && return 1; done; return 0 }
waitlong allfree

# ---- E1: a selection at its share next to a single heavy job; the train comes; the single job ends ----
: > $T/npm.log; : > $T/npm.ticks; rm -f $T/npm.*.trace(N)
hold se
$H/guards-all.sh se > $T/e1s.out 2>&1 & E1S=$!
waitlong '[[ $(last se) == 6 ]]'
touch $T/single.hold
$H/heavy.sh zsh -c "while [[ -e $T/single.hold ]]; do sleep 0.2; done" > $T/e1h.out 2>&1 & E1H=$!
waitlong '[[ $(last se) == 3 ]]'
hold tr
$H/guards-all.sh --priority tr > $T/e1t.out 2>&1 & E1T=$!
waitlong 'started tr && [[ -n $(last tr) ]]'
ok 'E1 the train started next to the selection and the single job' 'started tr' "$(cat $T/e1t.out)"
rm -f $T/single.hold; wait $E1H
# the single job is gone: the train should take the budget back as the selection yields (drains to 1)
waitlong '[[ $(last se) == 1 && $(last tr) == 5 ]]' 100
ok 'E1 the single job ended - the selection drains to 1 and the train grows to 5 (not 3/3)' '[[ $(last se) == 1 && $(last tr) == 5 ]]' "se: $(trace se) | tr: $(trace tr)"
unhold se tr; wait $E1S $E1T
# the sum of the last limits of both at every tick never exceeds 6 (the single job is not a full run: it holds no workers)
over=$(awk '{v[$1]=$2; s=0; for (k in v) s+=v[k]; if (s>6) print NR": "$0" sum "s}' $T/npm.ticks | head -3)
ok 'E1 the selection and the train never ran more than 6 together' '[[ -z $over ]]' "$over"


# ---- E2: a train runs, a selection runs at 1 next to it, a second selection comes ----
waitlong allfree
: > $T/npm.log; : > $T/npm.ticks; rm -f $T/npm.*.trace(N)
hold se
$H/guards-all.sh se > $T/e2s.out 2>&1 & E2S=$!
waitlong '[[ $(last se) == 6 ]]'
hold tr
$H/guards-all.sh --priority tr > $T/e2t.out 2>&1 & E2T=$!
waitlong '[[ $(last se) == 1 && $(last tr) == 5 ]]' 150
ok 'E2 setup: the first selection drained to 1, the train at 5' '[[ $(last se) == 1 && $(last tr) == 5 ]]' "se: $(trace se) | tr: $(trace tr)"
hold s2
$H/guards-all.sh s2 > $T/e2b.out 2>&1 & E2B=$!
sleep 3
ok 'E2 the second selection does not start while the train runs (first selection at 1)' '! started s2' "$(cat $T/e2b.out) | s2: $(trace s2)"
unhold se; wait $E2S
waitlong '[[ $(last tr) == 6 ]]' 100
ok 'E2 the first selection ended - the train grows to 6' '[[ $(last tr) == 6 ]]' "tr: $(trace tr)"
sleep 2
ok 'E2 ... and the second selection still does not start while the train runs' '! started s2' "$(cat $T/e2b.out) | s2: $(trace s2)"
unhold tr; wait $E2T
waitlong 'started s2' 300
ok 'E2 the second selection starts after the train ends' 'started s2' "$(cat $T/e2b.out)"
unhold s2; wait $E2B
over=$(awk '{v[$1]=$2; s=0; for (k in v) s+=v[k]; if (s>6) print NR": "$0" sum "s}' $T/npm.ticks | head -3)
ok 'E2 the three runs never ran more than 6 together' '[[ -z $over ]]' "$over"


# ---- E3: a selection has planned 6, its runner still looks for its guards (no .limit.active); the train comes ----
waitlong allfree
: > $T/npm.log; : > $T/npm.ticks; rm -f $T/npm.*.trace(N)
hold se; touch $T/disc.se
$H/guards-all.sh se > $T/e3s.out 2>&1 & E3S=$!
waitlong 'started se'
lf=( $SLOTS_DIR/heavy.*.lock.limit(N) )
ok 'E3 setup: the selection planned 6 and wrote no running guards yet' '[[ $#lf == 1 && "$(<$lf[1])" == 6 && ! -e $lf[1].active ]]' "limits: $lf; $(cat $T/e3s.out)"
hold tr
$H/guards-all.sh --priority tr > $T/e3t.out 2>&1 & E3T=$!
waitlong 'started tr' 150
ok 'E3 the train starts (no deadlock with the selection that has not started its workers)' 'started tr' "$(cat $T/e3t.out)"
ok 'E3 the train starts with 5, not 6 next to the 6 the selection planned' 'grep -q "workers at start: 5 " $T/e3t.out && ! grep -q "workers at start: 6 " $T/e3t.out' "$(cat $T/e3t.out)"
rm -f $T/disc.se
waitlong '[[ $(last se) == 1 && $(last tr) == 5 ]]' 100
ok 'E3 the selection runner starts with 1 (its limit dropped before it started), the train runs 5' '[[ $(last se) == 1 && $(last tr) == 5 ]]' "se: $(trace se) | tr: $(trace tr)"
ok 'E3 the train never ran 6 while the selection ran' '[[ " $(trace tr) " != *" 6 "* ]]' "tr: $(trace tr)"
unhold se; wait $E3S
waitlong '[[ $(last tr) == 6 ]]' 100
ok 'E3 the selection ended - the train grows to 6' '[[ $(last tr) == 6 ]]' "tr: $(trace tr)"
unhold tr; wait $E3T
over=$(awk '{v[$1]=$2; s=0; for (k in v) s+=v[k]; if (s>6) print NR": "$0" sum "s}' $T/npm.ticks | head -3)
ok 'E3 the selection and the train never ran more than 6 together' '[[ -z $over ]]' "$over"

print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
