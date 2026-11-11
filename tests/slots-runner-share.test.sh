#!/bin/zsh
# tests:quiet - slot queues and worker limits polled every 0.3 s with timed waits; red under the load of other test files
# The train goes first in the worker budget too (p-runner-share): a full run with the train's priority (guards-all.sh
# --priority: the full run of a train and its attribution, scripts/train.js; on the remote runner too) does not share
# its workers with runs without it - they yield. Measured on the runner (2026-11-01): a train alone 14-16 min, with the
# selections of neighbouring tasks 20-26 min, because an adaptive train shed to its share (jobsShared) whenever a
# selection came. On a TEMPORARY slot directory and a fake machine; the commands are sleeps.
# Cases:
#   U1-U9  slot_guard_plan with stub neighbours (budget 6, share 3):
#     U1 a train runs 6 - a selection gets 0 and waits outside the slot (the train does not shed: 0 adaptive
#        neighbours that would); U2 a train in its slot that has not started yet (no limit) - a running selection's
#        re-evaluation gives 1 (the floor of a running adaptive run: 0 means no limit), so it drains to 1;
#     U3 a selection runs 6 - a train gets 0 and waits IN the slot (1 neighbour that sheds), its share written
#        "adaptive priority" for the neighbours; U4 the selection drained to 1 - the train gets 5 (what the selection
#        still runs is subtracted: nothing running is stopped), not the share 3; U4b a selection that has just planned
#        (limit N, its runner has not written its running guards yet) counts as its limit - max(limit, running) -
#        else train and selection would start 2 x the budget together; U4c a selection waiting in its slot (no limit)
#        holds nothing - the train 6; U5 a fixed selection with 6 until its
#        end - the train 0, outside the slot; U6 a fixed selection with 2 - the train 4;
#     U7 a train with a fixed 2 - a selection takes the rest, 4; U8 two trains - they share as before (3 each);
#     U9 no priority anywhere - exactly as before (adaptive 6/6 -> "0 1"; 3/3 -> "3 1").
#   E1 guards-all.sh --priority runs with 6, a selection (guards-all.sh without --priority) comes: the train's limit
#      never drops below 6 while the selection waits outside the slot; the selection starts after the train ends.
#   E2 a selection runs with 6, the train comes: the selection drops to 1, the train starts with 5 and goes to 6 when
#      the selection ends; the sum never exceeds 6.
#   E3 two runs without priority - as before: 3 each.
#   E4 two runs with the priority - as before: 3 each (the admission of the second knows its priority).
H=${0:A:h:h}/scripts
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-share.XXXXXX")
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK=$T/guards.lock SLOT_POLL=0.3 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
# Run inside an outer slot the outer slots.zsh has exported its own lock, journal and counts: dropped here.
unset GUARDS_EXCLUSIVE_LOCK SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_PRIORITY SLOT_KILL_GRACE SLOT_EMPTY_WAIT SLOT_EXEC_NOTE CODIS_SLOT_HELD SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_PROC GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
export SLOT_OS=darwin
# no machine file of the box this runs on (tests/run.js does the same for every test): its slots, jobsAlone, remote
mkdir -p $T/xdg; export XDG_CONFIG_HOME=$T/xdg; unset CODIS_AGENTS_MACHINE
mkdir -p $T/wts $T/shared
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared",
  "guardCommand": "cd {wt}/srv && npm run guards -- --all --concurrency {jobs} --concurrency-file {limitFile}"}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
