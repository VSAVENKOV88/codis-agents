#!/bin/zsh
# Slot locks without lockf(1) (macOS and Linux) on a TEMPORARY slot directory and a fake machine. Exit code 0 - holds.
#   usage: tests/slots-locks.test.sh   (SLOTS_H=<dir with slots.zsh/heavy.sh/...> - check other copies)
# The slot holder is a small zsh that takes `zsystem flock` (fcntl) on the slot file, runs the command as its CHILD,
# waits for it and exits with its code. The exclusive lock (exclusive.lock) is a flock(2) lock by contract - the
# project's own runner takes it with lockf(1) on macOS or flock(1) on Linux - so slot_exclusive_run takes it with one
# of those utilities too (SLOT_EXCL_TOOLS, first found); with none - one refusal line, code 72.
# Cases: 1. the holder is a waiting zsh, the command its child; the slot is held while the command runs; the code
#           passes through (7); 2. the command opening and closing its own slot file does not drop the slot;
#        3. kill -9 of the holder frees the slot, the command left behind does not hold it; 4. a holder that loses the
#           race for the file exits 75 WITHOUT running the command, slot_run says so and queues again, the command runs
#           once later; 5. GNU mktemp (templates need XXX) - heavy.sh, medium.sh, an exclusive guard and guards-all.sh
#           work; 6. no ps or no pgrep - sourcing slots.zsh is refused with one line and code 72, the command never
#           runs; 7. no flock(2) utility - an exclusive guard is refused with one line and code 72; 8. the flock(1) form
#           (-o -w <s> -E 75) waits out loud while lockf(1) holds the lock, then runs; 9. no lockf in the slot holder or
#           the busy probe, and no slot test skips for a missing lockf; 10. (macOS) an old lockf(1) holder of a slot
#           counts as busy for the new probe.
H=${SLOTS_H:-${0:A:h:h}/scripts}
zmodload zsh/datetime zsh/system
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-locks.XXXXXX"); T=${T:A}
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK= SLOT_POLL=0.2 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
# Run inside an outer slot (heavy.sh node tests/run.js) the outer slots.zsh has exported its own lock, journal and
# counts: without this the test would wait on (and write to) the real ones.
unset GUARDS_EXCLUSIVE_LOCK SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC
mkdir -p $T/wts/xo $T/shared $T/g
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared",
  "guardCommand": "cd {wt} && ./g.sh {jobs}"}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
print -r -- '#!/bin/sh
echo "fake guards $1"' > $T/wts/xo/g.sh; chmod +x $T/wts/xo/g.sh
# Fake machine (as in slots-check.test.sh): free 20 % (no extra heavy slot), plenty of swap.
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
# hard <pid> - TERM to the tree; whatever still lives after 2 s gets KILL (slot_run ignores TERM that lands while a
# holder that lost the race is being reaped - a mutant losing every race would otherwise outlive the test)
hard() { local t=( $(_tree $1) ) i; stop $1; waitfor "! kill -0 $1 2>/dev/null" 20 || for i in $t; do kill -9 $i 2>/dev/null; done }
# tm <seconds> <command...> - runs the command, stops its tree after <seconds> (a mutant may loop forever): code 124
tm() { local s=$1 i p; shift; "$@" & p=$!; BG+=$p
  for i in {1..$(( s * 10 ))}; do kill -0 $p 2>/dev/null || break; sleep 0.1; done
  kill -0 $p 2>/dev/null && { hard $p; wait $p 2>/dev/null; return 124; }; wait $p }
