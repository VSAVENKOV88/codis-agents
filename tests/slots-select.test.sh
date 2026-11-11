#!/bin/zsh
# Selections with a worker budget (p-runq part a, cells A1-A5, A8, A9 of the p-runq matrix): a selection of a task
# (guards-all.sh --select) or the attribution of a red train (guards-all.sh --guards) whose guardSubsetCommand has
# {jobs} and {limitFile}, like guardCommand, takes its share of the worker budget: two selections, or a selection and a
# full run, run at the same time, together never above slots.jobsAlone. Without {jobs} the selection is counted as the
# whole budget (kind "whole", README guardCommand) and goes one at a time, with a note that names the key.
# Two environments on a TEMPORARY slot directory, a fake machine and a temporary git project, the runner a fake npm:
#   M - this machine's defaults (no machine file): budget 6 alone, 3 shared, macOS readings (fake tools);
#   R - a runner like the measured one: a machine file with jobsAlone 14, jobsShared 7, Linux readings from a fake /proc
#       (the extra heavy slot is off there), so two heavy slots.
# The budget a runner uses is what it read from its limit file; the fake npm writes it to <slot>.limit.active every
# tick, as the real runner writes its running count. A sampler sums those numbers over the heavy slots every 0.1 s:
# the sum never exceeds jobsAlone, and the samples show both runs going at once.
#   usage: tests/slots-select.test.sh   (zsh, git)
H=${0:A:h:h}/scripts
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-select.XXXXXX"); T=${T:A}
# hermetic inside an outer slot (heavy.sh node tests/run.js): drop what an outer slots.zsh exported and the thresholds
unset GUARDS_EXCLUSIVE_LOCK SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_PRIORITY SLOT_KILL_GRACE SLOT_EMPTY_WAIT SLOT_EXEC_NOTE CODIS_SLOT_HELD SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_PROC GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER SLOTS_DIR CODIS_AGENTS_MACHINE CLAUDE_PROJECT_DIR
export XDG_CONFIG_HOME=$T/xdg SLOT_LEGACY_LOCK= SLOT_POLL=0.3 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
mkdir -p $T/xdg $T/bin $T/wts $T/shared $T/proc
pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
(( $+commands[git] )) || { print -r -- "  skip all - skipped: git not found"; print -r -- "TOTAL: 0 ok, 0 fail"; exit 0; }

