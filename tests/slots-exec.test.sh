#!/bin/zsh
# tests:quiet - slot holders stopped with pauses of 2 s and waiters polled every 0.2 s; timings stretch under load
# The command of a slot runs in its own process group, named by an exec marker <slot>.exec.<pgid>; its holder runs in a
# group of its own and stops the command's group itself (TERM and CONT, SLOT_KILL_GRACE, KILL, SLOT_EMPTY_WAIT); the
# slot stays busy while its holder's lock is held OR a marker names a group that lives (EPERM counts as alive) OR a
# marker cannot be read. CODIS_SLOT_HELD lets a command inside a held slot run heavy.sh / medium.sh without a second
# ticket. slot-hold.sh holds a slot while its standard input is open. A temporary slot directory and a fake machine.
#   usage: tests/slots-exec.test.sh   (SLOTS_H=<dir with slots.zsh/heavy.sh/...> - check other copies)
# Cells A'1-A'29 of the A2b-1a analysis (A'23, the terminal of the owner, is a Known gap of the README, no case here):
#   A'1 a live marked group holds a free lock; A'2 EPERM (a group of root; a group whose only member is a zombie)
#   holds it; A'3 a dead marker frees it and is removed; A'4 a marker that cannot be read holds it and is named;
#   A'5 the marker exists before the command's first instruction, the command leads its own group; A'6/A'7
#   slot-hold.sh: one "acquired" line, released by "release" or by EOF, journal kind hold with SLOT_LABEL; A'8 kill -9
#   of the holder: the marker keeps the slot until the command ends; A'9 a waiter stops at once on TERM; A'10-A'14
#   CODIS_SLOT_HELD; A'15 slot-journal.js and kinds hold/nested; A'16 a plain run as before; A'17 leftovers of the group
#   after a normal end; A'18 TERM/INT/HUP to heavy.sh or to its group: the holder stops the group, the slot is given
#   after ESRCH; A'19 a second signal changes nothing; A'20 a group not empty after KILL keeps its marker; A'21 KILL of
#   the caller's group: the command runs on in its slot; A'22 the stop of the Bash tool (TERM to the tree, KILL 1.5 s
#   later); A'24 the train lock lives while a group noted in <lock>/exec lives (a real guards-all.sh); A'26 a command
#   that cannot run: 127 / 126; A'27 sourcing without perl is refused (72, one line); A'29 the pauses default to the
#   pause of the roles (role-exec.js KILL_GRACE_MS).
H=${SLOTS_H:-${0:A:h:h}/scripts}
zmodload zsh/datetime zsh/system
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-exec.XXXXXX"); T=${T:A}
# no machine file of the box, as under tests/run.js
export XDG_CONFIG_HOME=$T/no-xdg; unset CODIS_AGENTS_MACHINE
unset GUARDS_EXCLUSIVE_LOCK SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_PRIORITY SLOT_KILL_GRACE SLOT_EMPTY_WAIT SLOT_EXEC_NOTE CODIS_SLOT_HELD SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_PROC GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
export SLOTS_DIR=$T/slots SLOT_JOURNAL=$T/journal.tsv SLOT_LEGACY_LOCK= SLOT_POLL=0.2 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
# one heavy and one medium slot (the extra heavy slot is refused on the fake machine: free 20 %); pauses of 2 s
export SLOT_HEAVY_N=1 SLOT_MEDIUM_N=1 SLOT_KILL_GRACE=2 SLOT_EMPTY_WAIT=2
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
# cleanup: every process group the test made and every tree it started, with KILL (stubborn commands ignore TERM)
cleanup() { local p g i; for p in $BG; do for i in $(_tree $p); do kill -9 $i 2>/dev/null; done; done
  for g in $GROUPS_MADE; do gkill $g; done }
