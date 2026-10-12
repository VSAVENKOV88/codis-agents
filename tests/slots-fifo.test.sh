#!/bin/zsh
# The waiting queue of the slots (FIFO) on a TEMPORARY slot directory and a fake machine - the real machine is not
# loaded (the commands are sleeps). Exit code 0 - everything holds.
#   usage: tests/slots-fifo.test.sh                       (scripts from ../scripts)
#          SLOTS_H=<dir with slots.zsh/heavy.sh/...> tests/slots-fifo.test.sh   (check other copies)
# Cases: 1. order - 4 waiters, two arrival orders, the early one polls less often than the late ones -> slots by
#           ticket; "position N in queue"; 2. a dead waiter (kill -9) and a ticket with a reused pid do not hold the
#           queue; 3. a full run first in the queue without a worker budget - late single heavy jobs do not slip past;
#        4. the last slot of the shared ceiling goes to the earlier ticket of the other queue; 5. medium has its own
#           queue; 6. SLOT_RETRY_RC - a retry with the same ticket.
[[ -x /usr/bin/lockf ]] || { print -r -- "skip: /usr/bin/lockf not found (the slot scripts are macOS-only)"; exit 0; }
H=${SLOTS_H:-${0:A:h:h}/scripts}
zmodload zsh/datetime
T=$(mktemp -d -t slots-fifo)
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK=$T/guards.lock SLOT_POLL=0.3 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
mkdir -p $T/wts/xo/srv/tools $T/shared
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared",
  "guardCommand": "cd {wt}/srv && npm run guards -- --all --concurrency {jobs} --concurrency-file {limitFile}",
  "guardCommandLegacy": "cd {wt}/srv && npm run guards -- --all --concurrency {jobs}",
  "guardAdaptiveProbe": {"file": "srv/tools/guards.js", "contains": "--concurrency-file"}}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