# Fake macOS tools (M): 20 % free memory - the extra heavy slot stays shut, two heavy slots as on R.
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
# Fake /proc (R): 30 GB, 8 GB of swap, nothing swapped out.
print -r -- "MemTotal:       31457280 kB
MemAvailable:   20971520 kB
SwapTotal:       8388604 kB
SwapFree:        8388604 kB" > $T/proc/meminfo
print -r -- "pswpin 0
pswpout 0" > $T/proc/vmstat
# Fake npm: "start/end <tag> <args>" in npm.log (tag = the worktree); with --concurrency-file every 0.3 s the limit it
# reads goes to <file>.active (the real runner writes its running count there). It runs while $T/hold.<tag> exists.
print -r -- '#!/bin/zsh
zmodload zsh/datetime; tag=${PWD:h:t}; jf=; a=("$@")
for i in {1..$#a}; do [[ $a[i] == --concurrency-file ]] && jf=$a[i+1]; done
print -r -- "start $tag $EPOCHREALTIME $*" >> '$T'/npm.log; print -r -- "$*" > '$T'/npm.$tag.args
k=0
while (( k++ < 1 )) || [[ -e '$T'/hold.$tag ]]; do
  [[ -n $jf && -s $jf ]] && { print -rn -- "$(<$jf) " >> '$T'/npm.$tag.trace; print -r -- "$(<$jf)" > $jf.active; }
  sleep 0.3
done
print -r -- "end $tag $EPOCHREALTIME" >> '$T'/npm.log
print -r -- "TOTAL: ${#${(M)a:#--only}} total"   # the tally line the count of a selection reads (p-noghost-b)
exit 0' > $T/bin/npm
chmod +x $T/bin/*; export PATH=$T/bin:$PATH

# The project: a base branch with a guard, a worktree per run, each changing that guard (so its selection is not empty).
gm() { git -C $T/main -c user.name=t -c user.email=t@t "$@" }
mkdir -p $T/main/srv/tools
print -r -- "// guard" > $T/main/srv/a-run.js; print -r -- "else if (a === '--concurrency-file')" > $T/main/srv/tools/guards.js
gm init -q -b base && gm add srv && gm commit -qm base
for w in s1 s2 s3 tf; do
  gm worktree add -q -b t-$w $T/wts/$w
  print -r -- "// changed in $w" > $T/wts/$w/srv/a-run.js
  git -C $T/wts/$w -c user.name=t -c user.email=t@t commit -qam "change $w"
done
print -r -- '["srv/a-run.js"]' > $T/names.json
ADAPT='cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}'
WHOLE='cd {wt}/srv && npm run guards -- --all {onlyArgs}'
FULL='cd {wt}/srv && npm run guards -- --all --concurrency {jobs} --concurrency-file {limitFile}'
setcfg() { print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared", "protectedBranches": ["base"],
  "guardRerun": {"command": "cd {wt} && true {name}", "newRedPattern": "^X (\\S+)", "tallyPattern": "^TOTAL: (\\d+) total$"},
  "guardCommand": "'$FULL'", "guardSubsetCommand": "'$1'"}' > $T/cfg.json }
export CODIS_AGENTS_CONFIG=$T/cfg.json

hold() { local n; for n; do touch $T/hold.$n; done }
unhold() { local n; for n; do rm -f $T/hold.$n; done }
nlog() { : > $T/npm.log; rm -f $T/npm.*.trace(N) $T/npm.*.args(N) $T/hold.*(N) $T/*.out(N) }
trace() { [[ -f $T/npm.$1.trace ]] && print -r -- "$(<$T/npm.$1.trace)" }
last() { local t=( $(trace $1) ); print -r -- ${t[-1]} }
startedrun() { grep -q "^start $1 " $T/npm.log }
waitlong() { local i; for i in {1..900}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
# overlaps in npm.log: "a b" - b started while a was running
overlap() { awk '$1=="start"{if(run[$2]==0) for(k in run) if(run[k]) print k, $2; run[$2]=1} $1=="end"{run[$2]=0}' $T/npm.log }
# sel <worktree> [args] - a selection in the background, output in $T/<worktree>.out
sel() { local w=$1; shift; $H/guards-all.sh --force "$@" --select base $w > $T/$w.out 2>&1 & }
# the sampler: "<runs with a number> <their sum>" every 0.1 s into $T/samples
samp_on() { : > $T/samples; rm -f $T/samp.stop
  { while [[ ! -e $T/samp.stop ]]; do local s=0 n=0 f v; for f in $SLOTS_DIR/heavy.*.lock.limit.active(N); do v=$(<$f) 2>/dev/null; [[ $v == <-> ]] && (( s += v, n++ )); done
    print -r -- "$n $s" >> $T/samples; sleep 0.1; done } &! SAMP=$! }
samp_off() { touch $T/samp.stop; waitlong '! kill -0 $SAMP 2>/dev/null' }
maxsum() { awk 'BEGIN{m=0} $2>m{m=$2} END{print m}' $T/samples }
both() { awk '$1>=2{n++} END{print n+0}' $T/samples }
# a single heavy job (a CI run through heavy.sh) that holds its slot until $T/rel.<name>
hjob() { "$H/heavy.sh" zsh -c 'touch '$T'/$1.start; while [[ ! -e '$T'/rel.$1 ]]; do sleep 0.1; done' _ $1 > $T/$1.out 2>&1 & }

cells() { # cells <env> <alone> <shared>
  local E=$1 A=$2 S=$3 x
  print -r -- "-- $E: budget $A alone, $S shared"
  setcfg $ADAPT

  # A4. one selection alone: the whole budget
  nlog; sel s1; wait
  ok "$E A4. one selection with {jobs}/{limitFile}: --concurrency $A, \"workers at start: $A\"" \
    'grep -q -- "--concurrency $A --concurrency-file .*heavy\.[123]\.lock\.limit" $T/npm.s1.args && grep -q "workers at start: $A " $T/s1.out' "$(cat $T/npm.s1.args $T/s1.out 2>/dev/null)"
  ok "$E A4. ... no note about a missing {jobs}" '! grep -q "has no {jobs}" $T/s1.out' "$(cat $T/s1.out)"

  # A1. two selections one after the other: both in heavy slots at once, A -> S each, sum <= A
  nlog; samp_on; hold s1 s2
  sel s1; waitlong '[[ $(last s1) == $A ]]'
  sel s2; waitlong '[[ $(last s2) == $S && $(last s1) == $S ]]'
  waitlong '(( $(both) >= 3 ))'
  unhold s1 s2; wait; samp_off
  ok "$E A1. two selections run at the same time (both started before either ended)" '[[ -n "$(overlap)" ]] && (( $(both) >= 3 ))' "overlap: $(overlap); $(cat $T/npm.log)"
  ok "$E A1. the first starts with $A and drops to $S, the second starts with $S" '[[ "$(trace s1)" == $A*\ $S* && $(trace s2) == $S\ * ]]' "s1: $(trace s1) | s2: $(trace s2)"
  ok "$E A1. the sum of the workers never exceeds $A" '(( $(maxsum) <= A ))' "max $(maxsum)"

  # A2. a selection runs, a full run (the train's) comes: both at once, by the shared budget, sum <= A
  nlog; samp_on; hold s1 tf
  sel s1; waitlong '[[ $(last s1) == $A ]]'
  $H/guards-all.sh --force tf > $T/tf.out 2>&1 &
  waitlong '[[ $(last tf) == $S && $(last s1) == $S ]]'
  waitlong '(( $(both) >= 3 ))'
  unhold s1 tf; wait; samp_off
  ok "$E A2. a selection and a full run at the same time, $S each" '[[ "$(overlap)" == "s1 tf" && $(trace tf) == $S\ * && "$(trace s1)" == $A*\ $S* ]]' "overlap: $(overlap); s1: $(trace s1) | tf: $(trace tf)"
  ok "$E A2. the sum never exceeds $A" '(( $(maxsum) <= A ))' "max $(maxsum)"

  # A3. both heavy slots hold selections, a third waits by ticket and starts when one ends
  nlog; samp_on; hold s1 s2 s3
  sel s1; waitlong '[[ $(last s1) == $A ]]'
  sel s2; waitlong '[[ $(last s2) == $S && $(last s1) == $S ]]'
  sel s3; waitlong '(( $(grep -c "waiting for slot heavy" $T/s3.out) >= 2 ))'
  ok "$E A3. the third selection waits for a heavy slot (\"waiting for slot heavy\") and does not start" '! startedrun s3 && grep -q "waiting for slot heavy" $T/s3.out' "$(cat $T/s3.out)"
  unhold s1; waitlong 'startedrun s3 && [[ $(last s3) == $S ]]'
  ok "$E A3. ... the first ends: the third gets the slot with $S" 'startedrun s3 && [[ $(trace s3) == $S\ * ]]' "s3: $(trace s3); $(tail -3 $T/s3.out)"
  unhold s2 s3; wait; samp_off
  ok "$E A3. the sum never exceeds $A" '(( $(maxsum) <= A ))' "max $(maxsum)"

  # A8. the attribution of a red train (--guards) uses the same budget as a selection
  nlog; hold s1 s2
  sel s1; waitlong '[[ $(last s1) == $A ]]'
  $H/guards-all.sh --force --guards $T/names.json s2 > $T/s2.out 2>&1 &
  waitlong '[[ $(last s2) == $S && $(last s1) == $S ]]'
  unhold s1 s2; wait
  ok "$E A8. guards-all.sh --guards with {jobs}/{limitFile}: adaptive, starts with $S next to a selection" '[[ "$(overlap)" == "s1 s2" ]] && grep -q "workers at start: $S " $T/s2.out && grep -q -- "--only" $T/npm.s2.args' "$(cat $T/s2.out)"

  # A9. a single heavy job (CI heavy.sh) runs: the selection with {jobs} is admitted with the shared budget
  nlog; rm -f $T/rel.ci $T/ci.start; hjob ci; waitlong '[[ -e $T/ci.start ]]'
  sel s1; waitlong 'startedrun s1'
  ok "$E A9. a CI heavy job runs: the selection starts at once with $S (does not wait for the CI job)" 'startedrun s1 && grep -q "workers at start: $S " $T/s1.out' "$(cat $T/s1.out)"
  touch $T/rel.ci; wait

  # A5. no {jobs} (the current project config): whole, one at a time, and a note naming the key
  setcfg $WHOLE
  nlog; hold s1 s2
  sel s1; waitlong 'startedrun s1'
  sel s2; waitlong 'grep -q "full run without {jobs}" $T/s2.out'
  ok "$E A5. without {jobs} the second selection waits for the whole budget outside the slot" '! startedrun s2 && grep -q "full run without {jobs}" $T/s2.out' "$(cat $T/s2.out)"
  unhold s1; waitlong 'startedrun s2'; unhold s2; wait
  ok "$E A5. ... and starts only after the first ended (no overlap)" '[[ -z "$(overlap)" ]] && startedrun s2' "$(cat $T/npm.log)"
  ok "$E A5. each selection says: note: guardSubsetCommand has no {jobs}, counted as the whole budget, add {jobs} and {limitFile}" \
    'grep -q "note: guardSubsetCommand has no {jobs}" $T/s1.out && grep -q "note: guardSubsetCommand has no {jobs}" $T/s2.out && grep -q "whole worker budget" $T/s1.out && grep -qF "{limitFile}" $T/s1.out' "$(cat $T/s1.out)"
  # A9 without {jobs}: the selection waits for the end of the CI job
  nlog; rm -f $T/rel.ci $T/ci.start; hjob ci; waitlong '[[ -e $T/ci.start ]]'
  sel s1; waitlong 'grep -q "full run without {jobs}" $T/s1.out'
  ok "$E A9. without {jobs} the selection waits for the CI job to end" '! startedrun s1' "$(cat $T/s1.out)"
  touch $T/rel.ci; waitlong 'startedrun s1'; wait
  ok "$E A9. ... then runs" 'startedrun s1' "$(cat $T/s1.out)"
}

# M: this machine, no machine file - the defaults
export SLOTS_DIR=$T/slots-m SLOT_OS=darwin
cells M 6 3
# R: the runner's machine file (budget 14 / 7), Linux readings
unset SLOTS_DIR
print -r -- '{"configVersion": 1, "source": "test: as the measured runner", "swapMinMB": 4000, "minFreeDiskGB": 0,
  "slots": {"lockDir": "'$T'/slots-r", "jobsAlone": 14, "jobsShared": 7}}' > $T/machine-r.json
export CODIS_AGENTS_MACHINE=$T/machine-r.json SLOT_OS=linux SLOT_PROC=$T/proc SLOTS_DIR=$T/slots-r
cells R 14 7

wait 2>/dev/null
rm -rf $T
print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
