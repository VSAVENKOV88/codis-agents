#!/bin/zsh
# Tester checks of the slot locks without lockf(1) (task U1a), on a TEMPORARY slot directory and a fake machine.
# Run by tests/slots-u1a.test.js (macOS and Linux). Exit code 0 - holds.
# Cases (cells of the U1a matrix the programmer's tests do not reach):
#   A3. kill -9 of a holder while another heavy.sh WAITS for that slot: the waiter takes it and runs its command;
#   A8. reverse direction of the exclusive lock: while an exclusive guard runs under heavy.sh, a flock(2) probe of the
#       project runner (lockf -t 0 on macOS, flock -n on Linux) sees the lock busy; free again after the guard;
#   A1. the command's standard input passes through the holder (`print x | heavy.sh cat`), heavy and medium;
#   A9. the command's own exit code 75 is not "lost the race": it passes through and the command runs exactly once;
#   C1. no temporary file (TMPDIR does not exist): heavy.sh refuses with one line and code 73, does not loop, the
#       command does not run.
#   E77. locks of the slot directory this user cannot write (left by sudo) beyond the programmer's case 11: a heavy
#       slot file (heavy.sh), the queue directory, the legacy lock - refusal 77, the command does not run; the refusal
#       is journaled with code 77; a refusal while waiting leaves no queue ticket and no temporary file, and the next
#       job behind it still gets the slot; a .who file left unwritable is not a lock - the job runs.
H=${SLOTS_H:-${0:A:h:h:h:h}/scripts}
zmodload zsh/datetime zsh/system
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-u1a.XXXXXX"); T=${T:A}
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK= SLOT_POLL=0.2 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
# hermetic inside an outer slot (heavy.sh node tests/run.js): drop what the outer slots.zsh exported
# The thresholds are dropped too (README: SLOT_SWAP_MIN_MB=0 on Linux): the cases rely on the defaults on the fake machine.
unset GUARDS_EXCLUSIVE_LOCK SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB
mkdir -p $T/shared $T/wts $T/g
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared"}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
# Fake machine: free 20 % (no extra heavy slot), plenty of swap (the same fake sources on macOS and Linux).
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
# bwait <pid> [tenths] - waits for a background job (default 10 s), then stops its tree: code 124
bwait() { waitfor "! kill -0 $1 2>/dev/null" ${2:-100}; kill -0 $1 2>/dev/null && { hard $1; wait $1 2>/dev/null; return 124; }; wait $1 }
trap 'touch $T/rel.ALL 2>/dev/null; stop $BG; rm -rf $T' EXIT
busy() { [[ -e $1 ]] || return 1; ( zsystem flock -t 0 -f _f $1 ) 2>/dev/null; (( $? == 1 )) }
# xbusy <file> - a flock(2) probe as the project runner takes the lock: 0 - busy
xbusy() { if [[ -x /usr/bin/lockf ]]; then /usr/bin/lockf -k -t 0 $1 true 2>/dev/null; (( $? == 75 ))
  else flock -n -E 75 $1 true 2>/dev/null; (( $? == 75 )); fi }

[[ -f $H/slots.zsh ]] || { print -r -- "  FAIL no $H/slots.zsh"; exit 1; }

# A3. one heavy slot (SLOT_HEAVY_N=1, free 20 %: no extra one); the first holds it, the second waits in the queue;
#     kill -9 of the first holder - the second takes the slot and runs
(
  export SLOT_HEAVY_N=1
  "$H/heavy.sh" zsh -c 'print -r -- $PPID > '$T'/a3.ppid; print -r -- $$ > '$T'/a3.cmd; print -r -- $SLOT_PATH > '$T'/a3.slot
    while [[ ! -e '$T'/rel.a3 && ! -e '$T'/rel.ALL ]]; do sleep 0.05; done' > $T/a3a.out 2>&1 & print -r -- $! > $T/a3a.pid
  waitfor "[[ -s $T/a3.slot ]]"
  "$H/heavy.sh" zsh -c 'print -r -- $SLOT_PATH > '$T'/a3b.slot' > $T/a3b.out 2>&1 & print -r -- $! > $T/a3b.pid
  wait
) & BG+=$!
waitfor '[[ -s $T/a3.slot && -s $T/a3b.pid ]]'
waitfor 'grep -q "waiting for slot heavy" $T/a3b.out' 50
ok 'A3. (setup) the second heavy.sh waits while the first holds the only heavy slot' 'grep -q "waiting for slot heavy" $T/a3b.out && [[ ! -s $T/a3b.slot ]]' "$(tail -2 $T/a3b.out)"
kill -9 $(<$T/a3.ppid) 2>/dev/null
BG+=$(<$T/a3a.pid) BG+=$(<$T/a3b.pid)
waitfor '[[ -s $T/a3b.slot ]]' 100
ok 'A3. kill -9 of the holder: the waiting heavy.sh takes the same slot and runs' '[[ -s $T/a3b.slot && $(<$T/a3b.slot) == $(<$T/a3.slot) ]]' "slot $(<$T/a3.slot 2>/dev/null) -> $(<$T/a3b.slot 2>/dev/null); $(tail -2 $T/a3b.out)"
ok 'A3. ... while the command left behind by the killed holder still lives' 'kill -0 $(<$T/a3.cmd) 2>/dev/null'
stop $(<$T/a3.cmd); bwait $(<$T/a3b.pid) >/dev/null 2>&1