print -r -- "// old runner" > $T/wts/xo/srv/tools/guards.js
# Fake machine (as in slots-check.test.sh): free 20 % -> no extra heavy slot; plenty of swap.
mkdir -p $T/bin
setm() { print -r -- $2 > $T/m.$1 }
setm free 20; setm used 1000; setm swfree 20000; setm vmfree 0; setm swapouts 0; setm step 0
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
# Fake npm for guards-all.sh: "start/end <worktree> <time>" in npm.log, holds for npm.ticks.<worktree> x 0.3 s.
print -r -- '#!/bin/zsh
zmodload zsh/datetime; tag=${PWD:h:t}
print -r -- "start $tag $EPOCHREALTIME $*" >> '$T'/npm.log
for k in {1..$(<'$T'/npm.ticks.$tag)}; do sleep 0.3; done
print -r -- "end $tag $EPOCHREALTIME" >> '$T'/npm.log' > $T/bin/npm
chmod +x $T/bin/*; export PATH=$T/bin:$PATH

pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
waitfor() { local i; for i in {1..${2:-100}}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
typeset -A PID
# hold <script> <name> - holds a slot until $T/rel.<name> exists
hold() { "$H/$1" zsh -c 'touch '$T'/$1.start; while [[ ! -e '$T'/rel.$1 && ! -e '$T'/rel.ALL ]]; do sleep 0.1; done' _ $2 > $T/$2.out 2>&1 & PID[$2]=${!} }
started() { [[ -e $T/$1.start ]] }
# Waiting without hanging: a mutant may never admit a waiter - then its process tree is stopped after 10 s.
_tree() { local c; for c in $(pgrep -P $1 2>/dev/null); do _tree $c; done; print -r -- $1 }
bwait() { local n i p; for n; do p=$PID[$n]; [[ -n $p ]] || continue
  for i in {1..100}; do kill -0 $p 2>/dev/null || break; sleep 0.1; done
  kill -0 $p 2>/dev/null && for i in $(_tree $p); do kill $i 2>/dev/null; done; wait $p 2>/dev/null; done }
# End of a case: release every holder, wait (<= 10 s each) or stop them all.
endcase() { touch $T/rel.ALL; bwait ${(k)PID}; PID=(); rm -f $T/rel.* $T/*.start(N) }
trap 'touch $T/rel.ALL 2>/dev/null; for k in ${(k)PID}; do for i in $(_tree $PID[$k]); do kill $i 2>/dev/null; done; done; rm -rf $T' EXIT
# w <script> <name> <poll pause> [seconds] - a waiter: once it has a slot, writes its name to $T/order and holds it
w() { SLOT_POLL=$3 "$H/$1" zsh -c 'zmodload zsh/datetime; print -r -- "$1 $EPOCHREALTIME" >> '$T'/order; sleep $2' _ $2 ${4:-0.3} > $T/$2.out 2>&1 & PID[$2]=${!} }
order() { [[ -s $T/order ]] && print -r -- ${(j: :)${(f)"$(awk '{print $1}' $T/order)"}} }
got() { grep -q "^$1 " $T/order 2>/dev/null }
n_order() { [[ -s $T/order ]] && wc -l < $T/order | tr -d ' ' || print 0 }

[[ -f $H/slots.zsh ]] || { print -r -- "  FAIL no $H/slots.zsh"; exit 1; }

# 1. order by ticket: both heavy slots busy, no extra slot (20 %); four arrive one after another
hold heavy.sh h1; hold heavy.sh h2
waitfor 'started h1 && started h2'
for sc in 'A:3 B:1.5 C:0.5 D:0.2' 'D2:0.2 C2:0.5 B2:1.5 A2:3'; do
  : > $T/order; names=()
  for p in ${=sc}; do w heavy.sh ${p%%:*} ${p#*:}; names+=${p%%:*}; sleep 0.8; done
  sleep 1.5
  ok "1. [$sc] while the slots are busy nobody went" '[[ $(n_order) == 0 ]]' "$(order)"
  if [[ $names[1] == A ]]; then
    ok '1. a waiter tells its place: "waiting for slot heavy, position 2 in queue" (B)' 'grep -q "waiting for slot heavy, position 2 in queue" $T/B.out' "$(tail -2 $T/B.out)"
    ok '1. ... "position 4 in queue" (D)' 'grep -q "waiting for slot heavy, position 4 in queue" $T/D.out' "$(tail -2 $T/D.out)"
  fi
  touch $T/rel.h1
  waitfor '[[ $(n_order) == 4 ]]' 300
  ok "1. [$sc] slots go in the order of arrival: ${names[*]}" '[[ "$(order)" == "${names[*]}" ]]' "got: $(order)"
  bwait $names h1; rm -f $T/rel.h1 $T/h1.start; hold heavy.sh h1; waitfor 'started h1'
done

# 1b. the number is given on arrival even while admit.lock is busy (choosing a slot holds it up to a second): the test
#     holds admit.lock while four arrive - with the number taken "under admit.lock" they would grab it in random order
: > $T/order; names=()
zmodload zsh/system; zsystem flock -t 10 -f afd $SLOTS_DIR/admit.lock
for p in E:0.2 F1:0.2 G:0.2 I:0.2; do w heavy.sh ${p%%:*} ${p#*:}; names+=${p%%:*}; sleep 0.5; done
sleep 0.5; zsystem flock -u $afd
sleep 1; touch $T/rel.h1
waitfor '[[ $(n_order) == 4 ]]' 200
ok "1b. admit.lock busy on arrival - still in the order of arrival: ${names[*]}" '[[ "$(order)" == "${names[*]}" ]]' "got: $(order)"
bwait $names h1; rm -f $T/rel.h1 $T/h1.start; hold heavy.sh h1; waitfor 'started h1'

# 2. a dead waiter does not hold the queue: X (kill -9 while waiting) and a ticket with a live but foreign (reused) pid
: > $T/order
w heavy.sh X 0.3; sleep 0.8; w heavy.sh Y 1; sleep 0.8
kill -9 $PID[X] 2>/dev/null; bwait X
mkdir -p $SLOTS_DIR/queue
print -r -- "heavy $$ YesterdayNotThisProcess single" > $SLOTS_DIR/queue/0000000000
touch $T/rel.h1
waitfor 'got Y' 80
ok '2. dead X and a ticket with a reused pid do not hold the queue - Y went' 'got Y && ! got X' "got: $(order); $(tail -2 $T/Y.out)"
bwait Y
ok '2. tickets of the dead are cleaned' '[[ -z "$(print $SLOTS_DIR/queue/*(N))" ]]' "$(ls $SLOTS_DIR/queue 2>&1)"
endcase

# 3. a full run first in the queue, no budget (the neighbour is a fixed runner "fixed 6"): late single jobs wait behind it
: > $T/order; : > $T/npm.log; print 3 > $T/npm.ticks.xo
hold heavy.sh N1; waitfor 'started N1'
waitfor 'grep -qs " N1\$" $SLOTS_DIR/heavy.*.lock.who'   # .who is written after the command starts
nslot=$(grep -ls ' N1$' $SLOTS_DIR/heavy.*.lock.who | head -1); nslot=${nslot%.who}
ok '3. (setup) the slot of neighbour N1 found' '[[ -n $nslot ]]'
sdump() { local x; for x in $SLOTS_DIR/heavy.*(N) $SLOTS_DIR/queue/*(N); do print -rn -- "${x:t}=$(head -c 60 $x 2>/dev/null | tr '\n' ' ')| "; done }
S3=$(sdump)
# under admit.lock: slot_run deletes .jobs of the previous holder after writing .who, under it too (else a race)
zmodload zsh/system; zsystem flock -t 10 -f afd $SLOTS_DIR/admit.lock; print 'fixed 6' > $nslot.jobs; zsystem flock -u $afd
SLOT_POLL=1 $H/guards-all.sh xo > $T/F.out 2>&1 & PID[F]=${!}
sleep 1.5
w heavy.sh S1 0.2; sleep 0.5; w heavy.sh S2 0.2
sleep 3
ok '3. while the neighbour holds the whole budget, single heavy jobs do not slip past the full run' '! got S1 && ! got S2' "got: $(order); slots before F: $S3"
ok '3. the full run waits first: "position 1 in queue", a single job - "position 2"' 'grep -q "waiting for slot heavy, position 1 in queue" $T/F.out && grep -q "waiting for slot heavy, position 2 in queue" $T/S1.out' "F: $(tail -1 $T/F.out) | S1: $(tail -1 $T/S1.out)"
ok '3. ... and the reason of the full run is the worker budget ("outside the slot")' 'grep -q "outside the slot" $T/F.out' "$(tail -1 $T/F.out)"
rm -f $nslot.jobs; touch $T/rel.N1
waitfor 'grep -q "^start xo" $T/npm.log && got S1 && got S2' 200
ok '3. the neighbour left - the full run went, the single jobs after it' 'grep -q "^start xo" $T/npm.log && got S1 && got S2' "npm: $(cat $T/npm.log); got: $(order)"
endcase

# 4. shared ceiling (SLOT_TOTAL_MAX=2): the last slot of the ceiling goes to the earlier ticket (heavy), not to the
#    late medium, although the medium polls more often
export SLOT_TOTAL_MAX=2
: > $T/order
hold heavy.sh P1; waitfor 'started P1'; hold medium.sh M1; waitfor 'started M1'
w heavy.sh HW 1.5 6; sleep 0.8; w medium.sh MW 0.2; sleep 1.5
touch $T/rel.M1
sleep 3
ok '4. the last slot of the ceiling - to the early heavy HW, the late medium MW waits' 'got HW && ! got MW' "got: $(order)"
touch $T/rel.P1
waitfor 'got MW' 100
ok '4. ... then the medium too' 'got MW' "got: $(order)"
endcase; unset SLOT_TOTAL_MAX

# 5. medium has its own queue: the heavy queue stands, a medium goes at once
: > $T/order
hold heavy.sh q1; hold heavy.sh q2; waitfor 'started q1 && started q2'
w heavy.sh HQ 0.3; sleep 0.8
w medium.sh MQ 0.3
waitfor 'got MQ' 30
ok '5. the heavy queue stands - a medium goes at once' 'got MQ && ! got HQ' "got: $(order)"
touch $T/rel.q1; waitfor 'got HQ' 50
ok '5. the heavy went when a heavy slot was freed' 'got HQ' "got: $(order)"
endcase

# 6. SLOT_RETRY_RC (guards-all.sh: 75 - the budget was taken after admission): back to the queue with the SAME ticket
: > $T/order
hold heavy.sh r1; hold heavy.sh r2; waitfor 'started r1 && started r2'
SLOT_RETRY_RC=75 SLOT_POLL=1 $H/heavy.sh zsh -c 'zmodload zsh/datetime; [[ -e '$T'/R.once ]] || { touch '$T'/R.once; exit 75 }; print -r -- "R $EPOCHREALTIME" >> '$T'/order' > $T/R.out 2>&1 & PID[R]=${!}
sleep 0.8; w heavy.sh Z 0.2; sleep 1.5
touch $T/rel.r1
waitfor 'got R && got Z' 100
ok '6. the command exited 75 with SLOT_RETRY_RC=75 -> back in the queue with its ticket, the late Z does not overtake' '[[ -e $T/R.once && "$(order)" == "R Z" ]]' "got: $(order); $(tail -2 $T/R.out)"
bwait R; rc=$?
endcase

print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