# bwait <pid> - waits for a background job at most 10 s, then stops its tree: code 124
bwait() { waitfor "! kill -0 $1 2>/dev/null" 100; kill -0 $1 2>/dev/null && { hard $1; wait $1 2>/dev/null; return 124; }; wait $1 }
trap 'touch $T/rel.ALL 2>/dev/null; stop $BG; rm -rf $T' EXIT
# busy <file> - an fcntl probe from its own process (the type the slot holder takes): 0 - busy
busy() { [[ -e $1 ]] || return 1; ( zsystem flock -t 0 -f _f $1 ) 2>/dev/null; (( $? == 1 )) }
# fhold <file> <name> - an fcntl holder of <file> until $T/rel.<name>
fhold() { : >> $1; zsh -c 'zmodload zsh/system; zsystem flock -t 5 -f _l "$1" || exit 9; touch '$T'/$2.held
  while [[ ! -e '$T'/rel.$2 && ! -e '$T'/rel.ALL ]]; do sleep 0.05; done' _ $1 $2 & BG+=$! }
# xhold <file> <name> - a flock(2) holder of <file> (lockf(1) where it exists, else flock(1)) until $T/rel.<name>
xhold() { local c=( zsh -c 'touch '$T'/$1.held; while [[ ! -e '$T'/rel.$1 && ! -e '$T'/rel.ALL ]]; do sleep 0.05; done' _ $2 )
  if [[ -x /usr/bin/lockf ]]; then /usr/bin/lockf -k $1 "${c[@]}" & else flock -o $1 "${c[@]}" & fi; BG+=$! }

[[ -f $H/slots.zsh ]] || { print -r -- "  FAIL no $H/slots.zsh"; exit 1; }

# 1. the holder is a waiting zsh with the command as its child; the slot is held; the code passes through
"$H/heavy.sh" zsh -c 'print -r -- $PPID > '$T'/1.ppid; print -r -- $SLOT_PATH > '$T'/1.slot
  while [[ ! -e '$T'/rel.1 && ! -e '$T'/rel.ALL ]]; do sleep 0.05; done; exit 7' > $T/1.out 2>&1 & P=$!; BG+=$P
waitfor '[[ -s $T/1.slot ]]'
pp=$(<$T/1.ppid 2>/dev/null); comm=$(ps -o comm= -p ${pp:-0} 2>/dev/null); comm=${${comm## #}:t}
ok '1. the command is a child of a zsh holder (not of lockf, not exec-ed in place of the holder)' '[[ $comm == zsh ]]' "parent ${pp}: '$comm'"
ok '1. the slot file is held while the command runs' 'busy $(<$T/1.slot)' "$(<$T/1.slot)"
touch $T/rel.1; bwait $P; rc=$?
ok '1. the command exit code passes through the holder (7)' '(( rc == 7 ))' "$rc $(<$T/1.out)"
ok '1. after the command the slot is free' '! busy $(<$T/1.slot)'

# 2. the command (in its own process) opens and closes its slot file - the slot stays held
"$H/heavy.sh" zsh -c ': < $SLOT_PATH; : >> $SLOT_PATH; exec 9<$SLOT_PATH; exec 9<&-; print -r -- $SLOT_PATH > '$T'/2.slot
  while [[ ! -e '$T'/rel.2 && ! -e '$T'/rel.ALL ]]; do sleep 0.05; done' > $T/2.out 2>&1 & P=$!; BG+=$P
waitfor '[[ -s $T/2.slot ]]'
ok '2. the command opened and closed its slot file - the slot is still held' 'busy $(<$T/2.slot)' "$(<$T/2.out)"
touch $T/rel.2; bwait $P

# 3. kill -9 of the holder: the slot is free, the command left behind does not hold it
"$H/heavy.sh" zsh -c 'print -r -- $PPID > '$T'/3.ppid; print -r -- $$ > '$T'/3.cmd; print -r -- $SLOT_PATH > '$T'/3.slot
  while [[ ! -e '$T'/rel.3 && ! -e '$T'/rel.ALL ]]; do sleep 0.05; done' > $T/3.out 2>&1 & P=$!; BG+=$P
waitfor '[[ -s $T/3.slot ]]'
s3=$(<$T/3.slot); c3=$(<$T/3.cmd)
ok '3. (setup) the slot is held' 'busy $s3'
kill -9 $(<$T/3.ppid); bwait $P 2>/dev/null
waitfor '! busy $s3' 30
ok '3. kill -9 of the holder - the slot is free' '! busy $s3'
ok '3. ... while the command it left behind is still alive (it does not hold the slot)' 'kill -0 $c3 2>/dev/null'
stop $c3

# 4. a holder that loses the race for the file exits 75 without running the command; slot_run queues again
: > $T/4.ran; fhold $SLOTS_DIR/heavy.1.lock r4; waitfor '[[ -e $T/r4.held ]]'
( SLOT_HEAVY_N=1; SLOT_SAY=0; source $H/slots.zsh; _slot_busy() { return 1 }   # every probe says "free": the race
  slot_run heavy zsh -c 'print -r -- ran >> '$T'/4.ran' ) > $T/4.out 2>&1 & P=$!; BG+=$P
waitfor 'grep -qs "was taken first" $T/4.out' 50
sleep 0.5
ok '4. the holder lost the race: slot_run says "was taken first" and does NOT run the command' 'grep -q "slot .*heavy.1.lock was taken first" $T/4.out && [[ ! -s $T/4.ran ]]' "ran: $(<$T/4.ran); $(tail -2 $T/4.out)"
touch $T/rel.r4
bwait $P; rc=$?
ok '4. ... the lock released - the command ran exactly once (exit 0)' '(( rc == 0 )) && [[ $(<$T/4.ran) == ran ]]' "$rc ran: $(<$T/4.ran)"

# 5. GNU mktemp: a template needs at least three X's at its end ("mktemp -t slotgot" fails there)
mkdir -p $T/gnu; print -r -- '#!/bin/zsh
t=${@[-1]}
[[ ${t:t} == *XXX ]] || { print -u2 "mktemp: too few X'"'"'s in template '"'"'$t'"'"'"; exit 1; }
exec /usr/bin/mktemp "$@"' > $T/gnu/mktemp; chmod +x $T/gnu/mktemp
print -r -- '// guards:exclusive — fixed port in this test
require("fs").writeFileSync("'$T'/5.excl", "1")' > $T/g/x-run.js
PATH=$T/gnu:$PATH tm 20 "$H/heavy.sh" zsh -c 'exit 4' > $T/5h.out 2>&1; rh=$?
PATH=$T/gnu:$PATH tm 20 "$H/medium.sh" zsh -c 'exit 5' > $T/5m.out 2>&1; rm=$?
PATH=$T/gnu:$PATH tm 20 "$H/heavy.sh" node $T/g/x-run.js > $T/5x.out 2>&1; rx=$?
PATH=$T/gnu:$PATH tm 30 "$H/guards-all.sh" --force xo > $T/5g.out 2>&1; rg=$?
ok '5. GNU mktemp: heavy.sh and medium.sh run and pass the code (4, 5)' '(( rh == 4 && rm == 5 )) && ! grep -q "too few" $T/5h.out $T/5m.out' "$rh $rm $(tail -3 $T/5h.out; tail -3 $T/5m.out)"
ok '5. GNU mktemp: an exclusive guard runs under the exclusive lock' '(( rx == 0 )) && [[ -e $T/5.excl ]] && ! grep -q "too few" $T/5x.out' "$rx $(tail -3 $T/5x.out)"
ok '5. GNU mktemp: guards-all.sh runs the runner and exits 0' '(( rg == 0 )) && grep -q "fake guards" $T/5g.out && ! grep -q "too few" $T/5g.out' "$rg $(tail -3 $T/5g.out)"

# 6. no ps or no pgrep: a refusal when slots.zsh is sourced (one line, code 72), never a silent cleaning of every ticket
for miss in 'ps pgrep' pgrep ps; do
  d=$T/no-${miss// /-}; mkdir -p $d
  for p in $path; do for f in $p/*(N*); do [[ -e $d/${f:t} || " $miss " == *" ${f:t} "* ]] || ln -s $f $d/${f:t}; done; done
  rm -f $T/6.ran
  PATH=$d tm 20 "$H/heavy.sh" zsh -c 'touch '$T'/6.ran' > $T/6.out 2> $T/6.err; rc=$?
  ok "6. no $miss: heavy.sh refused with code 72, the command did not run" '(( rc == 72 )) && [[ ! -e $T/6.ran ]]' "$rc $(tail -3 $T/6.out; tail -3 $T/6.err)"
  ok "6. no $miss: one line on stderr naming what is missing and what to install" '[[ $(wc -l < $T/6.err | tr -d " ") == 1 ]] && grep -q "${miss%% *}" $T/6.err && grep -q procps $T/6.err' "$(tail -3 $T/6.err)"
done

# 7. no flock(2) utility for the exclusive lock: one refusal line, code 72, the guard does not run
rm -f $T/5.excl
SLOT_EXCL_TOOLS="$T/none/lockf $T/none/flock" tm 20 "$H/heavy.sh" node $T/g/x-run.js > $T/7.out 2> $T/7.err; rc=$?
ok '7. no lockf(1)/flock(1): an exclusive guard is refused with code 72 and does not run' '(( rc == 72 )) && [[ ! -e $T/5.excl ]]' "$rc $(tail -3 $T/7.out; tail -3 $T/7.err)"
ok '7. ... one line naming the lock and the utilities' '[[ $(wc -l < $T/7.err | tr -d " ") == 1 ]] && grep -q "exclusive" $T/7.err && grep -q "flock" $T/7.err' "$(tail -3 $T/7.err)"
SLOT_EXCL_TOOLS="$T/none/x" tm 20 "$H/heavy.sh" zsh -c 'exit 0' > /dev/null 2>&1; rc=$?
ok '7. ... an ordinary heavy command does not need the utility (exit 0)' '(( rc == 0 ))' "$rc"

# 8. the flock(1) form: -o (the command does not inherit the lock) -w <SLOT_SAY> -E 75; waits out loud while lockf(1)
#    (the project runner on macOS) holds the lock. On macOS a shim turns it into lockf(1) (both are flock(2)).
if [[ -x /usr/bin/lockf ]]; then
  mkdir -p $T/xt; FL=$T/xt/flock
  print -r -- '#!/bin/zsh
print -r -- "$*" >> '$T'/flock.args
[[ $1 == -o && $2 == -w && $4 == -E && $5 == 75 ]] || { print -u2 "flock shim: unexpected arguments: $*"; exit 99; }
w=$3 f=$6; shift 6
exec /usr/bin/lockf -k -t $w $f "$@"' > $FL; chmod +x $FL
else FL=$(command -v flock); fi
rm -f $T/5.excl; xhold $SLOTS_DIR/exclusive.lock x8; waitfor '[[ -e $T/x8.held ]]'
SLOT_EXCL_TOOLS="$T/none/lockf $FL" "$H/heavy.sh" node $T/g/x-run.js > $T/8.out 2>&1 & P=$!; BG+=$P
waitfor 'grep -q "waiting for the exclusive lock" $T/8.out' 100
ok '8. flock(1) form: waits out loud while the runner holds the lock, the guard has not run' 'grep -q "waiting for the exclusive lock" $T/8.out && [[ ! -e $T/5.excl ]]' "$(tail -3 $T/8.out)"
touch $T/rel.x8; bwait $P; rc=$?
ok '8. ... and runs once the lock is free (exit 0)' '(( rc == 0 )) && [[ -e $T/5.excl ]]' "$rc $(tail -3 $T/8.out)"
[[ -x /usr/bin/lockf ]] && ok '8. ... called as flock -o -w <SLOT_SAY> -E 75 <lock> <command>' '[[ $(head -1 $T/flock.args) == "-o -w 1 -E 75 $SLOTS_DIR/exclusive.lock "* ]]' "$(head -1 $T/flock.args)"

# 9. no lockf in the slot holder or the busy probe; no slot test skips for a missing lockf
F9=$(zsh -c 'source "$1" >/dev/null 2>&1; functions slot_run _slot_busy' _ $H/slots.zsh)
ok '9. slot_run and _slot_busy do not use lockf' '[[ -n $F9 && $F9 != *lockf* ]]' "$(print -r -- $F9 | grep -n lockf)"
sk=$(grep -l 'lockf not found\|no /usr/bin/lockf' ${${0:A:h}/*.test.(sh|js):#${0:A}} 2>/dev/null)
ok '9. no slot test skips for a missing lockf' '[[ -z $sk ]]' "$sk"

# 10. macOS, a plugin version from before (lockf(1) holders) in the middle of a chain: its slot counts as busy for the
#     fcntl probe (on macOS fcntl and flock(2) locks see each other), a new holder takes another slot
if [[ -x /usr/bin/lockf ]]; then
  : > $T/10.slot; xhold $SLOTS_DIR/heavy.1.lock old10; waitfor '[[ -e $T/old10.held ]]'
  tm 20 "$H/heavy.sh" zsh -c 'print -r -- $SLOT_PATH > '$T'/10.slot' > $T/10.out 2>&1; rc=$?
  ok '10. an old lockf(1) holder of heavy.1 is seen busy: the new holder took heavy.2' '(( rc == 0 )) && [[ $(<$T/10.slot) == */heavy.2.lock ]]' "$rc $(<$T/10.slot) $(tail -2 $T/10.out)"
  touch $T/rel.old10
fi

print -r -- "
$pass passed, $fail failed"
(( fail == 0 ))
