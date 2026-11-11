#!/bin/zsh
# Tester cells of A2b-1a, run as a child of tests/slots-exec.test.sh (scripts/slots.zsh, slot-holder.zsh, slot-group.pl, slot-hold.sh) that tests/slots-exec.test.sh
# does not hold:
#   TC1 a command whose whole group is stopped (SIGSTOP, as a job that read the terminal gets SIGTTIN): a TERM to
#       heavy.sh ends it at once - the holder sends CONT with the TERM - not after SLOT_KILL_GRACE;
#   TC1b the same for a stopped leftover after a normal end;
#   TC2 medium.sh x TERM with a stubborn command: the medium slot is held during the pause, 143, journal line rc 143,
#       the slot free and the marker gone after the group;
#   TC3 slot-hold.sh x TERM while it holds: 143, the slot free, no marker, journal kind hold rc 143;
#   TC4 heavy.sh of an exclusive guard x TERM, the guard ignores TERM: it lives in the held heavy slot during the pause;
#       after the KILL the exclusive lock and the slot are free (A'25: the lock is not left behind);
#   TC5 guards-all.sh x TERM, the runner and its child ignore TERM: nothing of the runner's group is left, the slot is
#       free after it, exit 143 (A'25);
#   TC6 two markers on one slot, one of a dead group and one of a live group: busy; the live group ends - the waiter runs
#       and both markers are gone (A'5);
#   TC7 a half-written marker (<slot>.exectmp.<pgid>) of a dead writer on a free slot: the waiter takes the slot and
#       removes it.
H=${SLOTS_H:-${0:A:h:h}/scripts}
zmodload zsh/datetime zsh/system
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-exec-tester.XXXXXX"); T=${T:A}
export XDG_CONFIG_HOME=$T/no-xdg; unset CODIS_AGENTS_MACHINE
unset GUARDS_EXCLUSIVE_LOCK SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_PRIORITY SLOT_KILL_GRACE SLOT_EMPTY_WAIT SLOT_EXEC_NOTE CODIS_SLOT_HELD SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_PROC GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
export SLOTS_DIR=$T/slots SLOT_JOURNAL=$T/journal.tsv SLOT_LEGACY_LOCK= SLOT_POLL=0.2 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
export SLOT_HEAVY_N=1 SLOT_MEDIUM_N=1 SLOT_KILL_GRACE=2 SLOT_EMPTY_WAIT=2
export GUARDS_EXCLUSIVE_LOCK=$T/exclusive.lock
export SLOT_OS=darwin
mkdir -p $T/wts/xo $T/shared $T/bin
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared",
  "guardCommand": "cd {wt} && ./g.sh {jobs}"}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
