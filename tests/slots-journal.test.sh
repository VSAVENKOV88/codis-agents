#!/bin/zsh
# The slot journal (slots.zsh: one line per slot hold) on a TEMPORARY slot directory and a fake machine.
# Exit code 0 - everything holds.
#   usage: tests/slots-journal.test.sh   (SLOTS_H=<dir with slots.zsh/heavy.sh/...> - check other copies)
# Cases: 1. a hold writes one v1 line: 11 fields, times in order, class, slot number, kind, pid, rc, worktree, command;
#        2. a waiter behind busy slots: queue wait = acquire - request covers the wait, hold covers the command;
#        3. the command is short and secret-free: environment and --key=value masked, long words cut, at most 6 words;
#        4. a journal that cannot be written (a directory, a missing directory, a read-only file) never fails or stalls
#           the slot: the command runs, its exit code comes back, nothing on stderr; SLOT_JOURNAL='' - no journal;
#        5. an exclusive guard: a heavy record and an exclusive record; 6. killed while queueing: acquire "-", rc 143;
#        7. a full run (guards-all.sh) is labelled "guards-all <worktree>", kind full; 8. slot-journal.js reads the lines
#           the shell wrote and its queue / hold numbers match.
H=${SLOTS_H:-${0:A:h:h}/scripts}
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-journal.XXXXXX"); T=${T:A}
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK=$T/guards.lock SLOT_POLL=0.2 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
unset SLOT_JOURNAL SLOT_LABEL SLOT_KIND SLOT_RETRY_RC
J=$SLOTS_DIR/journal.tsv
mkdir -p $T/wts/xo/srv/tools $T/shared $T/repo/sub
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared",
  "guardCommand": "cd {wt}/srv && npm run guards -- --all --concurrency {jobs}"}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
