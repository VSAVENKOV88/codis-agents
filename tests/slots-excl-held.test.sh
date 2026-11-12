#!/bin/zsh
# tests:quiet - slot queues and the exclusive lock polled every 0.2-1 s with timed waits; red under the load of other test files
# An exclusive guard whose heavy.sh runs under an exclusive lock already taken up the process (G30), on a TEMPORARY slot
# directory and a fake machine. Exit code 0 - holds.
#   usage: tests/slots-excl-held.test.sh   (SLOTS_H=<dir with slots.zsh/heavy.sh/...> - check other copies)
# slot_exclusive_run gives its command GUARDS_EXCLUSIVE_HELD="<lock path> <process group>"; heavy.sh of an exclusive
# guard whose own lock path and process group match it runs without a second lockf (the lock is a flock(2) lock: a
# second open in another process waits for the first one forever). Any other value takes the lock as before.
# The guard below reports whether the exclusive lock is held while it runs (flock(2) LOCK_NB through perl: 75 held).
# Cases (cells C0 of p-codex-A2b-1c): 1. (C0-1) a role of Claude: heavy.sh zsh heavy.sh node x-run.js - the inner
#           level runs under the outer lock: rc 0, the lock held while the guard runs, one journal line "exclusive", no
#           waiting; 3. (C0-3) GUARDS_EXCLUSIVE_HELD with the right path and a foreign process group, the lock held by
#           another holder: waits out loud, the guard runs only after the holder; 4. (C0-4) the own process group and
#           another lock path: the same; 6. (C0-6) the command left the group (a new group) and calls heavy.sh of the
#           exclusive guard: waits as before (README, Known gaps).
H=${SLOTS_H:-${0:A:h:h}/scripts}
zmodload zsh/datetime zsh/system
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-excl-held.XXXXXX"); T=${T:A}
# no machine file of the box, as under tests/run.js
export XDG_CONFIG_HOME=$T/no-xdg; unset CODIS_AGENTS_MACHINE
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK= SLOT_POLL=0.2 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
# Run inside an outer slot (heavy.sh node tests/run.js) the outer slots.zsh has exported its own lock, journal, counts
# and the held exclusive lock: without this the test would wait on (and write to) the real ones.
unset GUARDS_EXCLUSIVE_LOCK GUARDS_EXCLUSIVE_HELD SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_PRIORITY SLOT_KILL_GRACE SLOT_EMPTY_WAIT SLOT_EXEC_NOTE CODIS_SLOT_HELD SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_PROC GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
# the fake machine below is a macOS one, on Linux too: the readings follow SLOT_OS, not the box
export SLOT_OS=darwin
mkdir -p $T/wts/xo $T/shared $T/g
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared"}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
# Fake machine (as in slots-locks.test.sh): free 20 % (no extra heavy slot), plenty of swap.
mkdir -p $T/bin
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

pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
waitfor() { local i; for i in {1..${2:-100}}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
_tree() { local c; for c in $(pgrep -P $1 2>/dev/null); do _tree $c; done; print -r -- $1 }
typeset -a BG
stop() { local p i; for p; do for i in $(_tree $p); do kill $i 2>/dev/null; done; done }
hard() { local t=( $(_tree $1) ) i; stop $1; waitfor "! kill -0 $1 2>/dev/null" 20 || for i in $t; do kill -9 $i 2>/dev/null; done }
# tm <seconds> <command...> - runs the command, stops its tree after <seconds> (the defect waits forever): code 124
tm() { local s=$1 i p; shift; "$@" & p=$!; BG+=$p
  for i in {1..$(( s * 10 ))}; do kill -0 $p 2>/dev/null || break; sleep 0.1; done
  kill -0 $p 2>/dev/null && { hard $p; wait $p 2>/dev/null; return 124; }; wait $p }
# bwait <pid> - waits for a background job at most 20 s, then stops its tree: code 124
bwait() { waitfor "! kill -0 $1 2>/dev/null" 200; kill -0 $1 2>/dev/null && { hard $1; wait $1 2>/dev/null; return 124; }; wait $1 }
trap 'touch $T/rel.ALL 2>/dev/null; stop $BG; rm -rf $T' EXIT
# xhold <file> <name> - a flock(2) holder of <file> (lockf(1) where it exists, else flock(1)) until $T/rel.<name>
xhold() { local c=( zsh -c 'touch '$T'/$1.held; while [[ ! -e '$T'/rel.$1 && ! -e '$T'/rel.ALL ]]; do sleep 0.05; done' _ $2 )
  if [[ -x /usr/bin/lockf ]]; then /usr/bin/lockf -k $1 "${c[@]}" & else flock -o $1 "${c[@]}" & fi; BG+=$! }
excl_lines() { [[ -f $SLOTS_DIR/journal.tsv ]] || { print 0; return }; awk -F'\t' '$5 == "exclusive"' $SLOTS_DIR/journal.tsv | wc -l | tr -d ' ' }

[[ -f $H/slots.zsh ]] || { print -r -- "  FAIL no $H/slots.zsh"; exit 1; }
LOCK=$SLOTS_DIR/exclusive.lock
cat > $T/g/x-run.js <<'EOF'
// guards:exclusive — a fixed port in this test
const r = require('child_process').spawnSync('perl', ['-MFcntl=:flock', '-e',
  'open(my $f, "<", $ARGV[0]) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 75)', process.env.GUARDS_EXCLUSIVE_LOCK || '']);
require('fs').appendFileSync(process.argv[2], `ran held=${r.status} sp=${process.env.SLOT_PATH || ''}\n`);
EOF

# 1. (C0-1) a role of Claude: the outer heavy.sh takes the lock, the inner one of the same guard runs under it
tm 30 "$H/heavy.sh" zsh "$H/heavy.sh" node $T/g/x-run.js $T/1.out > $T/1.log 2>&1; rc=$?
ok '1. heavy.sh zsh heavy.sh node x-run.js (exclusive): rc 0, no wait for the lock it holds itself' '(( rc == 0 )) && ! grep -q "waiting for the exclusive lock" $T/1.log' "rc $rc: $(tail -3 $T/1.log)"
ok '1. ... the guard ran once, with the exclusive lock held (by the outer level)' '[[ $(grep -c "^ran held=75 " $T/1.out 2>/dev/null) == 1 ]]' "$(cat $T/1.out 2>/dev/null)"
ok '1. ... one journal line "exclusive" (no second lockf)' '[[ $(excl_lines) == 1 ]]' "$(cat $SLOTS_DIR/journal.tsv 2>/dev/null)"
ok '1. ... the lock is free afterwards' 'perl -MFcntl=:flock -e '"'"'open(my $f, "<", $ARGV[0]) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 75)'"'"' $LOCK'

# 3. (C0-3) the right lock path, a foreign process group (inherited from an outer shell): the lock is taken as before
perl $H/slot-group.pl lead sleep 60 & G3=$!; BG+=$G3
xhold $LOCK x3; waitfor '[[ -e $T/x3.held ]]'
GUARDS_EXCLUSIVE_HELD="$LOCK $G3" "$H/heavy.sh" node $T/g/x-run.js $T/3.out > $T/3.log 2>&1 & P=$!; BG+=$P
waitfor 'grep -q "waiting for the exclusive lock" $T/3.log' 100
ok '3. GUARDS_EXCLUSIVE_HELD with a foreign process group: waits out loud while another holder has the lock, the guard has not run' 'grep -q "waiting for the exclusive lock" $T/3.log && [[ ! -e $T/3.out ]]' "$(tail -3 $T/3.log; cat $T/3.out 2>/dev/null)"
touch $T/rel.x3; bwait $P; rc=$?
ok '3. ... runs once the holder is gone, under its own lock (rc 0, held)' '(( rc == 0 )) && grep -q "^ran held=75 " $T/3.out' "rc $rc: $(tail -3 $T/3.log; cat $T/3.out 2>/dev/null)"
stop $G3

# 4. (C0-4) the own process group, another lock path: the lock is taken as before
OWN=$(perl $H/slot-group.pl pgrp)
xhold $LOCK x4; waitfor '[[ -e $T/x4.held ]]'
GUARDS_EXCLUSIVE_HELD="$T/other.lock $OWN" "$H/heavy.sh" node $T/g/x-run.js $T/4.out > $T/4.log 2>&1 & P=$!; BG+=$P
waitfor 'grep -q "waiting for the exclusive lock" $T/4.log' 100
ok '4. GUARDS_EXCLUSIVE_HELD naming another lock path (own process group): waits out loud, the guard has not run' 'grep -q "waiting for the exclusive lock" $T/4.log && [[ ! -e $T/4.out ]]' "$(tail -3 $T/4.log; cat $T/4.out 2>/dev/null)"
touch $T/rel.x4; bwait $P; rc=$?
ok '4. ... runs once the holder is gone (rc 0, held)' '(( rc == 0 )) && grep -q "^ran held=75 " $T/4.out' "rc $rc: $(tail -3 $T/4.log; cat $T/4.out 2>/dev/null)"

# 5. the same group, no value, a held lock: waits (an empty GUARDS_EXCLUSIVE_HELD never matches)
xhold $LOCK x5; waitfor '[[ -e $T/x5.held ]]'
GUARDS_EXCLUSIVE_HELD= "$H/heavy.sh" node $T/g/x-run.js $T/5.out > $T/5.log 2>&1 & P=$!; BG+=$P
waitfor 'grep -q "waiting for the exclusive lock" $T/5.log' 100
ok '5. an empty GUARDS_EXCLUSIVE_HELD: waits out loud, the guard has not run' 'grep -q "waiting for the exclusive lock" $T/5.log && [[ ! -e $T/5.out ]]' "$(tail -3 $T/5.log)"
touch $T/rel.x5; bwait $P

# 6. (C0-6) under the outer lock the command leaves the process group and calls heavy.sh of the exclusive guard: it
# waits as before (the bypass is bound to the process group; README, Known gaps)
tm 6 "$H/heavy.sh" perl $H/slot-group.pl lead zsh "$H/heavy.sh" node $T/g/x-run.js $T/6.out > $T/6.log 2>&1; rc=$?
ok '6. a command in a new process group under the outer lock: the inner heavy.sh waits for the lock (stopped after 6 s), the guard has not run' '(( rc == 124 )) && grep -q "waiting for the exclusive lock" $T/6.log && [[ ! -e $T/6.out ]]' "rc $rc: $(tail -3 $T/6.log)"

print -r -- "
$pass passed, $fail failed"
(( fail == 0 ))