# gkill <pgid> - KILL to a group the test made; never to 0 or 1 (an empty value read from a file that a broken slot
# script never wrote would make it "-0": the test's own group)
gkill() { [[ $1 == <2-> ]] && kill -9 -- -$1 2>/dev/null }
trap 'cleanup; rm -rf $T' EXIT
trap '' PIPE   # a write to the fifo of a holder that is gone must not end the test
# bwait <pid> [tenths] - waits for a background job, then KILLs its tree: code 124
bwait() { waitfor "! kill -0 $1 2>/dev/null" ${2:-100}; kill -0 $1 2>/dev/null && { local i; for i in $(_tree $1); do kill -9 $i 2>/dev/null; done; wait $1 2>/dev/null; return 124; }; wait $1 }
# tm <seconds> <command...> - the command, KILLed with its tree after <seconds>: code 124
tm() { local s=$1 p; shift; "$@" & p=$!; BG+=$p; bwait $p $(( s * 10 )) }
# busy <file> - an fcntl probe from its own process: 0 - the lock is held
busy() { [[ -e $1 ]] || return 1; ( zsystem flock -t 0 -f _f $1 ) 2>/dev/null; (( $? == 1 )) }
# galive <pgid> - the group lives (kill 0 succeeds, or EPERM)
galive() { [[ $1 == <2-> ]] || return 1; perl -MPOSIX -e 'exit(kill(0, -$ARGV[0]) || $!+0 == POSIX::EPERM() ? 0 : 1)' $1 }
# lead <command...> & - the command in a process group of its own (as wait-step.js and guards-remote-host.js start
# jobs), always in the background: the subshell of `&` becomes perl and then the command, so $! is the command's pid and
# its group; INT and QUIT back to their defaults (a job of a non-interactive shell starts with them ignored)
lead() { exec perl -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; setpgrp(0,0) or die "setpgrp: $!"; exec { $ARGV[0] } @ARGV or die "exec: $!"' "$@" }
holder_of() { pgrep -P $1 -f slot-holder 2>/dev/null | head -1 }
markers() { print -r -- $SLOTS_DIR/*.exec.*(N:t) }
jline() { local n; n=$(grep -c $'\t'"$1"$'\t' $SLOT_JOURNAL 2>/dev/null); print -r -- ${n:-0} }

[[ -f $H/slots.zsh ]] || { print -r -- "  FAIL no $H/slots.zsh"; exit 1; }

# A'16. a plain run: the code, one journal line, the slot free at once, no marker left
t0=$EPOCHREALTIME
tm 20 $H/heavy.sh zsh -c 'exit 4' > $T/16.out 2>&1; rc=$?
ok "A'16. heavy.sh of a plain command: its code (4), the slot free at once, no marker left" '(( rc == 4 )) && ! busy $S1 && [[ -z $(markers) ]] && (( EPOCHREALTIME - t0 < 1.9 ))' "rc $rc, markers '$(markers)', $(( EPOCHREALTIME - t0 )) s; $(tail -3 $T/16.out)"
ok "A'16. ... one journal line kind single with its code" '[[ $(grep -c $'"'"'\tsingle\t'"'"' $SLOT_JOURNAL) == 1 ]] && grep -q $'"'"'\theavy\t1\tsingle\t[0-9]*\t4\t'"'"' $SLOT_JOURNAL' "$(cat $SLOT_JOURNAL)"

# A'5. the marker exists before the first instruction of the command; the command leads its own group
tm 20 $H/heavy.sh zsh -c 'g=$(perl -e "print getpgrp"); print -r -- "$g $$ $(ls $SLOT_PATH.exec.* 2>/dev/null)" > '$T'/5.seen' > $T/5.out 2>&1; rc=$?
s5=( $(<$T/5.seen) )
ok "A'5. the command leads its own process group (pgid == its pid)" '(( rc == 0 )) && [[ -n $s5[1] && $s5[1] == $s5[2] ]]' "rc $rc seen '$s5'; $(tail -3 $T/5.out)"
ok "A'5. ... and its marker <slot>.exec.<pgid> is there at its first instruction" '[[ $s5[3] == $S1.exec.$s5[1] ]]' "seen '$s5'"
ok "A'5. ... removed after the group ended" '[[ -z $(markers) ]]' "$(markers)"

# A'1. a free lock and a marker of a live group: busy, the waiter does not run; the group ends - the waiter runs
lead perl -e 'sleep 60' & g1=$!; GROUPS_MADE+=$g1; BG+=$g1
waitfor "[[ \$(ps -o pgid= -p $g1 | tr -d ' ') == $g1 ]]"
print -r -- $g1 > $S1.exec.$g1; : >> $S1
rm -f $T/1.ran
$H/heavy.sh touch $T/1.ran > $T/1.out 2>&1 & w1=$!; BG+=$w1
sleep 1.5
ok "A'1. a live marked group holds a free slot lock: the waiter does not run" '[[ ! -e $T/1.ran ]] && kill -0 $w1 2>/dev/null' "$(tail -3 $T/1.out)"
ok "A'1. ... the waiting line names the marker" 'grep -q "exec marker" $T/1.out' "$(tail -3 $T/1.out)"
kill -9 $g1; wait $g1 2>/dev/null
bwait $w1 50; rc=$?
ok "A'1. the group ended: the waiter takes the slot and runs" '(( rc == 0 )) && [[ -e $T/1.ran ]]' "rc $rc; $(tail -3 $T/1.out)"
# A'3. the dead marker was removed by the waiter that took the slot
ok "A'3. the marker of the dead group is removed by the waiter that took the slot" '[[ ! -e $S1.exec.$g1 ]]' "$(markers)"

# A'3. a marker of a group that is gone from the start: the slot is free, the marker removed
lead true & g3=$!; wait $g3
print -r -- $g3 > $S1.exec.$g3
tm 10 $H/heavy.sh true > $T/3.out 2>&1; rc=$?
ok "A'3. a marker of a dead group: the slot is free (the command runs) and the marker is removed" '(( rc == 0 )) && [[ ! -e $S1.exec.$g3 ]]' "rc $rc, markers '$(markers)'; $(tail -3 $T/3.out)"

# A'2. EPERM: a marker naming a group of root (signal 0 only, it is never signalled) holds the slot
rg=$(ps -axo pgid=,uid= 2>/dev/null | awk '$2 == 0 && $1 > 1 { print $1; exit }')
if [[ -n $rg && $OSTYPE == darwin* ]]; then
  print -r -- $rg > $S1.exec.$rg
  tm 2 $H/heavy.sh touch $T/2.ran > $T/2.out 2>&1; rc=$?
  ok "A'2. a marker naming a group of root (EPERM) holds the slot: the waiter does not run" '(( rc == 124 )) && [[ ! -e $T/2.ran ]]' "rc $rc; $(tail -3 $T/2.out)"
  rm -f $S1.exec.$rg
fi
# A'2. EPERM on any system: a group whose only member is a zombie (its parent lives in another group and never reaps it)
perl -MPOSIX -e 'my $z = fork; if (!$z) { setpgrp(0,0); sleep 60; exit 0 }
  select(undef, undef, undef, 0.2);
  my $p = fork; if (!$p) { setpgrp(0,0); my $x = fork; if (!$x) { POSIX::setpgid(0, $z) or exit 9; exit 0 } sleep 60; exit 0 }
  select(undef, undef, undef, 0.3); kill 9, $z; waitpid($z, 0); print "$z $p\n"' > $T/2z.ids
z2=( $(<$T/2z.ids) ); GROUPS_MADE+=( $z2 )
ok "A'2. (setup) the zombie-only group reads EPERM" 'galive $z2[1] && ! kill -0 -- -$z2[1] 2>/dev/null' "ids '$z2'"
print -r -- $z2[1] > $S1.exec.$z2[1]
tm 2 $H/heavy.sh touch $T/2z.ran > $T/2z.out 2>&1; rc=$?
ok "A'2. a marker naming a group that reads EPERM holds the slot" '(( rc == 124 )) && [[ ! -e $T/2z.ran ]]' "rc $rc; $(tail -3 $T/2z.out)"
gkill $z2[2]; waitfor "! galive $z2[1]" 50
tm 10 $H/heavy.sh touch $T/2z.ran > $T/2z.out 2>&1; rc=$?
ok "A'2. ... the zombie reaped (ESRCH): the slot is free and the marker removed" '(( rc == 0 )) && [[ -e $T/2z.ran && ! -e $S1.exec.$z2[1] ]]' "rc $rc; $(tail -3 $T/2z.out)"

# A'4. a marker whose name does not end in a group number: busy, named in the waiting line
: > $S1.exec.abc
tm 2 $H/heavy.sh touch $T/4.ran > $T/4.out 2>&1; rc=$?
ok "A'4. an unreadable marker holds the slot and the waiting line names it" '(( rc == 124 )) && [[ ! -e $T/4.ran ]] && grep -q "unreadable exec marker heavy.1.lock.exec.abc" $T/4.out' "rc $rc; $(tail -3 $T/4.out)"
rm -f $S1.exec.abc

# A'6, A'7. slot-hold.sh: one "acquired" line, the slot held, "release" or EOF lets it go; journal kind hold
mkfifo $T/h.in
SLOT_LABEL="codex t1 prog id1" $H/slot-hold.sh heavy < $T/h.in > $T/h.out 2> $T/h.err & hp=$!; BG+=$hp
exec 7> $T/h.in
waitfor 'grep -q "^acquired " $T/h.out' 100
a6=( $(grep "^acquired " $T/h.out) )
ok "A'6. slot-hold.sh heavy: one line \"acquired <slot> <time>\" on stdout" '[[ $(grep -c "^acquired " $T/h.out) == 1 && $a6[2] == $S1 && $a6[3] == <->.<-> ]]' "$(cat $T/h.out $T/h.err)"
ok "A'6. ... the slot is held, the loop marked" 'busy $S1 && [[ -n $(markers) ]]' "markers '$(markers)'"
print -u7 -r -- release
bwait $hp 50; rc=$?
exec 7>&-
ok "A'7. \"release\": exit 0, the slot free and the loop's marker removed" '(( rc == 0 )) && ! busy $S1 && [[ -z $(markers) ]]' "rc $rc, markers '$(markers)'; $(cat $T/h.err)"
ok "A'7. ... one journal line kind hold with SLOT_LABEL" 'grep -q $'"'"'\thold\t[0-9]*\t0\t.*codex t1 prog id1$'"'"' $SLOT_JOURNAL' "$(tail -2 $SLOT_JOURNAL)"
$H/slot-hold.sh medium < $T/h.in > $T/h2.out 2>&1 & hp=$!; BG+=$hp
exec 7> $T/h.in
waitfor 'grep -q "^acquired " $T/h2.out' 100
ok "A'7. (setup) slot-hold.sh medium holds the medium slot" 'busy $M1' "$(cat $T/h2.out)"
exec 7>&-
bwait $hp 50; rc=$?
ok "A'7. EOF on stdin: exit 0, the slot free" '(( rc == 0 )) && ! busy $M1 && [[ -z $(markers) ]]' "rc $rc; $(cat $T/h2.out)"
tm 5 $H/slot-hold.sh large < /dev/null > $T/h3.out 2>&1; rc=$?
ok "A'6. slot-hold.sh with a class other than medium or heavy: 64" '(( rc == 64 ))' "rc $rc; $(cat $T/h3.out)"

# A'8. kill -9 of the holder while the command lives: the lock is gone, the marker keeps the slot until the command ends
$H/heavy.sh zsh -c 'print -r -- $$ > '$T'/8.c; sleep 30' > $T/8.out 2>&1 & w8=$!; BG+=$w8
waitfor '[[ -s $T/8.c ]]'; c8=$(<$T/8.c); GROUPS_MADE+=$c8
h8=$(holder_of $w8)
ok "A'8. (setup) the holder found" '[[ -n $h8 ]]' "children of $w8: $(pgrep -P $w8 | tr '\n' ' ')"
kill -9 $h8 2>/dev/null
bwait $w8 50; rc=$?
ok "A'8. kill -9 of the holder: heavy.sh returns 137" '(( rc == 137 ))' "rc $rc; $(tail -3 $T/8.out)"
ok "A'8. ... the lock is free, the command lives and its marker remains" '! busy $S1 && kill -0 $c8 2>/dev/null && [[ -e $S1.exec.$c8 ]]' "markers '$(markers)'"
rm -f $T/8.ran
$H/heavy.sh touch $T/8.ran > $T/8b.out 2>&1 & w8b=$!; BG+=$w8b
sleep 1.2
ok "A'8. ... a waiter does not get the slot while the command lives" '[[ ! -e $T/8.ran ]]' "$(tail -3 $T/8b.out)"
gkill $c8
bwait $w8b 50; rc=$?
ok "A'8. the command ended: the waiter runs and the marker is gone" '(( rc == 0 )) && [[ -e $T/8.ran && ! -e $S1.exec.$c8 ]]' "rc $rc; $(tail -3 $T/8b.out)"

# A'9. a waiter in the queue (SLOT_POLL=5) stops at once on TERM: 143, ticket gone, its pause (sleep) gone too
zsh -c 'zmodload zsh/system; : >> '$S1'; zsystem flock -f fd '$S1'; touch '$T'/9.held; sleep 30' & f9=$!; BG+=$f9
waitfor '[[ -e $T/9.held ]]'
for sig in TERM INT HUP; do
  SLOT_POLL=5 $H/heavy.sh true > $T/9.out 2>&1 & w9=$!; BG+=$w9
  waitfor '[[ -n $(print $SLOTS_DIR/queue/<->(N)) ]]' 50; sleep 0.6
  kids=( $(pgrep -P $w9) )
  t0=$EPOCHREALTIME; kill -$sig $w9
  bwait $w9 50; rc=$?; dt=$(( EPOCHREALTIME - t0 ))
  left=(); for k in $kids; do kill -0 $k 2>/dev/null && left+=$k; done
  ok "A'9. $sig to a waiter: exit 143 within 1 s, its ticket and its pause gone" '(( rc == 143 && dt < 1.0 )) && [[ -z $(print $SLOTS_DIR/queue/<->(N)) && -z $left ]]' "rc $rc in $dt s, left '$left'; $(tail -2 $T/9.out)"
done
ok "A'9. ... journal lines without a slot, rc 143" '(( $(grep -c $'"'"'\t-\t[0-9.]*\theavy\t-\tsingle\t[0-9]*\t143\t'"'"' $SLOT_JOURNAL) == 3 ))' "$(tail -3 $SLOT_JOURNAL)"
kill $f9; wait $f9 2>/dev/null

# A'10, A'14. inside a held slot CODIS_SLOT_HELD lets heavy.sh and medium.sh run without a ticket (no ps in a sandbox)
mkdir -p $T/nops; for t in ps pgrep; do print -r -- '#!/bin/sh
echo "'$t': Operation not permitted" >&2; exit 1' > $T/nops/$t; chmod +x $T/nops/$t; done
print -r -- 'export PATH='$T'/nops:$PATH
CODIS_SLOT_HELD="heavy $SLOT_PATH" '$H'/heavy.sh zsh -c '"'"'print -r -- "nested-heavy $SLOT_PATH"; exit 6'"'"'; print -r -- "rc1 $?"
CODIS_SLOT_HELD="heavy $SLOT_PATH" '$H'/medium.sh zsh -c '"'"'print -r -- nested-medium'"'"'; print -r -- "rc2 $?"' > $T/n10.zsh
n0=$(jline nested)
tm 15 $H/heavy.sh zsh $T/n10.zsh > $T/10.out 2>&1; rc=$?
ok "A'10. nested heavy.sh inside the held heavy slot: no second ticket, its code (6), SLOT_PATH the held slot" '(( rc == 0 )) && grep -q "nested-heavy $S1" $T/10.out && grep -q "^rc1 6$" $T/10.out' "rc $rc; $(cat $T/10.out)"
ok "A'10. nested medium.sh inside the held heavy slot runs" 'grep -q "^nested-medium" $T/10.out && grep -q "^rc2 0$" $T/10.out' "$(cat $T/10.out)"
ok "A'14. ... with ps and pgrep refused (the codex sandbox): the group comes from perl" '! grep -q "Operation not permitted" $T/10.out' "$(cat $T/10.out)"
ok "A'10. ... two journal lines kind nested" '(( $(jline nested) - n0 == 2 ))' "$(tail -3 $SLOT_JOURNAL)"

# A'11. held medium x heavy.sh: 64, class too small, not a queue
print -r -- 'CODIS_SLOT_HELD="medium $SLOT_PATH" '$H'/heavy.sh touch '$T'/11.ran; print -r -- "rc $?"' > $T/n11.zsh
tm 15 $H/medium.sh zsh $T/n11.zsh > $T/11.out 2>&1; rc=$?
ok "A'11. heavy.sh inside a held medium slot: 64, the command not run" '(( rc == 0 )) && grep -q "^rc 64$" $T/11.out && [[ ! -e $T/11.ran ]] && grep -q "class" $T/11.out' "rc $rc; $(cat $T/11.out)"

# A'12. CODIS_SLOT_HELD naming a slot of my directory without a marker of my group: 64, not a queue
CODIS_SLOT_HELD="heavy $S1" tm 5 $H/heavy.sh touch $T/12.ran > $T/12.out 2>&1; rc=$?
ok "A'12. CODIS_SLOT_HELD without a marker of my group: 64 at once, the command not run" '(( rc == 64 )) && [[ ! -e $T/12.ran ]]' "rc $rc; $(cat $T/12.out)"

# A'13. CODIS_SLOT_HELD naming a slot of another directory: not mine, the ordinary queue of my directory
s0=$(jline single)
CODIS_SLOT_HELD="heavy $T/other/heavy.1.lock" tm 10 $H/heavy.sh touch $T/13.ran > $T/13.out 2>&1; rc=$?
ok "A'13. CODIS_SLOT_HELD of another slot directory: an ordinary run in my queue" '(( rc == 0 )) && [[ -e $T/13.ran ]] && (( $(jline single) - s0 == 1 ))' "rc $rc; $(cat $T/13.out)"

# A'15. slot-journal.js: kinds hold and nested are read; nested adds no hold of its own
node -e '
const J = require(process.argv[1]);
const t = ["v1\t100\t100\t110\theavy\t1\thold\t1\t0\t/w\tcodex t prog id", "v1\t102\t102\t105\theavy\t1\tnested\t2\t0\t/w\tnode x"].join("\n");
const { records, bad } = J.parse(t);
const s = J.summarize(records);
const okk = bad === 0 && records.length === 2 && s.all.holdTotal === 10 && s.nested && s.nested.n === 1 && /nested/.test(J.format(s, "j"));
console.log(JSON.stringify({ bad, n: records.length, hold: s.all.holdTotal, nested: s.nested }));
process.exit(okk ? 0 : 1)' $H/slot-journal.js > $T/15.out 2>&1; rc=$?
ok "A'15. slot-journal.js reads kinds hold and nested; nested is apart, not added to the hold" '(( rc == 0 ))' "$(cat $T/15.out)"

# A'17. a normal end with leftovers: TERM to the group, the code of the command (3); a stubborn leftover - KILL later
t0=$EPOCHREALTIME
tm 20 $H/heavy.sh zsh -c 'sleep 30 & print -r -- $! > '$T'/17.bg; exit 3' > $T/17.out 2>&1; rc=$?; dt=$(( EPOCHREALTIME - t0 ))
ok "A'17. leftovers in the group after a normal end: stopped, the command's code (3), marker gone, at once" '(( rc == 3 && dt < 1.9 )) && ! kill -0 $(<$T/17.bg) 2>/dev/null && [[ -z $(markers) ]]' "rc $rc in $dt s, markers '$(markers)'; $(tail -3 $T/17.out)"
t0=$EPOCHREALTIME
$H/heavy.sh zsh -c '( trap "" TERM; sleep 30 ) & print -r -- $! > '$T'/17s.bg; exit 3' > $T/17s.out 2>&1 & w17=$!; BG+=$w17
waitfor '[[ -s $T/17s.bg ]]'; sleep 1
ok "A'17. a leftover that ignores TERM: the slot stays held during the pause" 'busy $S1 && kill -0 $w17 2>/dev/null' "$(tail -3 $T/17s.out)"
bwait $w17 80; rc=$?; dt=$(( EPOCHREALTIME - t0 ))
ok "A'17. ... KILL after SLOT_KILL_GRACE: code 3, leftover gone, slot free" '(( rc == 3 && dt >= 2 )) && ! kill -0 $(<$T/17s.bg) 2>/dev/null && ! busy $S1 && [[ -z $(markers) ]]' "rc $rc in $dt s; $(tail -3 $T/17s.out)"

# A'18, A'19. a stubborn command (leader and child ignore TERM; a sibling records the TERM): a signal to heavy.sh or to
# its group - the group gets TERM at once, heavy.sh lives until the group is gone (KILL after the pause), exit 143;
# a waiter gets the slot only after the group is gone; nothing of the group is left
print -r -- 'zsh -c '"'"'trap "print -r -- term > '$T'/18.term; exit 0" TERM; while :; do sleep 0.1; done'"'"' &
print -r -- $! > '$T'/18.sib
( trap "" TERM; sleep 60 ) &
print -r -- $! > '$T'/18.kid
trap "" TERM
print -r -- $$ > '$T'/18.c
while :; do sleep 0.2; done' > $T/s18.zsh
s18() { # s18 <name> <how: TERM|INT|HUP|group> [second]
  rm -f $T/18.term $T/18.c $T/18.ran
  lead $H/heavy.sh zsh $T/s18.zsh > $T/18.out 2>&1 & local w=$!; BG+=$w; GROUPS_MADE+=$w
  waitfor '[[ -s $T/18.c ]]'; local c=$(<$T/18.c) sib=$(<$T/18.sib) kid=$(<$T/18.kid); GROUPS_MADE+=$c
  $H/heavy.sh touch $T/18.ran > $T/18w.out 2>&1 & local ww=$!; BG+=$ww
  sleep 0.3
  local t0=$EPOCHREALTIME
  if [[ $2 == group ]]; then [[ $w == <2-> ]] && kill -TERM -- -$w; else kill -$2 $w; fi
  waitfor '[[ -e $T/18.term ]]' 10
  ok "A'18. $1: the command's group got TERM at once" '[[ -e $T/18.term ]]'
  [[ -n $3 ]] && { sleep 0.5; kill -TERM $w 2>/dev/null; }
  sleep 1
  ok "A'18. $1: heavy.sh lives while the group lives, the slot held, the waiter waits" 'kill -0 $w 2>/dev/null && busy $S1 && [[ ! -e $T/18.ran ]]' "$(tail -2 $T/18.out)"
  bwait $w 80; local rc=$? dt=$(( EPOCHREALTIME - t0 ))
  ok "A'18. $1: KILL after SLOT_KILL_GRACE, heavy.sh exits 143 after the group is gone" '(( rc == 143 && dt >= 2 )) && ! galive $c' "rc $rc in $dt s; $(tail -2 $T/18.out)"
  ok "A'18. $1: nothing of the group left (leader, stubborn child, sibling), marker gone" '! kill -0 $c 2>/dev/null && ! kill -0 $kid 2>/dev/null && ! kill -0 $sib 2>/dev/null && [[ ! -e $S1.exec.$c ]]' "$(ps -o pid,pgid,ppid,stat,command -p $c,$kid,$sib 2>/dev/null)"
  bwait $ww 50
  ok "A'18. $1: the waiter got the slot after that" '[[ -e $T/18.ran ]]' "$(tail -2 $T/18w.out)"
}
s18 'TERM to heavy.sh' TERM
s18 'INT to heavy.sh' INT
s18 'HUP to heavy.sh' HUP
s18 'TERM to the group of heavy.sh (wait-step.js)' group
s18 "A'19 a second TERM in the pause" TERM second

# A'20. the group is not empty after KILL (its only member a zombie whose parent lives in another group): the holder
# says so and leaves, the marker stays and holds the slot until the group is gone
print -r -- 'perl -MPOSIX -e '"'"'my $c = getpgrp; my $p = fork; if (!$p) { setpgrp(0,0); my $x = fork; if (!$x) { POSIX::setpgid(0, $c) or exit 9; exit 0 }
  open my $f, ">", "'$T'/20.p"; print $f "$$\n"; close $f; sleep 60; exit 0 } select(undef, undef, undef, 0.5); exit 0'"'"'
print -r -- $$ > '$T'/20.c' > $T/s20.zsh
t0=$EPOCHREALTIME
tm 20 $H/heavy.sh zsh $T/s20.zsh > $T/20.out 2>&1; rc=$?; dt=$(( EPOCHREALTIME - t0 ))
c20=$(<$T/20.c 2>/dev/null); p20=$(<$T/20.p 2>/dev/null); GROUPS_MADE+=( $c20 $p20 )
ok "A'20. the group not empty after KILL: heavy.sh ends after both pauses, with the command's code, and says so" '(( rc == 0 && dt >= 4 )) && grep -q "not empty after KILL" $T/20.out' "rc $rc in $dt s; $(tail -3 $T/20.out)"
ok "A'20. ... the marker stays: the slot is busy with a free lock" '[[ -e $S1.exec.$c20 ]] && ! busy $S1' "markers '$(markers)'"
tm 2 $H/heavy.sh touch $T/20.ran > $T/20w.out 2>&1; rc=$?
ok "A'20. ... a waiter does not get it" '(( rc == 124 )) && [[ ! -e $T/20.ran ]]' "rc $rc; $(tail -2 $T/20w.out)"
gkill $p20; waitfor "! galive ${c20:-0}" 50
tm 10 $H/heavy.sh touch $T/20.ran > $T/20w.out 2>&1; rc=$?
ok "A'20. the group gone: the next waiter takes the slot and removes the marker" '(( rc == 0 )) && [[ -e $T/20.ran && ! -e $S1.exec.$c20 ]]' "rc $rc; $(tail -2 $T/20w.out)"

# A'21. KILL to the group of heavy.sh (no TERM before it): heavy.sh is gone, the command runs on in its slot (lock and
# marker) to its end, then the slot is free
rm -f $T/21.done $T/21.c
lead $H/heavy.sh zsh -c 'print -r -- $$ > '$T'/21.c; sleep 2; touch '$T'/21.done' > $T/21.out 2>&1 & w21=$!; BG+=$w21; GROUPS_MADE+=$w21
waitfor '[[ -s $T/21.c ]]'; c21=$(<$T/21.c); GROUPS_MADE+=$c21
gkill $w21; wait $w21 2>/dev/null
sleep 0.3
ok "A'21. KILL to the group of heavy.sh: the command lives on in its slot (lock and marker)" 'kill -0 $c21 2>/dev/null && busy $S1 && [[ -e $S1.exec.$c21 ]]' "markers '$(markers)'"
waitfor '[[ -e $T/21.done ]]' 50; waitfor '! busy $S1' 30
ok "A'21. ... it ends by itself, then the slot is free and the marker gone" '[[ -e $T/21.done ]] && ! busy $S1 && [[ ! -e $S1.exec.$c21 ]]' "markers '$(markers)'"

# A'22. the stop of the Bash tool: TERM to every process of the tree, KILL to the same tree 1.5 s later
rm -f $T/18.c
lead $H/heavy.sh zsh $T/s18.zsh > $T/22.out 2>&1 & w22=$!; BG+=$w22; GROUPS_MADE+=$w22
waitfor '[[ -s $T/18.c ]]'; c22=$(<$T/18.c); GROUPS_MADE+=$c22
tree=( $(_tree $w22) )
for p in $tree; do kill -TERM $p 2>/dev/null; done
sleep 1.5
for p in $tree; do kill -KILL $p 2>/dev/null; done
wait $w22 2>/dev/null
waitfor "! galive $c22" 30
ok "A'22. the Bash tool's stop: nothing of the tree is left" '! galive $c22' "$(ps -o pid,pgid,ppid,stat,command -g $c22 2>/dev/null)"
tm 10 $H/heavy.sh touch $T/22.ran > $T/22w.out 2>&1; rc=$?
ok "A'22. ... the next waiter takes the slot" '(( rc == 0 )) && [[ -e $T/22.ran && -z $(markers) ]]' "rc $rc, markers '$(markers)'; $(tail -2 $T/22w.out)"

# A'24. TL-note: guards-all.sh started with SLOT_EXEC_NOTE=<lock>/exec notes the group of its command there; the
# command does not inherit the note; the train lock lives while that group lives, after the dispatcher and
# guards-all.sh are KILLed
mkdir -p $T/lock
print -r -- '#!/bin/zsh
print -r -- $$ > '$T'/24.c; print -r -- "${SLOT_EXEC_NOTE:-none}" > '$T'/24.env; sleep 30' > $T/wts/xo/g.sh; chmod +x $T/wts/xo/g.sh
env SLOT_EXEC_NOTE=$T/lock/exec perl -e 'setpgrp(0,0) or die; exec { $ARGV[0] } @ARGV or die' $H/guards-all.sh --force xo > $T/24.out 2>&1 & w24=$!; BG+=$w24; GROUPS_MADE+=$w24
waitfor '[[ -s $T/24.c ]]' 150
c24=$(<$T/24.c); g24=$(ps -o pgid= -p ${c24:-0} | tr -d ' '); GROUPS_MADE+=$g24
ok "A'24. guards-all.sh with SLOT_EXEC_NOTE: the group of its command is noted in <lock>/exec" '[[ -n $g24 ]] && grep -qx "$g24" $T/lock/exec' "group '$g24', note '$(cat $T/lock/exec 2>/dev/null)'; $(tail -3 $T/24.out)"
ok "A'24. ... the command does not inherit SLOT_EXEC_NOTE" '[[ $(<$T/24.env) == none ]]' "$(cat $T/24.env)"
gkill $w24; wait $w24 2>/dev/null
ta() { node -e 'const TL = require(process.argv[1]); process.exit(TL.holderAlive({ pid: Number(process.argv[3]), pgid: Number(process.argv[3]) }, process.argv[2]) ? 0 : 1)' $H/train-lock.js $T/lock $w24 }
ok "A'24. guards-all.sh and its caller KILLed: the train lock lives while the noted group lives" 'kill -0 $c24 2>/dev/null && ta'
gkill $g24; waitfor "! galive $g24" 50
ok "A'24. ... and is dead once that group is gone" '! ta'
waitfor '! busy $S1' 50

# A'26. a command that cannot run: 127 (not found) / 126 (not executable) as zsh gives, marker gone
tm 10 $H/heavy.sh $T/no-such-command > $T/26.out 2>&1; rc=$?
ok "A'26. a command not found: 127, no marker left" '(( rc == 127 )) && [[ -z $(markers) ]]' "rc $rc; $(cat $T/26.out)"
print -r -- 'true' > $T/noexec
tm 10 $H/heavy.sh $T/noexec > $T/26b.out 2>&1; rc=$?
ok "A'26. a command not executable: 126" '(( rc == 126 ))' "rc $rc; $(cat $T/26b.out)"

# A'27. sourcing slots.zsh without perl: refused with one line naming it, code 72, the command never runs
d=$T/no-perl; mkdir -p $d
for p in $path; do for f in $p/*(N*); do [[ -e $d/${f:t} || ${f:t} == perl* ]] || ln -s $f $d/${f:t}; done; done
PATH=$d tm 20 $H/heavy.sh touch $T/27.ran > $T/27.out 2> $T/27.err; rc=$?
ok "A'27. no perl: heavy.sh refused with 72, one line naming perl, the command not run" '(( rc == 72 )) && [[ ! -e $T/27.ran && $(wc -l < $T/27.err | tr -d " ") == 1 ]] && grep -q perl $T/27.err' "rc $rc; $(cat $T/27.err)"

# A'29. the pauses default to the pause of the roles (role-exec.js KILL_GRACE_MS / 1000)
node -e 'const fs = require("fs"); const s = fs.readFileSync(process.argv[1] + "/slots.zsh", "utf8"); const k = require(process.argv[1] + "/role-exec.js").KILL_GRACE_MS / 1000;
const g = /^: \$\{SLOT_KILL_GRACE:=(\d+)\}/m.exec(s), e = /^: \$\{SLOT_EMPTY_WAIT:=(\d+)\}/m.exec(s);
console.log(k, g && g[1], e && e[1]); process.exit(g && e && Number(g[1]) === k && Number(e[1]) === k ? 0 : 1)' $H > $T/29.out 2>&1; rc=$?
ok "A'29. SLOT_KILL_GRACE and SLOT_EMPTY_WAIT default to KILL_GRACE_MS of the roles (30 s)" '(( rc == 0 ))' "$(cat $T/29.out)"

print -r -- "slots-exec: $pass ok, $fail failed"
(( fail == 0 ))
