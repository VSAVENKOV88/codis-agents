#!/bin/zsh
# Tester cells of p-runq part a beyond A1-A9 (tests/slots-select.test.sh): the note about a selection command without
# {jobs} must say what guards-all.sh really does, for every way a selection is started.
#   T1. the attribution of a red train (--guards) with a subset command without {jobs}: the same note as --select.
#   T2. a subset command with {limitFile} but no {jobs} is adaptive (guards-all.sh: {limitFile} -> adaptive), not whole:
#       it starts with its share next to a neighbour, and no note calls it "counted as the whole worker budget".
#   T3. the machine file names a remote runner, the project has no remoteRun.subsetCommand: the selection runs here, so
#       the note names guardSubsetCommand, never remoteRun.subsetCommand.
#   T4. a full run (no --select) with guardCommand without {jobs}: no selection note.
#   T5. config.js check: remoteRun without command (default guardCommand, with {jobs}) and subsetCommand without {jobs}:
#       the remote note; remoteRun.command without {jobs}: no remote note.
# Temporary slot directory, fake machine (M: 6 alone, 3 shared, macOS readings), temporary git project, fake npm.
#   usage: tests/slots-select-tester.test.sh   (zsh, git)
H=${0:A:h:h}/scripts
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-select-tester.XXXXXX"); T=${T:A}
unset GUARDS_EXCLUSIVE_LOCK SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB SLOT_PROC GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER SLOTS_DIR CODIS_AGENTS_MACHINE CLAUDE_PROJECT_DIR CODIS_AGENTS_CONFIG
export XDG_CONFIG_HOME=$T/xdg SLOT_LEGACY_LOCK= SLOT_POLL=0.3 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
mkdir -p $T/xdg $T/bin $T/wts $T/shared
pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
(( $+commands[git] )) || { print -r -- "  skip all - skipped: git not found"; print -r -- "TOTAL: 0 ok, 0 fail"; exit 0; }

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
# Fake npm: "start/end <tag>" in npm.log; with --concurrency-file the limit it reads every 0.3 s goes to npm.<tag>.trace
# and <file>.active; it runs while $T/hold.<tag> exists.
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

gm() { git -C $T/main -c user.name=t -c user.email=t@t "$@" }
mkdir -p $T/main/srv
print -r -- "// guard" > $T/main/srv/a-run.js
gm init -q -b base && gm add srv && gm commit -qm base
for w in s1 s2; do
  gm worktree add -q -b t-$w $T/wts/$w
  print -r -- "// changed in $w" > $T/wts/$w/srv/a-run.js
  git -C $T/wts/$w -c user.name=t -c user.email=t@t commit -qam "change $w"
done
print -r -- '["srv/a-run.js"]' > $T/names.json
FULL='cd {wt}/srv && npm run guards -- --all --concurrency {jobs} --concurrency-file {limitFile}'
WHOLE='cd {wt}/srv && npm run guards -- --all {onlyArgs}'
LIMITONLY='cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency-file {limitFile}'
# setcfg <guardCommand> <guardSubsetCommand> [remoteRun JSON]
setcfg() { print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared", "protectedBranches": ["base"],
  "guardRerun": {"command": "cd {wt} && true {name}", "newRedPattern": "^X (\\S+)", "tallyPattern": "^TOTAL: (\\d+) total$"},
  "guardCommand": "'$1'", "guardSubsetCommand": "'$2'"'${3:+, \"remoteRun\": $3}'}' > $T/cfg.json }
export CODIS_AGENTS_CONFIG=$T/cfg.json SLOTS_DIR=$T/slots SLOT_OS=darwin

