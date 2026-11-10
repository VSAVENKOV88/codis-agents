#!/bin/zsh
# Tester's cells of the train's priority in the slot queue (p-runq-b1), on a TEMPORARY slot directory and a fake
# machine, as tests/slots-priority.test.sh. Exit code 0 - everything holds.
#   usage: tests/slots-priority-tester.test.sh   |   SLOTS_H=<dir with slots.zsh/heavy.sh/...> tests/slots-priority-tester.test.sh
# Cases: 1. the last slot of the shared ceiling never stays idle when the head of heavy is a priority ticket behind an
#   EARLIER plain heavy waiter and a medium waiter sits between them (the medium compares itself with the first heavy
#   ticket by number, the priority head with the medium: each must not yield to a waiter that cannot go);
#   2. B6 - a priority whole run first in the queue waits outside the slot while a single heavy job runs, and an
#   earlier plain heavy waiter does not take the free second slot past it; then the priority one goes first;
#   3. an empty SLOT_PRIORITY is a plain run (0), not a refusal; 4. B15 - the journal line of a priority run has the
#   same fields as a plain one (format v1 unchanged); 5. (round 2) the mirror of 1: the head of MEDIUM is a priority
#   ticket behind an earlier plain medium waiter and a heavy waiter sits between them - the heavy weighs itself against
#   the head of medium (the priority one, a larger number), not the earlier plain medium, so the heavy goes (decision 6:
#   by number between the heads).
H=${SLOTS_H:-${0:A:h:h}/scripts}
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-prio.XXXXXX")
# no machine file of the box (a runner's swapMinMB would change the thresholds the cases rely on), as under tests/run.js
export XDG_CONFIG_HOME=$T/no-xdg; unset CODIS_AGENTS_MACHINE
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

# 1. ceiling 3, heavy 2, medium 2. h1 h2 (heavy) and m1 (medium) hold all 3. Waiters by number: H (plain heavy),
#    M (medium), P (priority heavy). h2 ends: one slot of the ceiling, and both a heavy and a medium slot are free.
#    Somebody of the two heads (M, P) must take it; nobody taking it is a livelock (M yields to the earlier H, who is
#    not the head of heavy and never goes, P yields to the earlier M).
export SLOT_TOTAL_MAX=3
: > $T/order
hold heavy.sh h1; hold heavy.sh h2; waitfor 'started h1 && started h2'; hold medium.sh m1; sleep 1.5
w heavy.sh H 0.2; sleep 0.6; w medium.sh M 0.2 3; sleep 0.6; p heavy.sh P 0.2 3; sleep 1.5
ok '1. while the ceiling is full nobody went' '[[ $(n_order) == 0 ]]' "got: $(order)"
touch $T/rel.h2
waitfor 'got M || got P' 60
ok '1. the last slot of the ceiling is taken (by M or P) - it does not stay idle' 'got M || got P' "got: $(order) | M: $(tail -1 $T/M.out) | P: $(tail -1 $T/P.out) | H: $(tail -1 $T/H.out)"
ok '1. ... the plain H, not the head of heavy, did not go' '! got H' "got: $(order)"
endcase; unset SLOT_TOTAL_MAX

# 2. B6: h1 and h2 (single heavy) hold both slots; S (plain single heavy) comes first, then W (priority, kind whole).
#    h2 ends: W is the head, cannot be admitted (whole needs the whole budget while h1 runs) and waits outside the slot; S must
#    not take the free second heavy slot past it. h1 ends - W goes, S after it.
: > $T/order
hold heavy.sh h1; waitfor 'started h1'
hold heavy.sh h2; waitfor 'started h2'
w heavy.sh S 0.2; sleep 0.6
SLOT_KIND=whole SLOT_PRIORITY=1 w heavy.sh W 0.2; sleep 0.8
touch $T/rel.h2; sleep 2.5
ok '2. B6 the priority whole run waits outside the slot while h1 runs' '! got W && grep -q "full run without {jobs}" $T/W.out' "got: $(order) | W: $(tail -1 $T/W.out)"
ok '2. B6 the earlier plain S does not take the free slot past the waiting priority head' '! got S && grep -q "ahead; the first is ticket .* priority" $T/S.out' "got: $(order) | S: $(tail -1 $T/S.out)"
touch $T/rel.h1
waitfor 'got W && got S' 100
ok '2. B6 then the priority whole run goes first, S after it' '[[ "$(order)" == "W S" ]]' "got: $(order)"
endcase

# 3. SLOT_PRIORITY empty - a plain run (as unset), exit 0
SLOT_PRIORITY= $H/heavy.sh true > $T/E.out 2>&1; rc=$?
ok '3. empty SLOT_PRIORITY -> a plain run, exit 0' '(( rc == 0 ))' "rc $rc: $(cat $T/E.out)"

# 4. B15: journal lines of a plain and of a priority run have the same number of tab-separated fields
J=$SLOTS_DIR/journal.tsv; rm -f $J
$H/heavy.sh true; SLOT_PRIORITY=1 $H/heavy.sh true
nf=( ${(f)"$(awk -F'\t' '{print NF}' $J 2>/dev/null)"} )
ok '4. B15 two journal lines, the same fields with and without priority' '(( ${#nf} == 2 )) && [[ $nf[1] == $nf[2] ]]' "fields: ${nf[*]} | $(cat $J 2>/dev/null)"
ok '4. B15 the priority line does not carry the word priority (format v1 unchanged)' '! grep -q priority $J' "$(tail -1 $J)"

# 5. (round 2) mirror of 1 for the medium queue: ceiling 3, heavy 2, medium 2; h1 h2 and m1 hold all 3. Waiters by
#    number: N (plain medium), H (plain heavy), Q (priority medium). h2 ends: the heads are H (heavy) and Q (medium);
#    by number between the heads H goes; N (not the head of medium) and Q wait. Nobody going is the livelock of 1.
export SLOT_TOTAL_MAX=3
: > $T/order
hold heavy.sh h1; hold heavy.sh h2; waitfor 'started h1 && started h2'; hold medium.sh m1; sleep 1.5
w medium.sh N 0.2 3; sleep 0.6; w heavy.sh H 0.2 3; sleep 0.6; p medium.sh Q 0.2 3; sleep 1.5
ok '5. while the ceiling is full nobody went' '[[ $(n_order) == 0 ]]' "got: $(order)"
touch $T/rel.h2
waitfor 'got H || got N || got Q' 60; sleep 1
ok '5. the last ceiling slot goes to the heavy head H (smaller number than the priority medium head Q)' '[[ "$(order)" == "H" ]]' "got: $(order) | N: $(tail -1 $T/N.out) | H: $(tail -1 $T/H.out) | Q: $(tail -1 $T/Q.out)"
endcase; unset SLOT_TOTAL_MAX

print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
