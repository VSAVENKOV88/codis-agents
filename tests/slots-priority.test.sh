#!/bin/zsh
# The train's priority in the waiting queue of the slots (p-runq-b1) on a TEMPORARY slot directory and a fake machine -
# the real machine is not loaded (the commands are sleeps). Exit code 0 - everything holds.
#   usage: tests/slots-priority.test.sh                       (scripts from ../scripts)
#          SLOTS_H=<dir with slots.zsh/heavy.sh/...> tests/slots-priority.test.sh   (check other copies)
# A ticket taken with SLOT_PRIORITY=1 (guards-all.sh --priority, the full run of a train and its attribution) is ahead
# of every ticket without it in its class; tickets of the same priority keep the order of their numbers.
# Cases (cells of p-runq/analyst.md): 1. B1 B2 B3 B7 B14 - a single heavy job and a plain waiter came first, two
#   priority waiters later: the priority ones go first, in the order of their numbers, then the others; the message of
#   a waiter counts the priority tickets ahead and names the first; 2. B4 - a dead priority waiter does not hold the
#   queue; 3. B5 - a retry (SLOT_RETRY_RC) keeps the priority; 4. B8 - the last slot of the shared ceiling still goes
#   by number to an earlier medium; 5. guards-all.sh --priority goes ahead of an earlier single heavy job; B11 - a
#   worktree named train-* without the flag gets no priority; 6. the priority is not inherited by the command; a value
#   other than 0 or 1 is refused (64).
H=${SLOTS_H:-${0:A:h:h}/scripts}
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-prio.XXXXXX")
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK=$T/guards.lock SLOT_POLL=0.3 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
# Run inside an outer slot (heavy.sh node tests/run.js) the outer slots.zsh has exported its own lock, journal and
# counts: without this the test would wait on (and write to) the real ones.
unset GUARDS_EXCLUSIVE_LOCK SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_PRIORITY SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_PROC GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
export SLOT_OS=darwin
mkdir -p $T/wts/xo/srv/tools $T/wts/train-x/srv/tools $T/shared
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared",
  "guardCommand": "cd {wt}/srv && npm run guards -- --all --concurrency {jobs} --concurrency-file {limitFile}"}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