: > $T/repo/.git; : > $T/wts/xo/.git
# Fake machine: free 20 % (no extra heavy slot), plenty of swap.
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
print -r -- '#!/bin/zsh
print -r -- "fake guards"; sleep 0.3' > $T/bin/npm
chmod +x $T/bin/*; export PATH=$T/bin:$PATH

pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
waitfor() { local i; for i in {1..${2:-100}}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
_tree() { local c; for c in $(pgrep -P $1 2>/dev/null); do _tree $c; done; print -r -- $1 }
typeset -a BG
trap 'touch $T/rel 2>/dev/null; for p in $BG; do for i in $(_tree $p); do kill $i 2>/dev/null; done; done; rm -rf $T' EXIT
# field <line> <n> - the n-th tab-separated field
field() { print -r -- "${${(ps:\t:)1}[$2]}" }
lines() { [[ -s $J ]] && wc -l < $J | tr -d ' ' || print 0 }
last() { tail -1 $J }

[[ -f $H/slots.zsh ]] || { print -r -- "  FAIL no $H/slots.zsh"; exit 1; }

# 1. one hold - one line
cd $T/repo/sub
"$H/medium.sh" zsh -c 'sleep 0.3; exit 3' > $T/1.out 2>&1; rc=$?
cd $T
ok '1. the command exit code comes back through the slot (3)' '(( rc == 3 ))' "$rc $(<$T/1.out)"
ok '1. one line in the journal' '[[ $(lines) == 1 ]]' "$(cat $J 2>&1)"
L=$(last); F=( "${(@ps:\t:)L}" )
ok '1. 11 tab-separated fields, version v1' '(( $#F == 11 )) && [[ $F[1] == v1 ]]' "$L"
ok '1. request <= acquire <= release, epoch seconds with milliseconds' \
  '[[ $F[2] == <->.<-> && $F[3] == <->.<-> && $F[4] == <->.<-> ]] && (( F[2] <= F[3] && F[3] <= F[4] ))' "$L"
ok '1. hold covers the command (>= 0.25 s)' '(( F[4] - F[3] >= 0.25 ))' "$L"
ok '1. class medium, slot 1, kind single, a pid, rc 3' '[[ $F[5] == medium && $F[6] == 1 && $F[7] == single && $F[8] == <-> && $F[9] == 3 ]]' "$L"
ok '1. worktree = the nearest directory with .git above the working directory' '[[ $F[10] == $T/repo ]]' "$F[10]"
ok '1. command recorded' '[[ $F[11] == "zsh -c sleep 0.3; exit 3" ]]' "$F[11]"

# 2. queue wait: both medium slots held, a third waits ~1.2 s
: > $J
for n in a b; do "$H/medium.sh" zsh -c 'touch '$T'/$1.start; while [[ ! -e '$T'/rel ]]; do sleep 0.05; done' _ $n > /dev/null 2>&1 & BG+=$!; done
waitfor '[[ -e $T/a.start && -e $T/b.start ]]'
"$H/medium.sh" sleep 0.2 > $T/2.out 2>&1 & w=$!; BG+=$w
sleep 1.2; touch $T/rel; wait $w; wait
L=$(grep $'\tsleep 0.2$' $J); F=( "${(@ps:\t:)L}" )
ok '2. three lines (two holders and the waiter)' '[[ $(lines) == 3 ]]' "$(cat $J)"
ok '2. the waiter: queue wait (acquire - request) >= 1 s' '(( F[3] - F[2] >= 1.0 ))' "$L"
ok '2. the waiter: hold (release - acquire) ~ its command (0.15..1 s)' '(( F[4] - F[3] >= 0.15 && F[4] - F[3] < 1 ))' "$L"
ok '2. holders: no queue wait (< 0.8 s)' '[[ -z $(LC_ALL=C awk -F"\t" "\$11 ~ /^zsh/ && \$3 - \$2 >= 0.8" $J) ]]' "$(cat $J)"
rm -f $T/rel $T/*.start

# 3. short and secret-free command
: > $J
TOKEN=s3cr3t "$H/medium.sh" env TOKEN=s3cr3t true --api-key=s3cr3t aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa w5 w6 w7 > /dev/null 2>&1
L=$(last); F=( "${(@ps:\t:)L}" )
ok '3. no secret in the journal' '! grep -q s3cr3t $J' "$L"
ok '3. assignments masked as name=*' '[[ $F[11] == "env TOKEN=* true --api-key=* "* ]]' "$F[11]"
ok '3. long word cut to 40 characters, at most 6 words' '[[ $F[11] == *" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa~ w5 ..." ]]' "$F[11]"

# 4. a journal that cannot be written
mkdir -p $T/jdir; : > $T/ro.tsv; chmod 444 $T/ro.tsv
for jj in $T/jdir $T/missing/dir/j.tsv $T/ro.tsv; do
  t0=$EPOCHREALTIME
  SLOT_JOURNAL=$jj "$H/medium.sh" zsh -c 'print -r -- ran; exit 4' > $T/4.out 2> $T/4.err; rc=$?
  ok "4. [$jj] the command ran and its code came back (4)" '(( rc == 4 )) && [[ $(<$T/4.out) == ran ]]' "$rc $(<$T/4.out) $(<$T/4.err)"
  ok "4. [$jj] nothing on stderr" '[[ ! -s $T/4.err ]]' "$(<$T/4.err)"
  ok "4. [$jj] no stall (< 3 s)" '(( EPOCHREALTIME - t0 < 3 ))'
done
ok '4. the read-only journal stays empty' '[[ ! -s $T/ro.tsv ]]'
SLOT_JOURNAL=$T/ok.tsv "$H/heavy.sh" true; SLOT_JOURNAL=$T/ok.tsv "$H/heavy.sh" true
ok '4. SLOT_JOURNAL=<file> - written there (two lines, append)' '[[ $(wc -l < $T/ok.tsv | tr -d " ") == 2 ]]' "$(cat $T/ok.tsv 2>&1)"
: > $J
SLOT_JOURNAL= "$H/medium.sh" true; rc=$?
ok "4. SLOT_JOURNAL='' - no journal at all, slot works" '(( rc == 0 )) && [[ ! -s $J ]]' "$(cat $J)"

# 5. exclusive guard: heavy + exclusive records
: > $J
print -r -- '// guards:exclusive — fixed port in this test' > $T/x-run.js
cd $T; "$H/heavy.sh" node x-run.js > $T/5.out 2>&1; rc=$?
ok '5. the guard ran in the exclusive lock (exit 0)' '(( rc == 0 ))' "$rc $(<$T/5.out)"
ok '5. two lines: exclusive and heavy' '[[ $(lines) == 2 && -n $(LC_ALL=C awk -F"\t" "\$5==\"exclusive\" && \$6==\"-\"" $J) && -n $(LC_ALL=C awk -F"\t" "\$5==\"heavy\"" $J) ]]' "$(cat $J) $(<$T/5.out)"
ok '5. the heavy record names the guard, not the wrapper' '[[ -n $(LC_ALL=C awk -F"\t" "\$5==\"heavy\" && \$11==\"node x-run.js\"" $J) ]]' "$(cat $J)"

# 6. killed while queueing
: > $J
for n in a b; do "$H/medium.sh" zsh -c 'touch '$T'/$1.start; while [[ ! -e '$T'/rel ]]; do sleep 0.05; done' _ $n > /dev/null 2>&1 & BG+=$!; done
waitfor '[[ -e $T/a.start && -e $T/b.start ]]'
"$H/medium.sh" sleep 5 > /dev/null 2>&1 & w=$!; BG+=$w
sleep 0.8; kill -TERM $w; wait $w 2>/dev/null
touch $T/rel; wait
L=$(grep $'\tsleep 5$' $J); F=( "${(@ps:\t:)L}" )
ok '6. a waiter killed in the queue: acquire "-", slot "-", rc 143, wait >= 0.6 s' '[[ $F[3] == - && $F[6] == - && $F[9] == 143 ]] && (( F[4] - F[2] >= 0.6 ))' "$L"
rm -f $T/rel $T/*.start

# 7. guards-all.sh: labelled, kind full
: > $J
"$H/guards-all.sh" xo > $T/7.out 2>&1
L=$(last); F=( "${(@ps:\t:)L}" )
ok '7. full run: class heavy, kind full, command "guards-all xo", worktree of the caller' '[[ $F[5] == heavy && $F[7] == full && $F[11] == "guards-all xo" && $F[9] == 0 ]]' "$L $(<$T/7.out)"

# 8. the summary reads what the shell wrote
: > $J
"$H/medium.sh" sleep 0.3; "$H/heavy.sh" sleep 0.2
S=$(node "$H/slot-journal.js" --journal $J --json)
ok '8. slot-journal.js: 2 holds, classes medium and heavy, hold totals match the commands' \
  'node -e "const s=JSON.parse(process.argv[1]); const c=Object.fromEntries(s.byClass); process.exit(s.all.n===2 && c.medium.holdTotal>=0.25 && c.heavy.holdTotal>=0.15 && s.badLines===0 ? 0 : 1)" "$S"' "$S"

print -r -- "
$pass passed, $fail failed"
(( fail == 0 ))