hold() { local n; for n; do touch $T/hold.$n; done }
unhold() { local n; for n; do rm -f $T/hold.$n; done }
nlog() { : > $T/npm.log; rm -f $T/npm.*.trace(N) $T/npm.*.args(N) $T/hold.*(N) $T/*.out(N) }
trace() { [[ -f $T/npm.$1.trace ]] && print -r -- "$(<$T/npm.$1.trace)" }
last() { local t=( $(trace $1) ); print -r -- ${t[-1]} }
startedrun() { grep -q "^start $1 " $T/npm.log }
waitlong() { local i; for i in {1..600}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
overlap() { awk '$1=="start"{if(run[$2]==0) for(k in run) if(run[k]) print k, $2; run[$2]=1} $1=="end"{run[$2]=0}' $T/npm.log }

# T1. --guards (attribution of a red train) without {jobs}: the note, naming guardSubsetCommand
setcfg $FULL $WHOLE
nlog; $H/guards-all.sh --force --guards $T/names.json s1 > $T/s1.out 2>&1
ok "T1. --guards with a subset command without {jobs}: note naming guardSubsetCommand, the run still goes" \
  'grep -q "note: guardSubsetCommand has no {jobs}" $T/s1.out && startedrun s1' "$(cat $T/s1.out)"

# T2. {limitFile} without {jobs}: adaptive next to a neighbour, and no "whole budget" note
setcfg $FULL $LIMITONLY
nlog; hold s1 s2
$H/guards-all.sh --force --select base s1 > $T/s1.out 2>&1 &
waitlong '[[ $(last s1) == 6 ]]'
$H/guards-all.sh --force --select base s2 > $T/s2.out 2>&1 &
waitlong '[[ $(last s2) == 3 && $(last s1) == 3 ]]'
unhold s1 s2; wait
ok "T2. {limitFile} without {jobs}: adaptive - the two selections run at once, 3 each" \
  '[[ "$(overlap)" == "s1 s2" ]] && grep -q "workers at start: 6 " $T/s1.out && grep -q "workers at start: 3 " $T/s2.out' "overlap: $(overlap); $(cat $T/s2.out)"
ok "T2. ... and no note calls it counted as the whole worker budget (it is not)" \
  '! grep -q "whole worker budget" $T/s1.out $T/s2.out' "$(grep -h note $T/s1.out $T/s2.out)"

setcfg $FULL $LIMITONLY
x=$(node $H/config.js check $T/cfg.json 2>&1); rc=$?
ok "T2. config.js check: a subset command with {limitFile} but no {jobs} (adaptive) gets no whole-budget note" \
  '(( rc == 0 )) && [[ $x != *"whole worker budget"* ]]' "$rc $x"

# T3. a remote runner in the machine file, no remoteRun.subsetCommand: the selection runs here, the note names guardSubsetCommand
print -r -- 'not a key' > $T/key; print -r -- 'example.org ssh-ed25519 AAAA' > $T/kh
print -r -- '{"configVersion": 1, "swapMinMB": 0, "minFreeDiskGB": 0, "slots": {"lockDir": "'$T'/slots"},
  "remote": {"host": "example.org", "user": "runner", "key": "'$T'/key", "knownHosts": "'$T'/kh", "root": "~/codis-runs", "plugin": "'${H:h}'"}}' > $T/machine.json
export CODIS_AGENTS_MACHINE=$T/machine.json
setcfg $FULL $WHOLE '{"command": "'$FULL'"}'
nlog; $H/guards-all.sh --force --select base s1 > $T/s1.out 2>&1
ok "T3. remote runner without remoteRun.subsetCommand: the selection runs here, the note names guardSubsetCommand" \
  'startedrun s1 && grep -q "no remoteRun.subsetCommand" $T/s1.out && grep -q "note: guardSubsetCommand has no {jobs}" $T/s1.out && ! grep -q "note: remoteRun.subsetCommand has no" $T/s1.out' "$(cat $T/s1.out)"
unset CODIS_AGENTS_MACHINE

# T4. a full run with guardCommand without {jobs}: whole as before, no selection note
setcfg 'cd {wt}/srv && npm run guards -- --all' $WHOLE
nlog; $H/guards-all.sh --force s1 > $T/s1.out 2>&1
ok "T4. a full run whose guardCommand has no {jobs}: runs (whole), no note about a subset command" \
  'startedrun s1 && grep -q "counted as the whole budget" $T/s1.out && ! grep -q "note: .*has no {jobs}" $T/s1.out' "$(cat $T/s1.out)"

# T5. config.js check: the remote note against the default command, and none when the runner's command has no {jobs}
setcfg $FULL "cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}" '{"subsetCommand": "'$WHOLE'"}'
x=$(node $H/config.js check $T/cfg.json 2>&1); rc=$?
ok "T5. remoteRun without command (default guardCommand with {jobs}), subsetCommand without: the remote note, exit 0" \
  '(( rc == 0 )) && [[ $x == *"note: remoteRun.subsetCommand has no {jobs}"* ]]' "$rc $x"
setcfg $FULL "cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}" '{"command": "cd {wt}/srv && npm run guards -- --all --no-font", "subsetCommand": "'$WHOLE'"}'
x=$(node $H/config.js check $T/cfg.json 2>&1); rc=$?
ok "T5. remoteRun.command without {jobs} (the runner sets its own workers): no remote note" \
  '(( rc == 0 )) && [[ $x != *"has no {jobs}"* ]]' "$rc $x"

wait 2>/dev/null
rm -rf $T
print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