# Fake machine: free 70 % (a third heavy slot is allowed), plenty of swap.
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
# Fake npm (as in slots-check.test.sh): every 0.3 s appends its limit to npm.<tag>.trace and writes "running = limit" to
# <file>.active, like the real adaptive runner; runs npm.ticks.<tag> ticks and then on while $T/hold.<tag> exists.
print -r -- '#!/bin/zsh
zmodload zsh/datetime; tag=${PWD:h:t}; jf=; a=("$@")
for i in {1..$#a}; do [[ $a[i] == --concurrency-file ]] && jf=$a[i+1]; done
print -r -- "start $tag $EPOCHREALTIME $*" >> '$T'/npm.log
k=0
while (( k++ < $(<'$T'/npm.ticks.$tag) )) || [[ -e '$T'/hold.$tag ]]; do
  [[ -n $jf ]] && { l=$(<$jf); print -rn -- "$l " >> '$T'/npm.$tag.trace; print -r -- "$l" > $jf.active; print -r -- "$tag $l" >> '$T'/npm.ticks; }
  sleep 0.3
done
print -r -- "end $tag $EPOCHREALTIME" >> '$T'/npm.log; print -r -- "$tag 0" >> '$T'/npm.ticks
exit 0' > $T/bin/npm
chmod +x $T/bin/*; export PATH=$T/bin:$PATH
for d in tr se se2; do mkdir -p $T/wts/$d/srv; done

pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
waitlong() { local i; for i in {1..900}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
ticks() { print $2 > $T/npm.ticks.$1 }
hold() { touch $T/hold.$1 }
unhold() { local n; for n; do rm -f $T/hold.$n; done }
nlog() { : > $T/npm.log; : > $T/npm.ticks; rm -f $T/npm.*.trace(N) $T/hold.*(N) }
trace() { [[ -f $T/npm.$1.trace ]] && print -r -- "$(<$T/npm.$1.trace)" }
last() { local t=( $(trace $1) ); print -r -- ${t[-1]} }
started() { grep -q "^start $1 " $T/npm.log 2>/dev/null }

[[ -f $H/slots.zsh ]] || { print -r -- "  FAIL no $H/slots.zsh"; exit 1; }
trap 'unhold tr se se2; for p in ${(k)STUBS}; do pkill -P $p 2>/dev/null; kill $p 2>/dev/null; done; wait 2>/dev/null; rm -rf $T' EXIT

# ---- U: slot_guard_plan with stub neighbours ----
source $H/slots.zsh
typeset -A STUBS
stub() { rm -f $1.held; : >> $1; zsh -c 'zmodload zsh/system; zsystem flock -f _l "$1" || exit 9; touch "$1.held"; sleep 60' _ $1 & STUBS[$!]=1 }
H1=$SLOTS_DIR/heavy.1.lock H2=$SLOTS_DIR/heavy.2.lock H3=$SLOTS_DIR/heavy.3.lock
: > $H1; : > $H2; : > $H3; : > $SLOTS_DIR/admit.lock   # slot_guard_plan takes it (slot_run creates it otherwise)
stub $H1; stub $H2; waitlong '[[ -e $H1.held && -e $H2.held ]]'
nb() { rm -f $H2.jobs $H2.limit $H2.limit.active; print -r -- $1 > $H2.jobs; [[ -n $2 ]] && print -r -- $2 > $H2.limit; [[ -n $3 ]] && print -r -- $3 > $H2.limit.active; true }
plan() { slot_guard_plan $H1 "$@" }

nb 'adaptive priority' 6 6
ok 'U1 a train runs 6 - a selection gets 0 and waits outside the slot ("0 0": the train does not shed)' '[[ "$(plan adaptive start)" == "0 0" ]]' "$(plan adaptive start)"
nb 'adaptive priority'
ok 'U2 a train waits in its slot (no limit yet) - a running selection re-evaluates to 1 (the floor), limit 1' '[[ "$(plan adaptive run)" == "1 0" && "$(<$H1.limit)" == 1 ]]' "$(plan adaptive run); limit $(<$H1.limit 2>/dev/null)"
nb adaptive 6 6
ok 'U3 a selection runs 6 - the train gets 0 and waits in the slot (1 neighbour sheds)' '[[ "$(plan adaptive start priority)" == "0 1" ]]' "$(plan adaptive start priority)"
ok 'U3 ... the train'"'"'s share is written "adaptive priority" for the neighbours' '[[ "$(<$H1.jobs)" == "adaptive priority" ]]' "$(<$H1.jobs)"
nb adaptive 1 1
ok 'U4 the selection drained to 1 - the train gets 5, not its share 3' '[[ "$(plan adaptive start priority)" == "5 1" && "$(<$H1.limit)" == 5 ]]' "$(plan adaptive start priority)"
nb adaptive 1 4
ok 'U4 ... 4 still running (limit 1) - the train gets 2: running guards are not stopped' '[[ "$(plan adaptive start priority)" == "2 1" ]]' "$(plan adaptive start priority)"
nb adaptive 6
ok 'U4b the selection has just planned 6 and its runner has not written its running guards yet - the train gets 0, not 6 (max(limit, running): it would start 6 next to the 6 the selection is about to start)' '[[ "$(plan adaptive start priority)" == "0 1" ]]' "$(plan adaptive start priority)"
nb adaptive 2
ok 'U4b ... limit 2 and nothing running yet - the train gets 4' '[[ "$(plan adaptive start priority)" == "4 1" ]]' "$(plan adaptive start priority)"
nb adaptive
ok 'U4c a selection waiting in its slot (no limit, nothing running) - the train gets 6: it holds no workers' '[[ "$(plan adaptive start priority)" == "6 1" ]]' "$(plan adaptive start priority)"
nb 'fixed 6'
ok 'U5 a fixed selection with 6 until its end - the train 0, outside the slot; "fixed 0 priority"' '[[ "$(plan fixed start priority)" == "0 0" && "$(<$H1.jobs)" == "fixed 0 priority" ]]' "$(plan fixed start priority); $(<$H1.jobs)"
nb 'fixed 2'
ok 'U6 a fixed selection with 2 - the train 4' '[[ "$(plan fixed start priority)" == "4 0" ]]' "$(plan fixed start priority)"
nb 'fixed 2 priority'
ok 'U7 a train with a fixed 2 - a selection takes the rest, 4' '[[ "$(plan fixed start)" == "4 0" ]]' "$(plan fixed start)"
nb 'adaptive priority' 6 6
ok 'U8 two trains share as before: 0, wait in the slot (the other train sheds)' '[[ "$(plan adaptive start priority)" == "0 1" ]]' "$(plan adaptive start priority)"
nb 'adaptive priority' 3 3
ok 'U8 ... the other train at 3 - 3' '[[ "$(plan adaptive start priority)" == "3 1" ]]' "$(plan adaptive start priority)"
nb adaptive 6 6
ok 'U9 no priority anywhere - as before: "0 1"' '[[ "$(plan fixed start)" == "0 1" ]]' "$(plan fixed start)"
nb adaptive 3 3
ok 'U9 ... "3 1", "fixed 3" without a priority mark' '[[ "$(plan fixed start)" == "3 1" && "$(<$H1.jobs)" == "fixed 3" ]]' "$(plan fixed start); $(<$H1.jobs)"
rm -f $H2.jobs $H2.limit $H2.limit.active
print -r -- "heavy 1 2026-11-01 node services/x-run.js" > $H2.who
ok 'U9 a single heavy job next to a train - the train shares as before (3): it is not a full run' '[[ "$(plan adaptive start priority)" == "3 0" ]]' "$(plan adaptive start priority)"
rm -f $H2.who
for p in ${(k)STUBS}; do pkill -P $p 2>/dev/null; kill $p 2>/dev/null; done; wait 2>/dev/null; STUBS=()
rm -f $SLOTS_DIR/heavy.*.lock.*(N)
allfree() { local f; for f in $SLOTS_DIR/heavy.{1,2,3}.lock; do _slot_busy $f && return 1; done; return 0 }
waitlong allfree

# ---- E1: the train runs, a selection comes ----
nlog; ticks tr 1; ticks se 1; hold tr
$H/guards-all.sh --priority tr > $T/e1t.out 2>&1 & E1T=$!
waitlong '[[ $(last tr) == 6 ]]'
$H/guards-all.sh se > $T/e1s.out 2>&1 & E1S=$!
waitlong 'grep -q "waiting for workers outside the slot" $T/e1s.out'
sleep 1.5
ok 'E1 the selection waits outside the slot and does not start while the train runs' 'grep -q "waiting for workers outside the slot" $T/e1s.out && ! started se' "$(cat $T/e1s.out)"
ok 'E1 the train keeps 6 the whole time' '[[ " $(trace tr) " != *" "[1-5]" "* ]]' "trace tr: $(trace tr)"
ok 'E1 the train says it runs with the priority' 'grep -q "^workers at start: 6 .*--priority" $T/e1t.out' "$(cat $T/e1t.out)"
unhold tr; wait $E1T $E1S
ok 'E1 the selection started after the train ended, with 6' 'started se && [[ $(awk '"'"'$1=="end"&&$2=="tr"{print NR}'"'"' $T/npm.log) -lt $(awk '"'"'$1=="start"&&$2=="se"{print NR}'"'"' $T/npm.log) ]] && [[ ${$(trace se)[1]} == 6 ]]' "$(cat $T/npm.log); se: $(trace se)"
waitlong allfree

# ---- E2: a selection runs, the train comes ----
nlog; ticks tr 1; ticks se 1; hold se
$H/guards-all.sh se > $T/e2s.out 2>&1 & E2S=$!
waitlong '[[ $(last se) == 6 ]]'
hold tr
$H/guards-all.sh --priority tr > $T/e2t.out 2>&1 & E2T=$!
waitlong 'started tr && [[ $(last se) == 1 ]] && [[ $(last tr) == 5 ]]'
ok 'E2 the selection dropped to 1, the train runs 5 (not its share 3)' '[[ $(last se) == 1 && $(last tr) == 5 ]]' "se: $(trace se) | tr: $(trace tr)"
unhold se
waitlong '[[ $(last tr) == 6 ]]'
ok 'E2 the selection ended - the train goes to 6' '[[ $(last tr) == 6 ]]' "tr: $(trace tr)"
unhold tr; wait $E2S $E2T
# the sum of the last limits of both at every tick never exceeds 6 (limits the runners read; running = limit here)
over=$(awk '{v[$1]=$2; s=0; for (k in v) s+=v[k]; if (s>6) print}' $T/npm.ticks | head -3)
ok 'E2 the two never ran more than 6 together' '[[ -z $over ]]' "$over"
waitlong allfree

# ---- E3: two runs without priority - as before ----
nlog; ticks se 1; ticks se2 1; hold se; hold se2
$H/guards-all.sh se > $T/e3a.out 2>&1 & E3A=$!
waitlong '[[ $(last se) == 6 ]]'
$H/guards-all.sh se2 > $T/e3b.out 2>&1 & E3B=$!
waitlong '[[ -n $(last se2) && $(last se) == 3 ]]'
unhold se se2; wait $E3A $E3B
t1=( $(trace se) ) t2=( $(trace se2) )
ok 'E3 two runs without priority: the second starts with 3, the first drops to 3' '[[ $t2[1] == 3 && "${(j: :)t1}" == 6*\ 3* ]]' "se: ${t1[*]} | se2: ${t2[*]}"
ok 'E3 no priority mark in their workers lines' '! grep -q -- "--priority" $T/e3a.out $T/e3b.out' "$(cat $T/e3a.out $T/e3b.out)"
waitlong allfree

# ---- E4: two runs with the priority (two trains; a train and its attribution) - they share as before: the second is
#      admitted into the slot (slot_run passes the priority to the admission) and the first sheds to 3 ----
nlog; ticks tr 1; ticks se2 1; hold tr; hold se2
$H/guards-all.sh --priority tr > $T/e4a.out 2>&1 & E4A=$!
waitlong '[[ $(last tr) == 6 ]]'
$H/guards-all.sh --priority se2 > $T/e4b.out 2>&1 & E4B=$!
waitlong '[[ -n $(last se2) && $(last tr) == 3 ]]'
unhold tr se2; wait $E4A $E4B
t1=( $(trace tr) ) t2=( $(trace se2) )
ok 'E4 two runs with the priority: the second starts with 3 while the first runs, the first drops to 3' '[[ $t2[1] == 3 && "${(j: :)t1}" == 6*\ 3* ]]' "tr: ${t1[*]} | se2: ${t2[*]}"

print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
