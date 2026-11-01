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
H=${0:A:h:h}/scripts
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-share-t.XXXXXX")
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK=$T/guards.lock SLOT_POLL=0.3 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
unset GUARDS_EXCLUSIVE_LOCK SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_PRIORITY SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_PROC GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
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
k=0
while (( k++ < 1 )) || [[ -e '$T'/hold.$tag ]]; do
  [[ -n $jf ]] && { l=$(<$jf); print -rn -- "$l " >> '$T'/npm.$tag.trace; print -r -- "$l" > $jf.active; print -r -- "$tag $l" >> '$T'/npm.ticks; }
  sleep 0.3
done
print -r -- "end $tag $EPOCHREALTIME" >> '$T'/npm.log; print -r -- "$tag 0" >> '$T'/npm.ticks
exit 0' > $T/bin/npm
chmod +x $T/bin/*; export PATH=$T/bin:$PATH
for d in tr se; do mkdir -p $T/wts/$d/srv; done

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
trap 'unhold tr se; rm -f $T/single.hold; for p in ${(k)STUBS}; do pkill -P $p 2>/dev/null; kill $p 2>/dev/null; done; wait 2>/dev/null; rm -rf $T' EXIT

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

print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