# Fake machine (as in slots-fifo.test.sh): free 20 % -> no extra heavy slot; plenty of swap.
mkdir -p $T/bin
setm() { print -r -- $2 > $T/m.$1 }
setm free 20; setm used 1000; setm swfree 20000
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
# Fake npm for guards-all.sh: writes "<worktree> <time>" to the order file, holds 0.3 s.
print -r -- '#!/bin/zsh
zmodload zsh/datetime
print -r -- "${PWD:h:t} $EPOCHREALTIME" >> '$T'/order
sleep 0.3' > $T/bin/npm
chmod +x $T/bin/*; export PATH=$T/bin:$PATH

pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
waitfor() { local i; for i in {1..${2:-100}}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
typeset -A PID
hold() { "$H/$1" zsh -c 'touch '$T'/$1.start; while [[ ! -e '$T'/rel.$1 && ! -e '$T'/rel.ALL ]]; do sleep 0.1; done' _ $2 > $T/$2.out 2>&1 & PID[$2]=${!} }
started() { [[ -e $T/$1.start ]] }
_tree() { local c; for c in $(pgrep -P $1 2>/dev/null); do _tree $c; done; print -r -- $1 }
bwait() { local n i p; for n; do p=$PID[$n]; [[ -n $p ]] || continue
  for i in {1..100}; do kill -0 $p 2>/dev/null || break; sleep 0.1; done
  kill -0 $p 2>/dev/null && for i in $(_tree $p); do kill $i 2>/dev/null; done; wait $p 2>/dev/null; done }
endcase() { touch $T/rel.ALL; bwait ${(k)PID}; PID=(); rm -f $T/rel.* $T/*.start(N) }
trap 'touch $T/rel.ALL 2>/dev/null; for k in ${(k)PID}; do for i in $(_tree $PID[$k]); do kill $i 2>/dev/null; done; done; rm -rf $T' EXIT
# w <script> <name> <poll pause> [seconds] - a waiter: once it has a slot, writes its name to $T/order and holds it
w() { SLOT_POLL=$3 "$H/$1" zsh -c 'zmodload zsh/datetime; print -r -- "$1 $EPOCHREALTIME" >> '$T'/order; sleep $2' _ $2 ${4:-0.3} > $T/$2.out 2>&1 & PID[$2]=${!} }
# p <script> <name> <poll pause> [seconds] - the same waiter with the train's priority
p() { SLOT_PRIORITY=1 w "$@" }
order() { [[ -s $T/order ]] && print -r -- ${(j: :)${(f)"$(awk '{print $1}' $T/order)"}} }
got() { grep -q "^$1 " $T/order 2>/dev/null }
n_order() { [[ -s $T/order ]] && wc -l < $T/order | tr -d ' ' || print 0 }
# number of the live ticket of a waiter (by its pid in the ticket) - empty if none
ticket() { local f; for f in $SLOTS_DIR/queue/<->(N); do [[ ${${=$(<$f)}[2]} == $1 ]] && { print -r -- ${f:t}; return }; done }

[[ -f $H/slots.zsh ]] || { print -r -- "  FAIL no $H/slots.zsh"; exit 1; }

# 1. both heavy slots busy; S (single heavy, B7) and N (plain) come first, the priority P1 and P2 later; one slot is
#    released - they go one at a time: P1 P2 S N (B1: P1 before the earlier S; B3: P1 before P2 by number; B2: S, N
#    after the priority ones and in their own order)
: > $T/order
hold heavy.sh h1; hold heavy.sh h2; waitfor 'started h1 && started h2'
w heavy.sh S 0.2; sleep 0.6; w heavy.sh N 0.2; sleep 0.6
p heavy.sh P1 0.2; sleep 0.6; p heavy.sh P2 0.2
sleep 2
ok '1. while the slots are busy nobody went' '[[ $(n_order) == 0 ]]' "$(order)"
ok '1. B14 the first priority waiter is first: "position 1 in queue"' 'grep -q "waiting for slot heavy, position 1 in queue" $T/P1.out' "$(tail -1 $T/P1.out)"
ok '1. B14 the second priority waiter: "position 2"' 'grep -q "waiting for slot heavy, position 2 in queue" $T/P2.out' "$(tail -1 $T/P2.out)"
t1=$(ticket $PID[P1])
ok '1. B14 the earlier plain S counts both priority tickets ahead and names P1 first' 'grep -q "waiting for slot heavy, position 3 in queue.*2 ahead; the first is ticket $t1 " $T/S.out' "P1 ticket $t1; S: $(tail -1 $T/S.out)"
ok '1. B14 ... N is fourth' 'grep -q "waiting for slot heavy, position 4 in queue" $T/N.out' "$(tail -1 $T/N.out)"
touch $T/rel.h1
waitfor '[[ $(n_order) == 4 ]]' 200
ok '1. B1 B2 B3 B7 slots go P1 P2 S N' '[[ "$(order)" == "P1 P2 S N" ]]' "got: $(order)"
endcase

# 2. B4: a priority waiter killed while it waits (kill -9) does not hold the queue: S goes
: > $T/order
hold heavy.sh h1; hold heavy.sh h2; waitfor 'started h1 && started h2'
w heavy.sh S 0.3; sleep 0.6; p heavy.sh X 0.3; sleep 0.8
kill -9 $PID[X] 2>/dev/null; bwait X
touch $T/rel.h1
waitfor 'got S' 80
ok '2. B4 the dead priority X does not hold the queue - S went' 'got S && ! got X' "got: $(order); $(tail -1 $T/S.out)"
endcase

# 3. B5: R (priority) exits 75 with SLOT_RETRY_RC=75 - back to the queue with its ticket AND its priority: the earlier
#    plain S still does not overtake it
: > $T/order
hold heavy.sh r1; hold heavy.sh r2; waitfor 'started r1 && started r2'
w heavy.sh S 0.2; sleep 0.6
SLOT_PRIORITY=1 SLOT_RETRY_RC=75 SLOT_POLL=0.2 $H/heavy.sh zsh -c 'zmodload zsh/datetime; [[ -e '$T'/R.once ]] || { touch '$T'/R.once; sleep 0.5; exit 75 }; print -r -- "R $EPOCHREALTIME" >> '$T'/order' > $T/R.out 2>&1 & PID[R]=${!}
sleep 1.5
touch $T/rel.r1
waitfor 'got R && got S' 100
ok '3. B5 a retry keeps the priority: R before the earlier S' '[[ -e $T/R.once && "$(order)" == "R S" ]]' "got: $(order); R: $(tail -2 $T/R.out)"
endcase

# 4. B8: shared ceiling SLOT_TOTAL_MAX=2: the last slot of the ceiling goes by number to the earlier medium MW, not to
#    the later priority heavy HP (the rule of the last slot is unchanged)
export SLOT_TOTAL_MAX=2
: > $T/order
hold heavy.sh P1; waitfor 'started P1'; hold medium.sh M1; waitfor 'started M1'
w medium.sh MW 1.5 6; sleep 0.8; p heavy.sh HP 0.2; sleep 1.5
touch $T/rel.M1
sleep 3
ok '4. B8 the last slot of the ceiling - to the earlier medium MW, the later priority heavy waits' 'got MW && ! got HP' "got: $(order)"
touch $T/rel.P1
waitfor 'got HP' 100
ok '4. ... then the heavy too' 'got HP' "got: $(order)"
endcase; unset SLOT_TOTAL_MAX

# 5. guards-all.sh --priority (the train) goes ahead of an earlier single heavy job S; guards-all.sh on a worktree named
#    train-x WITHOUT the flag (B11) gets no priority: the later priority P goes ahead of it
: > $T/order
hold heavy.sh g1; hold heavy.sh g2; waitfor 'started g1 && started g2'
w heavy.sh S 0.2; sleep 0.6
SLOT_POLL=0.3 $H/guards-all.sh --priority xo > $T/G.out 2>&1 & PID[G]=${!}
sleep 1.5
ok '5. guards-all.sh --priority is accepted (not a usage error)' 'kill -0 $PID[G] 2>/dev/null' "$(cat $T/G.out)"
ok '5. guards-all.sh --priority waits first: "position 1 in queue"' 'grep -q "waiting for slot heavy, position 1 in queue" $T/G.out' "$(tail -2 $T/G.out)"
touch $T/rel.g1
waitfor 'got xo && got S' 200
ok '5. the train run went before the earlier single heavy job' '[[ "$(order)" == "xo S" ]]' "got: $(order); G: $(tail -3 $T/G.out)"
bwait G S g1; rm -f $T/rel.g1 $T/g1.start; hold heavy.sh g1; waitfor 'started g1'
: > $T/order
SLOT_POLL=0.3 $H/guards-all.sh train-x > $T/TX.out 2>&1 & PID[TX]=${!}
sleep 1.5; p heavy.sh P 0.2; sleep 1.5
ok '5. B11 the run of a worktree named train-x without --priority is not ahead: P is "position 1"' 'grep -q "waiting for slot heavy, position 1 in queue" $T/P.out' "P: $(tail -1 $T/P.out) | TX: $(tail -1 $T/TX.out)"
touch $T/rel.g1
waitfor 'got P && got train-x' 200
ok '5. B11 ... the explicit priority goes first: P train-x' '[[ "$(order)" == "P train-x" ]]' "got: $(order)"
endcase

# 6. the priority is the queue's, not the command's: the command does not inherit SLOT_PRIORITY (a heavy.sh inside a
#    train run is not a train); a value other than 0 or 1 is refused with 64, no slot
SLOT_PRIORITY=1 $H/heavy.sh zsh -c 'print -r -- "prio=${SLOT_PRIORITY:-none}"' > $T/E.out 2>&1
ok '6. the command of a priority slot does not see SLOT_PRIORITY' 'grep -qx "prio=none" $T/E.out' "$(cat $T/E.out)"
SLOT_PRIORITY=yes $H/heavy.sh true > $T/V.out 2>&1; rc=$?
ok '6. SLOT_PRIORITY=yes -> 64, named in the message' '(( rc == 64 )) && grep -q SLOT_PRIORITY $T/V.out' "rc $rc: $(cat $T/V.out)"
SLOT_PRIORITY=0 $H/heavy.sh true > $T/Z.out 2>&1; rc=$?
ok '6. SLOT_PRIORITY=0 -> a plain run, exit 0' '(( rc == 0 ))' "rc $rc: $(cat $T/Z.out)"

print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
