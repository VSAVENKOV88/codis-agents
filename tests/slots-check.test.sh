#!/bin/zsh
# Slot rules (classes, the extra heavy slot, the shared ceiling, swap, legacy lock, exit codes, exclusive guards,
# signals, the worker budget of full guard runs) on a TEMPORARY slot directory and a fake machine - the real machine
# is not loaded (the commands are sleeps). Exit code 0 - everything holds.
#   usage: tests/slots-check.test.sh   (macOS: needs /usr/bin/lockf)
[[ -x /usr/bin/lockf ]] || { print -r -- "skip: /usr/bin/lockf not found (the slot scripts are macOS-only)"; exit 0; }
H=${0:A:h:h}/scripts
zmodload zsh/datetime
T=$(mktemp -d -t slots-check)
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK=$T/guards.lock SLOT_POLL=0.3 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
# Project config of the test: worktrees under $T/wts with a fake runner; the adaptive runner is recognised by a probe.
mkdir -p $T/wts $T/shared
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared",
  "guardCommand": "cd {wt}/srv && npm run guards -- --all --concurrency {jobs} --concurrency-file {limitFile}",
  "guardCommandLegacy": "cd {wt}/srv && npm run guards -- --all --concurrency {jobs}",
  "guardAdaptiveProbe": {"file": "srv/tools/guards.js", "contains": "--concurrency-file"}}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