# A8. reverse direction: an exclusive guard under heavy.sh holds a flock(2) lock that the project runner sees
print -r -- '// guards:exclusive — test: shares a fixed resource
const fs = require("fs"); fs.writeFileSync(process.argv[2] + "/a8.run", "");
const t = Date.now(); (function w() { if (fs.existsSync(process.argv[2] + "/rel.a8") || fs.existsSync(process.argv[2] + "/rel.ALL")) return; if (Date.now() - t > 15000) process.exit(3); setTimeout(w, 50); })();' > $T/g/x-run.js
"$H/heavy.sh" node $T/g/x-run.js $T > $T/a8.out 2>&1 & P=$!; BG+=$P
waitfor '[[ -e $T/a8.run ]]' 100
ok 'A8. (setup) the exclusive guard runs' '[[ -e $T/a8.run ]]' "$(tail -3 $T/a8.out)"
ok 'A8. while it runs, the runner'"'"'s flock(2) probe sees exclusive.lock busy' 'xbusy $SLOTS_DIR/exclusive.lock'
touch $T/rel.a8; bwait $P; rc=$?
ok 'A8. ... the guard ended (exit 0) and the lock is free for the runner' '(( rc == 0 )) && ! xbusy $SLOTS_DIR/exclusive.lock' "$rc $(tail -3 $T/a8.out)"

# A1. standard input passes through the holder to the command
out=$(print -r -- stdin-heavy | "$H/heavy.sh" cat 2>&1); rc=$?
ok 'A1. heavy.sh: the command reads the caller'"'"'s standard input' '(( rc == 0 )) && [[ $out == *stdin-heavy* ]]' "$rc '$out'"
out=$(print -r -- stdin-medium | "$H/medium.sh" cat 2>&1); rc=$?
ok 'A1. medium.sh: the command reads the caller'"'"'s standard input' '(( rc == 0 )) && [[ $out == *stdin-medium* ]]' "$rc '$out'"

# A9. the command's own code 75 is the command's, not a lost race
: > $T/a9.ran
"$H/heavy.sh" zsh -c 'print -r -- ran >> '$T'/a9.ran; exit 75' > $T/a9.out 2>&1 & P=$!; BG+=$P
bwait $P 100; rc=$?
ok 'A9. the command exits 75: heavy.sh returns 75 and the command ran exactly once' '(( rc == 75 )) && [[ $(wc -l < $T/a9.ran | tr -d " ") == 1 ]]' "rc $rc, runs $(wc -l < $T/a9.ran | tr -d ' '); $(tail -2 $T/a9.out)"

# C1. no temporary file: one refusal line, code 73, no endless wait, the command does not run
rm -f $T/c1.ran
TMPDIR=$T/no-such-dir "$H/heavy.sh" zsh -c 'touch '$T'/c1.ran' > $T/c1.out 2> $T/c1.err & P=$!; BG+=$P
bwait $P 100; rc=$?
ok 'C1. TMPDIR does not exist: heavy.sh refuses with code 73 and does not run the command' '(( rc == 73 )) && [[ ! -e $T/c1.ran ]]' "$rc $(tail -2 $T/c1.out; tail -2 $T/c1.err)"
ok 'C1. ... with one line naming the temporary directory' '[[ $(grep -c "temporary file" $T/c1.err) == 1 ]]' "$(cat $T/c1.err)"