print -r -- '#!/bin/zsh
[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"
print -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"' > $T/bin/sysctl
print -r -- '#!/bin/zsh
print -r -- "System-wide memory free percentage: 20%"' > $T/bin/memory_pressure
print -r -- '#!/bin/zsh
print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
print -r -- "Swapouts:                                   0."' > $T/bin/vm_stat
print -r -- '#!/bin/zsh
print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"
print -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"' > $T/bin/df
chmod +x $T/bin/*; export PATH=$T/bin:$PATH
S1=$SLOTS_DIR/heavy.1.lock M1=$SLOTS_DIR/medium.1.lock

pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
waitfor() { local i; for i in {1..${2:-100}}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
_tree() { local c; for c in $(pgrep -P $1 2>/dev/null); do _tree $c; done; print -r -- $1 }
typeset -a BG GROUPS_MADE
gkill() { [[ $1 == <2-> ]] && kill -9 -- -$1 2>/dev/null }
cleanup() { local p g i; for p in $BG; do for i in $(_tree $p); do kill -9 $i 2>/dev/null; done; done
  for g in $GROUPS_MADE; do gkill $g; done }
trap 'cleanup; rm -rf $T' EXIT
bwait() { waitfor "! kill -0 $1 2>/dev/null" ${2:-100}; kill -0 $1 2>/dev/null && { local i; for i in $(_tree $1); do kill -9 $i 2>/dev/null; done; wait $1 2>/dev/null; return 124; }; wait $1 }
tm() { local s=$1 p; shift; "$@" & p=$!; BG+=$p; bwait $p $(( s * 10 )) }
busy() { [[ -e $1 ]] || return 1; ( zsystem flock -t 0 -f _f $1 ) 2>/dev/null; (( $? == 1 )) }
galive() { [[ $1 == <2-> ]] || return 1; perl -MPOSIX -e 'exit(kill(0, -$ARGV[0]) || $!+0 == POSIX::EPERM() ? 0 : 1)' $1 }
lead() { exec perl -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; setpgrp(0,0) or die "setpgrp: $!"; exec { $ARGV[0] } @ARGV or die "exec: $!"' "$@" }
markers() { print -r -- $SLOTS_DIR/*.exec*(N:t) }
# exclusive lock held: flock(2) probe with lockf (macOS) or flock (Linux), as slots.zsh takes it
exbusy() { if [[ -x /usr/bin/lockf ]]; then ! /usr/bin/lockf -s -t 0 $GUARDS_EXCLUSIVE_LOCK true 2>/dev/null; else ! flock -n $GUARDS_EXCLUSIVE_LOCK true 2>/dev/null; fi }

[[ -f $H/slots.zsh ]] || { print -r -- "  FAIL no $H/slots.zsh"; exit 1; }

# TC1. the whole group stopped (leader and child): TERM to heavy.sh ends it at once (CONT with the TERM)
export SLOT_KILL_GRACE=20
rm -f $T/1.c
lead $H/heavy.sh zsh -c 'sh -c "kill -STOP \$\$; sleep 60" & print -r -- $! > '$T'/1.kid; print -r -- $$ > '$T'/1.c; kill -STOP $$; sleep 60' > $T/1.out 2>&1 & w1=$!; BG+=$w1; GROUPS_MADE+=$w1
waitfor '[[ -s $T/1.c ]]'; c1=$(<$T/1.c); kid1=$(<$T/1.kid); GROUPS_MADE+=$c1
waitfor "[[ \$(ps -o stat= -p $c1) == T* && \$(ps -o stat= -p $kid1) == T* ]]" 30
ok "TC1. (setup) the command and its child are stopped" '[[ $(ps -o stat= -p $c1) == T* && $(ps -o stat= -p $kid1) == T* ]]' "$(ps -o pid,stat,command -p $c1,$kid1)"
t0=$EPOCHREALTIME; kill -TERM $w1
bwait $w1 150; rc=$?; dt=$(( EPOCHREALTIME - t0 ))
ok "TC1. TERM to heavy.sh of a stopped group: 143 within 3 s (not after SLOT_KILL_GRACE 20 s), nothing left, marker gone" '(( rc == 143 && dt < 3 )) && ! galive $c1 && [[ -z $(markers) ]] && ! busy $S1' "rc $rc in $dt s, markers '$(markers)'; $(tail -2 $T/1.out)"
# TC1b. a normal end (rc 3) with a stopped leftover in the group: it ends at once, not after SLOT_KILL_GRACE (once the
# leader is gone the group is orphaned, and the kernel itself sends HUP and CONT to its stopped members; the stop of
# slot-group.pl sends CONT too)
rm -f $T/1b.kid
t0=$EPOCHREALTIME
tm 15 $H/heavy.sh zsh -c 'sh -c "kill -STOP \$\$; sleep 60" & print -r -- $! > '$T'/1b.kid; sleep 0.5; exit 3' > $T/1b.out 2>&1; rc=$?; dt=$(( EPOCHREALTIME - t0 ))
ok "TC1b. a stopped leftover after a normal end: code 3 within 3 s (not after SLOT_KILL_GRACE 20 s), leftover gone, slot free" '(( rc == 3 && dt < 3 )) && ! kill -0 $(<$T/1b.kid) 2>/dev/null && [[ -z $(markers) ]] && ! busy $S1' "rc $rc in $dt s, markers '$(markers)'; $(tail -2 $T/1b.out)"
export SLOT_KILL_GRACE=2

# TC2. medium.sh x TERM, the command ignores TERM: medium slot held in the pause, 143, then free
print -r -- 'trap "" TERM; print -r -- $$ > '$T'/2.c; while :; do sleep 0.2; done' > $T/s2.zsh
lead $H/medium.sh zsh $T/s2.zsh > $T/2.out 2>&1 & w2=$!; BG+=$w2; GROUPS_MADE+=$w2
waitfor '[[ -s $T/2.c ]]'; c2=$(<$T/2.c); GROUPS_MADE+=$c2
ok "TC2. (setup) medium.sh runs its command in the medium slot, marked" 'busy $M1 && [[ -e $M1.exec.$c2 ]]' "markers '$(markers)'"
t0=$EPOCHREALTIME; kill -TERM $w2; sleep 1
ok "TC2. in the pause: medium.sh alive, the medium slot held" 'kill -0 $w2 2>/dev/null && busy $M1' "$(tail -2 $T/2.out)"
bwait $w2 80; rc=$?; dt=$(( EPOCHREALTIME - t0 ))
ok "TC2. KILL after the pause: 143, the group gone, the slot free, the marker gone" '(( rc == 143 && dt >= 2 )) && ! galive $c2 && ! busy $M1 && [[ ! -e $M1.exec.$c2 ]]' "rc $rc in $dt s; $(tail -2 $T/2.out)"
ok "TC2. ... one journal line: class medium, rc 143" 'grep -q $'"'"'\tmedium\t1\tsingle\t[0-9]*\t143\t'"'"' $SLOT_JOURNAL' "$(tail -2 $SLOT_JOURNAL)"

# TC3. slot-hold.sh x TERM while it holds: 143, the slot free, no marker, journal kind hold rc 143
mkfifo $T/h.in
( exec 3>$T/h.in; sleep 30 ) & feeder=$!; BG+=$feeder
lead $H/slot-hold.sh heavy < $T/h.in > $T/h.out 2> $T/h.err & w3=$!; BG+=$w3; GROUPS_MADE+=$w3
waitfor 'grep -q "^acquired " $T/h.out' 100
ok "TC3. (setup) slot-hold.sh holds the heavy slot" 'busy $S1 && [[ -n $(markers) ]]' "$(cat $T/h.out $T/h.err)"
kill -TERM $w3
bwait $w3 50; rc=$?
ok "TC3. TERM to slot-hold.sh: 143, the slot free, no marker left" '(( rc == 143 )) && ! busy $S1 && [[ -z $(markers) ]]' "rc $rc, markers '$(markers)'; $(cat $T/h.err)"
ok "TC3. ... journal line kind hold, rc 143" 'grep -q $'"'"'\theavy\t1\thold\t[0-9]*\t143\t'"'"' $SLOT_JOURNAL' "$(tail -2 $SLOT_JOURNAL)"
kill $feeder 2>/dev/null

# TC4. heavy.sh of an exclusive guard x TERM, the guard ignores TERM: exclusive lock held in the pause, free after
print -r -- '// guards:exclusive — a fixed port of the test
process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);' > $T/x-run.js
lead $H/heavy.sh node $T/x-run.js $T/4.c > $T/4.out 2>&1 & w4=$!; BG+=$w4; GROUPS_MADE+=$w4
waitfor '[[ -s $T/4.c ]]' 150; c4=$(<$T/4.c)
g4=$(ps -o pgid= -p ${c4:-0} | tr -d ' '); GROUPS_MADE+=$g4
ok "TC4. (setup) the exclusive guard runs under the exclusive lock in the heavy slot" 'exbusy && busy $S1' "$(tail -3 $T/4.out)"
t0=$EPOCHREALTIME; kill -TERM $w4; sleep 1
ok "TC4. in the pause: the guard lives in the held heavy slot" 'kill -0 $c4 2>/dev/null && busy $S1' "$(ps -o pid,pgid,stat,command -g ${g4:-0} 2>/dev/null); $(tail -2 $T/4.out)"
# not a cell: lockf (in the command's group) dies on the TERM and with it the flock(2) lock, while a guard that ignores
# TERM lives on in the held slot until the KILL - printed for the report, not judged
print -r -- "  note TC4. exclusive lock during the pause: $(exbusy && print held || print free)"
bwait $w4 80; rc=$?; dt=$(( EPOCHREALTIME - t0 ))
ok "TC4. after KILL: 143, the guard gone, the exclusive lock and the slot free" '(( rc == 143 && dt >= 2 )) && ! kill -0 $c4 2>/dev/null && ! exbusy && ! busy $S1 && [[ -z $(markers) ]]' "rc $rc in $dt s, markers '$(markers)'; $(tail -2 $T/4.out)"

# TC5. guards-all.sh x TERM, the runner and its child ignore TERM: nothing of the runner's group left, slot free, 143
print -r -- '#!/bin/zsh
( trap "" TERM; print -r -- $$ > '$T'/5.kid; sleep 60 ) &
trap "" TERM
print -r -- $$ > '$T'/5.c
while :; do sleep 0.2; done' > $T/wts/xo/g.sh; chmod +x $T/wts/xo/g.sh
rm -f $T/5.c
lead $H/guards-all.sh --force xo > $T/5.out 2>&1 & w5=$!; BG+=$w5; GROUPS_MADE+=$w5
waitfor '[[ -s $T/5.c ]]' 150; c5=$(<$T/5.c); g5=$(ps -o pgid= -p ${c5:-0} | tr -d ' '); GROUPS_MADE+=$g5
ok "TC5. (setup) the runner of guards-all.sh runs in a group of its own, marked on the heavy slot" '[[ -n $g5 && $g5 != $w5 && -e $S1.exec.$g5 ]] && busy $S1' "group '$g5', guards-all $w5, markers '$(markers)'; $(tail -3 $T/5.out)"
t0=$EPOCHREALTIME; kill -TERM $w5; sleep 1
ok "TC5. in the pause: guards-all.sh alive, the slot held" 'kill -0 $w5 2>/dev/null && busy $S1' "$(tail -2 $T/5.out)"
bwait $w5 100; rc=$?; dt=$(( EPOCHREALTIME - t0 ))
ok "TC5. guards-all.sh exits 143 after the runner's group is gone; the slot free, the marker gone" '(( rc == 143 && dt >= 2 )) && ! galive $g5 && ! busy $S1 && [[ -z $(markers) ]]' "rc $rc in $dt s, markers '$(markers)'; $(ps -o pid,pgid,stat,command -g ${g5:-0} 2>/dev/null); $(tail -3 $T/5.out)"

# TC6. two markers on one slot (a dead group and a live one): busy; the live one ends - the waiter runs, both removed
lead sleep 3 & g6=$!; BG+=$g6; GROUPS_MADE+=$g6
: >> $S1
print -r -- 99999999 > $S1.exec.99999999
print -r -- $g6 > $S1.exec.$g6
rm -f $T/6.ran
$H/heavy.sh touch $T/6.ran > $T/6.out 2>&1 & w6=$!; BG+=$w6
sleep 1
ok "TC6. a dead and a live marker on a free lock: the waiter does not run" '[[ ! -e $T/6.ran ]] && kill -0 $w6 2>/dev/null' "$(tail -2 $T/6.out)"
bwait $w6 100; rc=$?
ok "TC6. the live group ended: the waiter ran, both markers removed" '(( rc == 0 )) && [[ -e $T/6.ran && -z $(markers) ]]' "rc $rc, markers '$(markers)'; $(tail -2 $T/6.out)"

# TC7. a half-written marker of a dead writer on a free slot: the waiter takes the slot and removes it
print -r -- 99999998 > $S1.exectmp.99999998
tm 10 $H/heavy.sh true > $T/7.out 2>&1; rc=$?
ok "TC7. a leftover <slot>.exectmp.<pgid> on a free slot: the slot is given and the leftover removed" '(( rc == 0 )) && [[ ! -e $S1.exectmp.99999998 ]]' "rc $rc, files '$(markers)'; $(tail -2 $T/7.out)"

print -r -- "slots-exec-tester: $pass ok, $fail failed"
(( fail == 0 ))