# Fake machine: sysctl / memory_pressure / vm_stat / df in $T/bin read numbers from files $T/m.* - the real parsing of
# their output is checked too. m.swapouts grows by m.step pages on every vm_stat call.
mkdir -p $T/bin
setm() { print -r -- $2 > $T/m.$1 }
setm free 20; setm used 1000; setm swfree 20000; setm vmfree 0; setm swapouts 0; setm step 0
print -r -- '#!/bin/zsh
[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"
print -r -- "total = 30000,00M  used = $(<'$T'/m.used),00M  free = $(<'$T'/m.swfree),00M  (encrypted)"' > $T/bin/sysctl
print -r -- '#!/bin/zsh
print -r -- "System-wide memory free percentage: $(<'$T'/m.free)%"' > $T/bin/memory_pressure
print -r -- '#!/bin/zsh
n=$(( $(<'$T'/m.swapouts) + $(<'$T'/m.step) )); print -r -- $n > '$T'/m.swapouts
print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
print -r -- "Swapins:                                    5."
print -r -- "Swapouts:                                   $n."' > $T/bin/vm_stat
print -r -- '#!/bin/zsh
print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"
print -r -- "/dev/disk3s6 100000 0 $(<'$T'/m.vmfree) 0% /System/Volumes/VM"' > $T/bin/df
chmod +x $T/bin/*; export PATH=$T/bin:$PATH
pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
job() { # job <script> <name> <seconds> - writes start/end, output in $T/<name>.out
  "$H/$1" zsh -c 'touch '$T'/$1.start; sleep $2; touch '$T'/$1.end' _ $2 $3 > $T/$2.out 2>&1 &
  JOBPID=$!
}
running() { local s=( $T/*.start(N) ) e=( $T/*.end(N) ); print $(( ${#s} - ${#e} )) }
started() { [[ -e $T/$1.start ]] }
waitfor() { local i; for i in {1..100}; do eval "$1" && return 0; sleep 0.1; done; return 1 }

ok 'medium.sh, heavy.sh, guards-all.sh, slots.zsh exist' '[[ -x $H/medium.sh && -x $H/heavy.sh && -x $H/guards-all.sh && -f $H/slots.zsh ]]'
ok 'heavy/guards-all call slot_run heavy, medium - slot_run medium' \
  'grep -q "slot_run heavy" $H/heavy.sh && grep -q "slot_run heavy" $H/guards-all.sh && grep -q "slot_run medium" $H/medium.sh'
ok 'guards-all.sh <worktree> logs to <sharedDir>/guards-<name>.txt' 'grep -q "guards-\$NAME.txt" $H/guards-all.sh'
[[ -f $H/slots.zsh ]] || { print -r -- "  FAIL no slots - nothing else to check"; print -r -- "TOTAL: $pass ok, $((fail+1)) fail"; exit 1; }

# 1. two heavy run at once, a third at "free 20 %" waits and says so
job heavy.sh h1 6; job heavy.sh h2 6
waitfor 'started h1 && started h2'
ok '1. two heavy at once' '[[ $(running) -eq 2 ]]' "running: $(running)"
job heavy.sh h3 1
sleep 3.5
ok '1. the third heavy at 20 % free memory < 50 % did not start' '! started h3'
n=$(grep -c 'waiting for slot heavy' $T/h3.out)
ok '1. the third prints "waiting for slot heavy" (SLOT_SAY=1 -> >= 2 lines in 3.5 s)' '(( n >= 2 ))' "lines: $n; $(cat $T/h3.out)"
ok '1. the waiting line gives the reason (free %)' 'grep -q "free 20%" $T/h3.out' "$(tail -1 $T/h3.out)"
waitfor 'started h3' ; waitfor 'started h3' ; waitfor 'started h3'
ok '1. a slot freed - the third went' 'started h3'
wait; rm -f $T/*.start(N) $T/*.end(N)

# 2. the third heavy is admitted when memory is plentiful and swap is flat
setm free 70
job heavy.sh k1 8; job heavy.sh k2 8
waitfor 'started k1 && started k2'; sleep 1.2   # swap history >= the window (1 s)
job heavy.sh k3 6
waitfor 'started k3'
ok '2. the third heavy at 70 % and flat swap goes at once (3 at once)' '[[ $(running) -eq 3 ]]' "running: $(running); $(cat $T/k3.out)"
# 3. ceiling 4: 3 heavy + 1 medium, the second medium waits
job medium.sh m1 4
waitfor 'started m1'
job medium.sh m2 1
sleep 1.5
ok '3. medium + heavy <= 4: the fourth went, the fifth waits' 'started m1 && ! started m2 && grep -q "waiting for slot medium" $T/m2.out' "$(cat $T/m2.out)"
wait; rm -f $T/*.start(N) $T/*.end(N)

# 4. swap: no slot at all while swap capacity is below the threshold
setm swfree 1000
job medium.sh s1 1
sleep 1.5
ok '4. swap below the threshold - even the first medium waits' '! started s1 && grep -q "waiting for slot medium.*swap" $T/s1.out' "$(cat $T/s1.out)"
setm swfree 20000; kill $JOBPID 2>/dev/null; wait 2>/dev/null
rm -f $T/*.start(N) $T/*.end(N)

# 5. legacy: a held legacy lock is one heavy slot
setm free 20
/usr/bin/lockf -k $SLOT_LEGACY_LOCK sleep 5 & L=$!
sleep 0.3
job heavy.sh g1 4
waitfor 'started g1'
job heavy.sh g2 1
sleep 1.5
ok '5. legacy lock + one new = two heavy; the third (low memory) waits' 'started g1 && ! started g2' "$(cat $T/g2.out)"
wait; rm -f $T/*.start(N) $T/*.end(N)

# 6. the exit code passes through; an exclusive guard under heavy.sh takes the exclusive lock
$H/heavy.sh zsh -c 'exit 7' >/dev/null 2>&1; rc=$?
ok '6. heavy.sh returns the command exit code (7)' '[[ $rc -eq 7 ]]' "code $rc"
mkdir -p $T/g; print -r -- '// guards:exclusive — check
setTimeout(()=>process.exit(0), 10)' > $T/g/x-run.js
/usr/bin/lockf -k $SLOTS_DIR/exclusive.lock sleep 2 & sleep 0.2
s=$EPOCHREALTIME; $H/heavy.sh node $T/g/x-run.js > $T/x.out 2>&1; e=$EPOCHREALTIME
ok '6. heavy.sh over a guard marked exclusive waits for the exclusive lock' '(( e - s >= 1.5 ))' "waited $(( e - s )) s"
ok '6. waiting for the exclusive lock is out loud' 'grep -q "waiting for the exclusive lock" $T/x.out' "$(cat $T/x.out)"
wait
$H/heavy.sh zsh -c 'exit 75' >/dev/null 2>&1; rc=$?
print -r -- '// guards:exclusive — check
process.exit(75)' > $T/g/y-run.js
$H/heavy.sh node $T/g/y-run.js > $T/y.out 2>&1 & YP=$!
for i in {1..60}; do kill -0 $YP 2>/dev/null || break; sleep 0.1; done
if kill -0 $YP 2>/dev/null; then pkill -P $YP; kill $YP; rc2=hang; else wait $YP; rc2=$?; fi
ok '6. an exclusive guard exiting 75 - the code passes through, not "lock not given" (no endless loop)' '[[ $rc2 -eq 75 ]] && ! grep -q "waiting for the exclusive lock" $T/y.out' "code $rc2; $(cat $T/y.out)"

# 7. free memory for the extra slot is the minimum over the window, not one lucky reading
export SLOT_THIRD_WINDOW=3
setm free 20
job heavy.sh w1 14; job heavy.sh w2 14
waitfor 'started w1 && started w2'
job heavy.sh w3 1
sleep 4            # history (20 %) covers the whole window
setm free 70       # one "lucky" reading and steady 70 % after it
sleep 1.5
ok '7. the third is not admitted while the window (3 s) holds a dip to 20 %' '! started w3' "$(tail -2 $T/w3.out)"
waitfor 'started w3'; waitfor 'started w3'
ok '7. the dip left the window - the third went' 'started w3' "$(tail -2 $T/w3.out)"
kill $JOBPID 2>/dev/null; wait; rm -f $T/*.start(N) $T/*.end(N)

# 8. swap grows by the monotonic Swapouts counter while used stands or dips - the extra slot is refused
export SLOT_THIRD_WINDOW=2
setm free 70; setm step 20000                   # 20000 pages x 16 KB ~ 312 MB per vm_stat call
job heavy.sh v1 16; job heavy.sh v2 16
waitfor 'started v1 && started v2'
job heavy.sh v3 1
sleep 1; setm used 900; sleep 3                  # used even dipped
ok '8. Swapouts grows (used flat or dipping) - the third waits, reason "swap"' '! started v3 && grep -q "swap" $T/v3.out' "$(tail -2 $T/v3.out)"
setm step 0
waitfor 'started v3'; waitfor 'started v3'
ok '8. Swapouts stood still for a window - the third went' 'started v3' "$(tail -2 $T/v3.out)"
wait; rm -f $T/*.start(N) $T/*.end(N)

# 9. TERM to heavy.sh - the command and its children are not left as orphans outside the slot
$H/heavy.sh zsh -c 'print $$ > '$T'/t.sh; sleep 60 & print $! > '$T'/t.sleep; wait' > /dev/null 2>&1 &
HP=$!
waitfor '[[ -s $T/t.sleep ]]'
kill -TERM $HP; sleep 1.5
alive=(); for p in $(<$T/t.sh) $(<$T/t.sleep); do kill -0 $p 2>/dev/null && alive+=$p; done
ok '9. TERM to heavy.sh stops the command and its children' '(( ${#alive} == 0 ))' "alive: ${alive[*]} ($(ps -o pid=,ppid=,command= -p ${(j:,:)alive} 2>/dev/null))"
for p in $alive; do kill $p 2>/dev/null; done

# 10. workers of a full guard run: a budget of 6 for all full runs
setm free 70; export SLOT_THIRD_WINDOW=1
source $H/slots.zsh
B=slot_jobs_budget
# a stub holder: lockf and its sleep (inherits the lock) - stop both, or an orphan holds the slot
kt() { local p; for p; do pkill -P $p 2>/dev/null; kill $p 2>/dev/null; done }
ok '10. budget: no other heavy -> 6' '[[ $($B 0 0 0) == 6 ]]'
ok '10. budget: the neighbour is a single heavy job -> 3' '[[ $($B 1 0 0) == 3 ]]'
ok '10. budget: the neighbour is a fixed runner with 6 until the end -> 0 (wait), not 3' '[[ $($B 1 1 6) == 0 ]]'
ok '10. budget: the neighbour is a full run with 3 -> 3' '[[ $($B 1 1 3) == 3 ]]'
ok '10. budget: two full neighbours (3 + 1) -> at most 6/3 = 2 and the remaining 2' '[[ $($B 2 2 4) == 2 ]]'
H1=$SLOTS_DIR/heavy.1.lock H2=$SLOTS_DIR/heavy.2.lock
: > $H1; : > $H2
/usr/bin/lockf -k $H1 sleep 60 & MY=$!
/usr/bin/lockf -k $H2 sleep 60 & OT=$!; sleep 0.3
print 'fixed 6' > $H2.jobs
ok '10. neighbour "fixed 6" -> me 0, adaptive neighbours 0 (wait outside the slot); my share "fixed 0"' '[[ "$(slot_guard_plan $H1 fixed start)" == "0 0" && "$(<$H1.jobs)" == "fixed 0" ]]' "$(slot_guard_plan $H1 fixed start); $(<$H1.jobs)"
print adaptive > $H2.jobs; print 6 > $H2.limit; print 6 > $H2.limit.active
ok '10. neighbour adaptive, limit 6 and 6 running -> me 0, wait in the slot (1 neighbour)' '[[ "$(slot_guard_plan $H1 fixed start)" == "0 1" ]]' "$(slot_guard_plan $H1 fixed start)"
print 3 > $H2.limit
ok '10. neighbour dropped its limit to 3, 6 still running -> still 0 (running guards finish)' '[[ "$(slot_guard_plan $H1 fixed start)" == "0 1" ]]' "$(slot_guard_plan $H1 fixed start)"
print 3 > $H2.limit.active
ok '10. neighbour runs 3 -> me 3; "fixed 3" written' '[[ "$(slot_guard_plan $H1 fixed start)" == "3 1" && "$(<$H1.jobs)" == "fixed 3" ]]' "$(slot_guard_plan $H1 fixed start); $(<$H1.jobs)"
rm -f $H1.jobs; print 'fixed 0' > $H1.jobs
ok '10. adaptive neighbour re-evaluates: a newcomer "fixed 0" waits -> the neighbour takes 3 and writes the limit' '[[ "$(slot_guard_plan $H2 adaptive run)" == "3 0" && "$(<$H2.limit)" == 3 ]]' "$(slot_guard_plan $H2 adaptive run); limit $(<$H2.limit)"
print 'fixed 6' > $H1.jobs
ok '10. adaptive re-evaluation with a "fixed 6" neighbour -> limit 1, not 0 (the runner reads 0 as no limit)' '[[ "$(slot_guard_plan $H2 adaptive run)" == "1 0" && "$(<$H2.limit)" == 1 ]]' "$(slot_guard_plan $H2 adaptive run)"
rm -f $H1.jobs $H2.jobs $H2.limit $H2.limit.active
print -r -- "heavy 1 2026-10-08 zsh -c ... tail -25 \"\$OUT\" guards-all /x/slots.zsh /x/wt /x/out" > $H2.who
ok '10. neighbour is a full run without .jobs (guards-all in .who) -> ceiling 6 -> me 0' '[[ "$(slot_guard_plan $H1 fixed start)" == "0 0" ]]' "$(slot_guard_plan $H1 fixed start)"
print -r -- "heavy 1 2026-10-08 node services/x-run.js" > $H2.who
ok '10. neighbour is a single heavy.sh (no .jobs) -> me 3' '[[ "$(slot_guard_plan $H1 fixed start)" == "3 0" ]]' "$(slot_guard_plan $H1 fixed start)"
kt $OT; wait $OT 2>/dev/null; rm -f $H2.who $H1.jobs
ok '10. my own slot busy, no others -> 6' '[[ "$(slot_guard_plan $H1 adaptive start)" == "6 0" && "$(<$H1.limit)" == 6 ]]'
/usr/bin/lockf -k $SLOT_LEGACY_LOCK sleep 30 & OT=$!; sleep 0.3
ok '10. legacy lock held (count unknown -> 6) -> 0' '[[ "$(slot_guard_plan $H1 fixed start)" == "0 0" ]]'
kt $OT $MY; wait 2>/dev/null; rm -f $SLOTS_DIR/heavy.*.lock.*(N)
print 'fixed 6' > $H1.jobs; print 9 > $H1.limit; print 9 > $H1.limit.active
job heavy.sh sr 0.3; waitfor 'started sr'; wait
ok '10. slot_run deletes the numbers of the previous holder when it takes the slot' '[[ ! -e $H1.jobs && ! -e $H1.limit && ! -e $H1.limit.active ]]' "$(ls $SLOTS_DIR)"
rm -f $SLOTS_DIR/heavy.*.lock.*(N) $T/*.start(N) $T/*.end(N)

# guards-all.sh end to end. Fake npm: writes "start/end <tag> <args>" to npm.log; with --concurrency-file every 0.3 s
# it appends the limit to npm.<tag>.trace and (like the real runner) "running = limit" to <file>.active.
print -r -- '#!/bin/zsh
zmodload zsh/datetime; tag=${PWD:h:t}; jf=; a=("$@")
for i in {1..$#a}; do [[ $a[i] == --concurrency-file ]] && jf=$a[i+1]; done
print -r -- "start $tag $EPOCHREALTIME $*" >> '$T'/npm.log; print -r -- "$*" > '$T'/npm.args
for k in {1..$(<'$T'/npm.ticks.$tag)}; do
  [[ -n $jf ]] && { print -rn -- "$(<$jf) " >> '$T'/npm.$tag.trace; print -r -- "$(<$jf)" > $jf.active; }
  sleep 0.3
done
print -r -- "end $tag $EPOCHREALTIME" >> '$T'/npm.log' > $T/bin/npm; chmod +x $T/bin/npm
for d in xn xn2 xo xo2; do mkdir -p $T/wts/$d/srv/tools; done
for d in xn xn2; do print -r -- "else if (a === '--concurrency-file')" > $T/wts/$d/srv/tools/guards.js; done
for d in xo xo2; do print -r -- "// old runner" > $T/wts/$d/srv/tools/guards.js; done
ticks() { print $2 > $T/npm.ticks.$1 }
nlog() { : > $T/npm.log; rm -f $T/npm.*.trace(N) }
# overlaps of runs in npm.log: "a b" - b started while a was running
overlap() { awk '$1=="start"{if(run[$2]==0) for(k in run) if(run[k]) print k, $2; run[$2]=1} $1=="end"{run[$2]=0}' $T/npm.log }

allfree() { local f; for f in $SLOTS_DIR/heavy.{1,2,3}.lock $SLOT_LEGACY_LOCK; do _slot_busy $f && return 1; done; return 0 }
waitfor allfree; waitfor allfree
busy=$(for f in $SLOTS_DIR/heavy.{1,2,3}.lock $SLOT_LEGACY_LOCK; do _slot_busy $f && print -n "${f:t}: $(lsof -t $f 2>/dev/null | xargs ps -o pid=,command= -p 2>/dev/null | tr '\n' ';') "; done)
ok '10. before the end-to-end cases every heavy slot is free (stubs of earlier cases stopped)' '[[ -z $busy ]]' "$busy"
nlog; ticks xn 20
$H/guards-all.sh xn > $T/ga.out 2>&1 & GA=$!
waitfor '[[ -s $T/npm.xn.trace ]]'; sleep 0.6   # the neighbour comes after the run started
job heavy.sh nb 2          # a single neighbour in the middle of the run
sleep 3.5
wait $GA; wait 2>/dev/null
tr=( $(<$T/npm.xn.trace) )
ok '10. guards-all.sh: --concurrency 6 --concurrency-file <slot>.limit, "workers at start: 6"' 'grep -q -- "--all --concurrency 6 --concurrency-file .*heavy.[123].lock.limit" $T/npm.args && grep -q "workers at start: 6" $T/ga.out' "$(cat $T/npm.args; cat $T/ga.out)"
ok '10. a single neighbour came -> limit 3, left -> 6 again (re-evaluation mid-run)' '[[ "${(j: :)tr}" == 6*\ 3*\ 6* ]]' "trace: ${tr[*]}"
ok '10. after the run the slot numbers are removed' '[[ -z $(print $SLOTS_DIR/heavy.*.lock.(jobs|limit|limit.active)(N)) ]]' "$(ls $SLOTS_DIR)"
ok '10. the guard log is in <sharedDir>/guards-xn.txt' '[[ -f $T/shared/guards-xn.txt ]]' "$(ls $T/shared)"

/usr/bin/lockf -k $SLOTS_DIR/heavy.3.lock sleep 30 & OT=$!; sleep 0.3
nlog; ticks xo 1
$H/guards-all.sh xo > $T/go.out 2>&1
kt $OT; wait 2>/dev/null
ok '10. fixed runner with a single neighbour: --concurrency 3 for the whole run' 'grep -q -- "--all --concurrency 3$" $T/npm.args && grep -q "workers: 3 for the whole run" $T/go.out' "$(cat $T/npm.args; cat $T/go.out)"
nlog; $H/guards-all.sh xo > $T/go.out 2>&1
ok '10. fixed runner alone: --concurrency 6' 'grep -q -- "--all --concurrency 6$" $T/npm.args' "$(cat $T/npm.args)"
$H/guards-all.sh $T/wts/xo > $T/go.out 2>&1; rc=$?
ok '10. guards-all.sh also takes an absolute worktree path' '(( rc == 0 )) && grep -q "workers: 6" $T/go.out' "$(cat $T/go.out)"
$H/guards-all.sh nosuch > $T/gn.out 2>&1; rc=$?
ok '10. unknown worktree - a clear error, no slot taken' '(( rc == 66 )) && grep -q "no worktree" $T/gn.out' "$rc $(cat $T/gn.out)"

# 11. a fixed runner FIRST alone (6 until the end) + a second full run -> the second waits, not 6 + 3 = 9
export SLOT_SAY=1
for second in xo2 xn2; do
  nlog; ticks xo 8; ticks $second 1
  $H/guards-all.sh xo > $T/p1.out 2>&1 & P1=$!
  waitfor 'grep -q "start xo " $T/npm.log'
  $H/guards-all.sh $second > $T/p2.out 2>&1 & P2=$!
  wait $P1 $P2
  ok "11. fixed runner with 6 + a second ($second): the second starts only after the first ends" '[[ -z "$(overlap)" ]] && grep -q "end xo .*" $T/npm.log && grep -q "start $second " $T/npm.log' "overlaps: $(overlap); $(cat $T/npm.log)"
  ok "11. ... and says \"waiting for workers outside the slot\" all the while" 'grep -q "waiting for workers outside the slot" $T/p2.out' "$(cat $T/p2.out)"
done

# 12. adaptive first alone (6), a fixed runner second: the newcomer waits in the slot until the neighbour drops to 3
nlog; ticks xn 25; ticks xo 2
$H/guards-all.sh xn > $T/q1.out 2>&1 & Q1=$!
waitfor 'grep -q "start xn " $T/npm.log'; sleep 1
$H/guards-all.sh xo > $T/q2.out 2>&1 & Q2=$!
wait $Q1 $Q2
tr=( $(<$T/npm.xn.trace) )
ok '12. adaptive 6 + fixed newcomer: the newcomer takes 3 (not 6), the neighbour goes 6 -> 3 -> 6' 'grep -q "start xo .*--concurrency 3$" $T/npm.log && [[ "${(j: :)tr}" == 6*\ 3*\ 6* ]]' "trace xn: ${tr[*]}; $(grep start $T/npm.log)"
ok '12. the newcomer started no earlier than the neighbour limit was 3' '[[ "${(j: :)tr}" == 6*\ 3* ]] && grep -q "workers: 3 for the whole run" $T/q2.out' "$(cat $T/q2.out)"

# 13. two adaptive runs in parallel - 3 each (sum <= 6 over the whole overlap)
nlog; ticks xn 14; ticks xn2 14
$H/guards-all.sh xn > $T/r1.out 2>&1 & R1=$!
waitfor 'grep -q "start xn " $T/npm.log'
$H/guards-all.sh xn2 > $T/r2.out 2>&1 & R2=$!
wait $R1 $R2
t1=( $(<$T/npm.xn.trace) ) t2=( $(<$T/npm.xn2.trace) )
ok '13. two adaptive: the second starts with 3, the first drops to 3' '[[ $t2[1] == 3 && "${(j: :)t1}" == 6*\ 3* ]]' "xn: ${t1[*]} | xn2: ${t2[*]}"

# 14. slot counts come from the project config (environment unset): one medium slot -> the second medium waits
unset SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared", "slots": {"medium": 1}}' > $T/cfg1.json
CODIS_AGENTS_CONFIG=$T/cfg1.json job medium.sh c1 3
waitfor 'started c1'
CODIS_AGENTS_CONFIG=$T/cfg1.json job medium.sh c2 0.3
sleep 1.5
ok '14. slots.medium = 1 in the config: the second medium waits' 'started c1 && ! started c2 && grep -q "all 1 medium slots busy" $T/c2.out' "$(cat $T/c2.out)"
wait; rm -f $T/*.start(N) $T/*.end(N)
rm -rf $T
print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