# E77. unwritable locks (skipped for a user who writes read-only files: root)
e77() {  # e77 <name> <path to make unwritable> <dir> <script> [env...]: runs <script> on slot dir <dir>, sets rc
  local name=$1 bad=$2 d=$3 sc=$4; shift 4
  rm -f $T/e77.ran
  if [[ -d $bad ]]; then chmod 555 $bad; else : >> $bad; chmod 444 $bad; fi
  if [[ -w $bad ]]; then print -r -- "  note E77. $name: this user writes a read-only file (root) - nothing to refuse"; chmod 755 $bad 2>/dev/null; rc=skip; return; fi
  env "$@" SLOTS_DIR=$d TMPDIR=$T/tmp77 "$H/$sc" zsh -c 'touch '$T'/e77.ran' > $T/e77.out 2> $T/e77.err & local p=$!; BG+=$p
  bwait $p 100; rc=$?
  if [[ -d $bad ]]; then chmod 755 $bad; else chmod 644 $bad; fi
  ok "E77. $name not writable: $sc refused with code 77, the command did not run" '(( rc == 77 )) && [[ ! -e $T/e77.ran ]]' "$rc $(tail -2 $T/e77.out; tail -2 $T/e77.err)"
  ok "E77. $name: one stderr line naming the path" '[[ $(wc -l < $T/e77.err | tr -d " ") == 1 ]] && grep -qF -- "$bad " $T/e77.err' "$(cat $T/e77.err)"
}
mkdir -p $T/tmp77
d=$T/e77h; mkdir -p $d; e77 heavy.2.lock $d/heavy.2.lock $d heavy.sh SLOT_HEAVY_N=2
d=$T/e77q; mkdir -p $d/queue; e77 'queue directory' $d/queue $d medium.sh
d=$T/e77l; mkdir -p $d; e77 'legacy lock' $T/legacy77.lock $d medium.sh SLOT_LEGACY_LOCK=$T/legacy77.lock
[[ $rc == skip ]] || ok 'E77. the refusal is journaled with exit code 77' '[[ -s $d/journal.tsv ]] && awk -F"\t" "{print \$0}" $d/journal.tsv | grep -q "77"' "$(cat $d/journal.tsv 2>/dev/null)"
[[ $rc == skip ]] || ok 'E77. a refusal leaves no temporary file' '[[ -z $(ls -A $T/tmp77) ]]' "$(ls -A $T/tmp77)"
# a late refusal: the only medium slot held, a job waits with a ticket, its admit.lock turns unwritable -> 77; then the
# lock is writable again, the holder ends: the next job takes the slot (no ticket left in front of it)
d=$T/e77w; mkdir -p $d; rm -f $T/e77w.ran $T/e77n.ran
SLOTS_DIR=$d SLOT_MEDIUM_N=1 "$H/medium.sh" zsh -c 'while [[ ! -e '$T'/rel.e77 && ! -e '$T'/rel.ALL ]]; do sleep 0.05; done' > $T/e77h.out 2>&1 & PH=$!; BG+=$PH
waitfor '[[ -s $d/medium.1.lock.who ]]'
SLOTS_DIR=$d SLOT_MEDIUM_N=1 TMPDIR=$T/tmp77 "$H/medium.sh" zsh -c 'touch '$T'/e77w.ran' > $T/e77w.out 2> $T/e77w.err & PW=$!; BG+=$PW
waitfor 'grep -q "waiting for slot medium" $T/e77w.out' 100
chmod 444 $d/admit.lock
if [[ -w $d/admit.lock ]]; then print -r -- "  note E77. late: root - nothing to refuse"; chmod 644 $d/admit.lock; touch $T/rel.e77; bwait $PW >/dev/null; bwait $PH >/dev/null
else
  bwait $PW 100; rc=$?; chmod 644 $d/admit.lock
  ok 'E77. late refusal while waiting: code 77, the command did not run' '(( rc == 77 )) && [[ ! -e $T/e77w.ran ]]' "$rc $(tail -2 $T/e77w.err)"
  ok 'E77. ... no queue ticket and no temporary file left behind' '[[ -z $(ls -A $d/queue 2>/dev/null) && -z $(ls -A $T/tmp77) ]]' "queue: $(ls -A $d/queue) tmp: $(ls -A $T/tmp77)"
  SLOTS_DIR=$d SLOT_MEDIUM_N=1 "$H/medium.sh" zsh -c 'touch '$T'/e77n.ran' > $T/e77n.out 2>&1 & PN=$!; BG+=$PN
  waitfor 'grep -q "waiting for slot medium" $T/e77n.out' 100
  touch $T/rel.e77; bwait $PH >/dev/null; bwait $PN 100; rc=$?
  ok 'E77. ... the next job takes the slot once the holder ends' '(( rc == 0 )) && [[ -e $T/e77n.ran ]]' "$rc $(tail -3 $T/e77n.out)"
fi
# a .who file of a slot left unwritable is not a lock: the job still runs
d=$T/e77o; mkdir -p $d; : > $d/medium.1.lock.who; chmod 444 $d/medium.1.lock.who; rm -f $T/e77o.ran
SLOTS_DIR=$d SLOT_MEDIUM_N=1 "$H/medium.sh" zsh -c 'touch '$T'/e77o.ran' > $T/e77o.out 2>&1 & P=$!; BG+=$P
bwait $P 100; rc=$?; chmod 644 $d/medium.1.lock.who
ok 'E77. an unwritable .who of a slot is not a refusal: the job runs (exit 0)' '(( rc == 0 )) && [[ -e $T/e77o.ran ]]' "$rc $(tail -3 $T/e77o.out)"

print -r -- "
$pass passed, $fail failed"
(( fail == 0 ))
