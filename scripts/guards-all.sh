#!/bin/zsh
# Full guard run of one worktree in a heavy slot (slots.zsh). Guards that share a machine resource (marked
# `guards:exclusive — <reason>`, project config key guardExclusive) are run one at a time by the project's runner
# through $GUARDS_EXCLUSIVE_LOCK, across runs too.
# Workers follow the budget of slots.zsh#slot_guard_plan: all full runs together <= GUARDS_JOBS_ALONE (6); the only
# heavy job -> 6, another heavy job -> <= GUARDS_JOBS_SHARED (3), and never more than what the neighbours leave.
#   Adaptive runner (guardCommand has {limitFile}): the limit is re-evaluated every SLOT_POLL s - a neighbour comes,
#   new guards wait until fewer than the limit run; it leaves, the limit goes back up.
#   Fixed runner (guardCommandLegacy, or guardCommand without {limitFile}): the count is chosen once at start.
#   Runner without {jobs} (and without {limitFile}): it sets its own workers, so it is counted as the whole budget
#   ("fixed GUARDS_JOBS_ALONE") and starts only when that whole budget is free - no other heavy job (queue kind
#   "whole"); starting it on a share would break the ceiling, since nothing tells it to use fewer. The admission
#   reserves that budget (<slot>.whole), so single heavy jobs admitted right after it do not send it back to the queue.
#   No budget -> "waiting for workers ..." (inside the slot with an adaptive neighbour; outside it otherwise).
# Queue (slots.zsh, FIFO): a full run waits by ticket as kind "full" - without a budget it does not take the slot, but
#   late single heavy jobs do not pass it either; exit 75 (budget taken after admission) - back to the queue with the
#   same ticket (SLOT_RETRY_RC).
# Command: project config key guardCommand, run with zsh in the worktree; placeholders {wt}, {jobs} (optional),
#   {limitFile} (optional). A placeholder this script does not fill ({onlyArgs} in a full command, {name}, a typo) is
#   a config error (scripts/config.js FILLS), so slots.zsh refuses 78 naming the key before anything runs.
# Exit code: the runner's own (the last 25 log lines are printed either way). The runner's code travels through a file,
#   so a runner that itself exits 75 is never mistaken for "no worker budget" and retried.
# Rerun (project config key guardRerun; scripts/guards-result.js): after a red full run, still in the same slot, every
#   new red named in the log runs once more alone. Red again -> new red, the runner's code stays; green alone -> flaky,
#   listed for the project backlog; only flaky -> exit 0. Without guardRerun the runner's code stands as before.
#   Known reds (key guardBaseline, a JSON file {"<guard name>": "<reason>"} relative to the worktree) are subtracted
#   first and never rerun: only known reds -> exit 0 and "N known red"; a missing or broken file -> the code stands.
#   Quarantine (with guardBaseline only): a flaky guard is written into <sharedDir>/guards-quarantine.json (same flat
#   format, "flaky: <log> <sha7>, green alone, <date>"), outside the worktree so the tracked tree stays clean; every run
#   subtracts it too, and the coordinator moves its entries into guardBaseline (guards-result.js quarantine-take) and
#   commits them. The hash of that file as the run read it goes into the meta: a changed quarantine is never reused.
#   The quarantine belongs to this machine: a remote run sends it with the run (scripts/guards-remote.js), the runner's
#   own call has --quarantine-read-only (subtracted, never written) and this machine writes the flaky guards of the
#   log that comes back; --no-quarantine neither reads nor writes it.
# Reuse: HEAD, clean tracked tree, command and final code are kept next to the log (<log>.meta.json). The same HEAD,
#   still clean, same command, final code 0 -> no new run: "reused, HEAD <sha>" and the saved summary, exit 0.
#   --force runs anyway.
# Main working copy (scripts/main-checkout.js): a worktree that is the main working copy of its repository
#   (git-dir == git-common-dir) is refused with 78 before any slot - its ignored data is the only original and a guard
#   run there once wiped a corpus; task worktrees hold clones (wt-setup.sh). --main-checkout runs it anyway, for a
#   project that has no worktrees (a flag, not an environment variable, so it is never inherited silently).
# Remote runner (machine key remote, project key remoteRun; scripts/guards-remote.js): the run goes to the runner instead
#   of a heavy slot here - only the committed HEAD (tracked changes: 78), pushed over pinned ssh; the log comes back to
#   the same <sharedDir>/guards-<name>.txt with the header "ran on runner <host>, HEAD <sha>, workers N", its meta with
#   env "remote:<host>" (reuse never crosses environments); this machine writes one journal line of class remote and
#   holds no slot while it waits; guards the runner does not run (remoteRun.localPattern) run here afterwards in a heavy
#   slot, and the worse exit code is the run's. Environment problems: exit 69, the log's first line "environment: ...".
#   A remote key without remoteRun in the project keeps the run here, with a note. --local runs here regardless (the
#   runner itself calls its guards-all.sh so).
# Selection (--select <base>; rules/multi-agent.md "No full guard run in the task"): the guards of the task's diff
#   instead of the full suite - scripts/guards-select.js against the merge-base with <base> (changed guards, guards that
#   import or name a changed file, guardAlways) fills {onlyArgs} of guardSubsetCommand (78 without it). Its own log
#   <sharedDir>/guards-<name>.select.txt, so a selection is never reused for a full run nor the other way (the commands
#   differ in the meta too); the same rerun of new reds alone and known reds; the quarantine is read only (a flaky guard
#   of a selection goes into the role's report, not into the quarantine). Nothing selected: the log says "nothing
#   selected", exit 0, no command runs (an empty --only list would run every guard). The selection could not be computed
#   (git: unknown base, not a repository): exit 65. On the remote runner only with remoteRun.subsetCommand (run name
#   <name>-select); without that key it runs in a heavy slot here, with a note - an unreachable runner stays 69.
# Count of a selection (p-noghost, case 2026-10-30: 0 of 10 guards ran and the run exited 0): a run given guards by
#   --only (--select, --guards, the runner's --selected) compares group 1 of the last guardRerun.tallyPattern line (the
#   selected guards it accounted for: ran, or skipped by a flag) with the selected guards minus those a
#   remoteRun.localPattern line of its log names; fewer, or no tally line, is the environment: "environment: the run
#   accounted for T of N selected guards: ..." appended to the log, exit 69 (meta 69, never reused), before and instead of
#   the rerun of new reds (scripts/guards-result.js count). A full run is not counted.
# Named guards (--guards <names file>, a JSON array of guard names as newRedPattern finds them in a log): the same
#   selection mode with these guards instead of the diff's - the attribution of a red train (scripts/train.js) runs the
#   repeated new reds of the train on "arc head + passenger" so. An empty list: "nothing selected", exit 0; a file that
#   is not a JSON array of names: exit 64.
# Priority (--priority; scripts/train.js passes it for the full run of a train and for its attribution): the ticket of
#   this run in the heavy queue is ahead of every waiter without it (slots.zsh, SLOT_PRIORITY=1); trains among
#   themselves keep the order of arrival; nothing running is stopped. Only this flag sets it, never the name of the
#   worktree or the run. It holds in the worker budget too (slots.zsh, slot_guard_plan "Priority"; p-runner-share): a
#   run without the priority yields to it - it waits outside the slot or takes what the train leaves, a running one
#   re-evaluates down to 1 - and the train counts it only by what it runs now, never sharing with it; the workers line
#   of the log ends with "(--priority: ...)". With the remote runner the flag travels with the run
#   (guards-remote.js --priority, job.priority): the runner's guards-all.sh runs with --priority, in its queue and its
#   budget (its own slots.jobsAlone).
# Guard run of a codex role (scripts/heavy-service.js, heavy-req.js --kind full | --kind select --base <ref>): the
#   adapter starts this script outside the sandbox with CODIS_GUARDS_EXEC naming the executor spec of the run. Then the
#   run is local whatever the machine file says (the remote runner waits for A2b-2) and its log gets the line "local
#   full run: ..." / "local selection: ..."; "guards log: <log>" is printed first; the slot journal label adds the label
#   of the spec ("guards-all <name> codex <task> <role> <id>"); every command of the project - the runner in each mode
#   and a single rerun (guards-result.js) - runs through scripts/heavy-exec.js in codex sandbox; the meta names the
#   environment sandbox:codex, and such a run is never reused by a run without the variable (guards-result.js reuse).
#   Without the variable nothing of this happens. Inside a held slot (CODIS_SLOT_HELD: a command of the heavy channel)
#   this script refuses 64 at once: its own ticket would wait behind the held slot forever.
# usage: guards-all.sh [--force] [--main-checkout] [--local] [--no-quarantine] [--quarantine-read-only] [--priority] [--select <base> | --guards <names file>] <worktree>   (a name under worktreeRoot, or a path) -> log in <sharedDir>/guards-<name>.txt (.select.txt)
#   A worktree directly under worktreeRoot (by name or by path) logs as guards-<name>.txt; any other path as
#   guards-<basename>-<cksum of its resolved path>.txt, so two worktrees with the same basename never share a log and
#   its reuse record.
H=${0:A:h}
FORCE=0 LOCAL=0 NOQ=0 PRIO=0 QRO= MAINOK=() SELECT= SELBASE= SELFILE= SELTMP= GUARDS= TPL= ONLY=; typeset -a POS
USAGE="usage: guards-all.sh [--force] [--main-checkout] [--local] [--no-quarantine] [--quarantine-read-only] [--priority] [--select <base> | --guards <names file> | --selected <names file>] <worktree name or path>"
while (( $# )); do
  case $1 in
    --force) FORCE=1;; --local) LOCAL=1;; --no-quarantine) NOQ=1;; --quarantine-read-only) QRO=ro;; --priority) PRIO=1;; --main-checkout) MAINOK=(--main-checkout);;
    --select) [[ -n $2 ]] || { print -u2 -r -- "$USAGE"; exit 64; }; SELECT=1 SELBASE=$2; shift;;
    --guards) [[ -n $2 ]] || { print -u2 -r -- "$USAGE"; exit 64; }; SELECT=1 GUARDS=${2:A}; shift;;
    # the guards a selection runs, a JSON array (guards-select.js --names-out): the runner's run of a selection
    # (scripts/guards-remote-host.js) - a known red outside it did not run and is never called "not red now"
    --selected) [[ -n $2 ]] || { print -u2 -r -- "$USAGE"; exit 64; }; SELFILE=${2:A}; shift;;
    *) POS+=("$1");;
  esac
  shift
done
set -- "${POS[@]}"
[[ -n $1 ]] || { print -u2 -r -- "$USAGE"; exit 64; }
[[ -n $GUARDS && -n $SELBASE ]] && { print -u2 -r -- "guards-all: --select and --guards exclude each other"$'\n'"$USAGE"; exit 64; }
if [[ -n $CODIS_SLOT_HELD ]]; then
  print -u2 -r -- "guards-all: refused - inside a held slot (CODIS_SLOT_HELD=$CODIS_SLOT_HELD): a guard run takes a heavy slot of its own, and its ticket would wait behind the held slot forever; a codex role asks the heavy channel: heavy-req.js --kind select --base <ref> | --kind full"
  exit 64
fi
WHERE=
if [[ -n $CODIS_GUARDS_EXEC ]]; then LOCAL=1; WHERE="local full run"; [[ -n $SELBASE || -n $GUARDS ]] && WHERE="local selection"; fi
cfg() { node "$H/config.js" get "$1" 2>/dev/null }
# An absolute worktree brings its own project config (config.js path --from: the nearest .claude/codis-agents.json from
# it upwards), so a run started from another folder neither takes a foreign config nor refuses 78; an explicit
# $CODIS_AGENTS_CONFIG still wins. Exported: slots.zsh, cfg and the scripts below read it. A relative name keeps the
# lookup from the cwd (its worktreeRoot is what resolves the name).
if [[ -z $CODIS_AGENTS_CONFIG && $1 == /* && -d $1 ]] && _ga_cfg=$(node "$H/config.js" path --from "$1" 2>/dev/null); then
  export CODIS_AGENTS_CONFIG=$_ga_cfg
fi
source "$H/slots.zsh" || exit $?
[[ -n $CODIS_WORKTREE_ROOT && -n $CODIS_SHARED_DIR ]] || { print -u2 "guards-all: no project config (.claude/codis-agents.json) found"; exit 78; }
if [[ $1 == /* ]]; then WT=$1; else WT=$CODIS_WORKTREE_ROOT/$1; fi
[[ -d $WT ]] || { print -u2 "guards-all: no worktree $WT"; exit 66; }
node "$H/main-checkout.js" $MAINOK "$WT" || exit $?
NAME=${WT:A:t}
[[ ${WT:A:h} == ${CODIS_WORKTREE_ROOT:A} ]] || NAME=$NAME-${${=$(print -rn -- ${WT:A} | cksum)}[1]}
OUT=$CODIS_SHARED_DIR/guards-$NAME.txt
[[ -n $SELECT ]] && OUT=$CODIS_SHARED_DIR/guards-$NAME.select.txt
mkdir -p $CODIS_SHARED_DIR
[[ -n $WHERE ]] && print -r -- "guards log: $OUT"
if [[ -n $SELECT ]]; then
  CMD=$(cfg guardSubsetCommand)
  [[ -n $CMD ]] || { print -u2 "guards-all: --select needs guardSubsetCommand in the project config"; exit 78; }
fi
if [[ -n $GUARDS ]]; then
  ONLY=$(node "$H/guards-result.js" only-args "$GUARDS"); src=$?
  (( src == 64 )) && exit 64
  if (( src == 3 )); then
    print -r -- "nothing selected: the list of guards $GUARDS is empty" > "$OUT"; cat "$OUT"; exit 0
  fi
  (( src == 0 )) || exit $src
  SELFILE=$GUARDS
  TPL=$CMD CMD=${CMD//\{onlyArgs\}/$ONLY}   # CMD filled: the meta and the reuse; TPL: what sub() fills
  QRO=select
elif [[ -n $SELECT ]]; then
  SELERR=$(_slot_tmp guardssel) || { print -u2 "guards-all: no temporary file in ${TMPDIR:-/tmp} (mktemp failed)"; exit 73; }
  SELFILE=$(_slot_tmp guardsnames) || { rm -f $SELERR; print -u2 "guards-all: no temporary file in ${TMPDIR:-/tmp} (mktemp failed)"; exit 73; }
  SELTMP=1; trap 'rm -f $SELFILE' EXIT
  ONLY=$(node "$H/guards-select.js" --wt "$WT" --base "$SELBASE" --only-args --names-out "$SELFILE" 2>$SELERR); src=$?
  SELWHY=$(<$SELERR); rm -f $SELERR
  if (( src == 3 )); then
    print -r -- "nothing selected: no guard is changed, imports or names a changed file, or matches guardAlways (base $SELBASE, HEAD $(git -C "$WT" rev-parse --short HEAD 2>/dev/null)) - run your new guards directly" > "$OUT"
    cat "$OUT"; exit 0
  elif (( src == 2 )); then
    print -r -- "the selection could not be computed (base $SELBASE): $SELWHY" > "$OUT"
    print -u2 -r -- "guards-all: $(<$OUT)"; exit 65
  elif (( src != 0 )); then
    print -u2 -r -- "guards-all: guards-select.js exited $src: $SELWHY"; exit $src
  fi
  TPL=$CMD CMD=${CMD//\{onlyArgs\}/$ONLY}   # CMD filled: the meta and the reuse; TPL: what sub() fills
  QRO=select
else
  CMD=$(cfg guardCommand); LEGACY=$(cfg guardCommandLegacy); PFILE=$(cfg guardAdaptiveProbe.file); PTEXT=$(cfg guardAdaptiveProbe.contains)
  [[ -n $CMD ]] || { print -u2 "guards-all: guardCommand is not set in the project config"; exit 78; }
  # Older branches may carry a runner without the adaptive limit: the probe decides per worktree.
  if [[ -n $PFILE ]] && ! grep -qF -- "$PTEXT" "$WT/$PFILE" 2>/dev/null; then CMD=$LEGACY; fi
fi
mode=fixed; [[ $CMD == *'{jobs}'* ]] || mode=whole; [[ $CMD == *'{limitFile}'* ]] && mode=adaptive
kind=full; [[ $mode == whole ]] && kind=whole
RERUN=$(cfg guardRerun); [[ $RERUN == null ]] && RERUN=   # config get prints null for an unset object key
BASELINE=$(cfg guardBaseline)
LPAT=$(cfg remoteRun.localPattern)   # lines of guards a runner skipped by a flag: the count of a selection subtracts them
QFILE=; [[ -n $BASELINE ]] && (( ! NOQ )) && QFILE=$CODIS_SHARED_DIR/guards-quarantine.json
ENVID=local RNAME=$NAME SUBSET=()
if (( ! LOCAL )) && RHOST=$(cfg remote.host) && [[ -n $RHOST ]]; then
  if [[ -n $SELECT ]]; then
    if RCMD=$(cfg remoteRun.subsetCommand) && [[ -n $RCMD ]]; then ENVID=remote:$RHOST CMD=${RCMD//\{onlyArgs\}/$ONLY} RNAME=$NAME-select; SUBSET=(--subset "$CMD" --selected "$SELFILE")
    else print -u2 -r -- "guards-all: note: the machine file names the remote runner $RHOST, but the project config has no remoteRun.subsetCommand - the selection runs in a heavy slot on this machine"; fi
  elif RCMD=$(cfg remoteRun.command) && [[ -n $RCMD ]]; then ENVID=remote:$RHOST CMD=$RCMD
  else print -u2 -r -- "guards-all: note: the machine file names the remote runner $RHOST, but the project config has no remoteRun - the run stays on this machine"; fi
fi
GLABEL=
if [[ -n $WHERE ]]; then ENVID=sandbox:codex; GLABEL=$(node "$H/heavy-exec.js" label "$CODIS_GUARDS_EXEC" 2>/dev/null); fi
if (( ! FORCE )) && node "$H/guards-result.js" reuse "$WT" "$OUT" "$CMD" "$ENVID" "$QFILE" > /dev/null 2>&1; then
  tail -40 "$OUT"; print -r -- ""; node "$H/guards-result.js" reuse "$WT" "$OUT" "$CMD" "$ENVID" "$QFILE"; exit 0
fi
# A selection whose command has neither {jobs} nor {limitFile} is a runner that sets its own workers (the test of mode=whole above, on
# the command that runs): counted as the whole budget, it waits for every other heavy job, so selections and the train's
# run go one at a time (README guardSubsetCommand). Not an error - a note naming the key that decides here (on the
# runner its subsetCommand).
# The runner's own call (--local --guards, scripts/guards-remote-host.js) says nothing: the machine that started the run
# has said it, naming remoteRun.subsetCommand.
if [[ -n $SELECT && $CMD != *'{jobs}'* && $CMD != *'{limitFile}'* ]] && { (( ! LOCAL )) || [[ -z $GUARDS ]] }; then
  _ga_key=guardSubsetCommand; [[ $ENVID == remote:* ]] && _ga_key=remoteRun.subsetCommand
  print -u2 -r -- "guards-all: note: $_ga_key has no {jobs} (and no {limitFile}): the selection is counted as the whole worker budget (slots.jobsAlone) and starts only when no other heavy job runs, so selections go one at a time; give it --concurrency {jobs} and {limitFile} as guardCommand has (README, guardSubsetCommand)"
fi
if [[ $ENVID == remote:* ]]; then
  treq=$(_slot_now)
  node "$H/guards-remote.js" run "$WT" "$OUT" "$RNAME" "$QFILE" $SUBSET ${${PRIO:#0}:+--priority}; rc=$?
  # one line of class remote for the whole run (no slot here: acquire = request), in the worktree's name
  ( cd "$WT" 2>/dev/null; SLOT_LABEL="guards-all $NAME on $RHOST" _slot_journal $treq $treq $(_slot_now) remote - full $rc guards-all )
  exit $rc
fi
RCF=$(_slot_tmp guardsrc) || { print -u2 "guards-all: no temporary file in ${TMPDIR:-/tmp} (mktemp failed)"; exit 73; }
trap 'rm -f $RCF ${SELTMP:+$SELFILE}' EXIT
while true; do
  : > $RCF
  SLOT_KIND=$kind SLOT_RETRY_RC=75 SLOT_PRIORITY=$PRIO SLOT_LABEL="guards-all $NAME${GLABEL:+ $GLABEL}" slot_run heavy zsh -c '
    source "$1"; WT="$2"; OUT="$3"; CMD="$4"; mode="$5"; RCF="$6"; GR="$7"; RERUN="$8"; BASELINE="$9"; QFILE="${10}"; QRO="${11}"; SELFILE="${12}"; LPAT="${13}"; TPL="${14}"; ONLY="${15}"; PR="${16}"; ENVID="${17}"; WHERE="${18}"
    # a guard run of a codex role (CODIS_GUARDS_EXEC): the runner goes into the executor through heavy-exec.js
    X=(); [[ -n $CODIS_GUARDS_EXEC ]] && X=(node "${1:h}/heavy-exec.js" "$CODIS_GUARDS_EXEC" --)
    # the train (--priority) in the worker budget: runs without it yield (slots.zsh, slot_guard_plan)
    PRSAY=; [[ -n $PR ]] && PRSAY=" (--priority: the train; runs without it yield and take what it leaves)"
    cd "$WT" || exit 1
    t0=$EPOCHSECONDS said=0
    while true; do
      p=( $(slot_guard_plan "$SLOT_PATH" $mode start $PR) ); n=$p[1]
      (( n > 0 )) && break
      if [[ $mode == whole ]]; then
        print -r -- "waiting for workers outside the slot: $(slot_whole_why 0)"; exit 75
      fi
      if (( p[2] == 0 )); then
        print -r -- "waiting for workers outside the slot: neighbouring full runs hold the whole budget of $GUARDS_JOBS_ALONE until they end"
        exit 75
      fi
      if (( EPOCHSECONDS - said >= SLOT_SAY )); then
        print -r -- "waiting for workers in the slot ($(( EPOCHSECONDS - t0 )) s): a neighbour is shedding workers to its share"; said=$EPOCHSECONDS
      fi
      sleep $SLOT_POLL
    done
    node "$GR" meta-start "$WT" "$OUT" "$CMD" "$ENVID"
    # the template is filled, {onlyArgs} last: a value (a guard name, the worktree path) is never filled in again
    sub() { local c=$1; c=${c//\{jobs\}/$2}; c=${c//\{limitFile\}/${(q)SLOT_PATH}.limit}; c=${c//\{wt\}/${(q)WT}}; c=${c//\{onlyArgs\}/$ONLY}; print -r -- $c }
    if [[ $mode == adaptive ]]; then
      print -r -- "workers at start: $n (ceiling $GUARDS_JOBS_ALONE, re-evaluated every $SLOT_POLL s; $SLOT_PATH)$PRSAY"
      { while sleep $SLOT_POLL; do slot_guard_plan "$SLOT_PATH" adaptive run $PR > /dev/null; done } &
      tk=$!
      "${X[@]}" zsh -c "$(sub "$TPL" $GUARDS_JOBS_ALONE)" > "$OUT" 2>&1; print -r -- $? > "$RCF"
      pkill -P $tk 2>/dev/null; kill $tk 2>/dev/null   # and its sleep - no orphans
    elif [[ $mode == whole ]]; then
      print -r -- "workers: set by the runner itself (guardCommand has no {jobs}), counted as the whole budget $n ($SLOT_PATH)$PRSAY"
      "${X[@]}" zsh -c "$(sub "$TPL" $n)" > "$OUT" 2>&1; print -r -- $? > "$RCF"
    else
      print -r -- "workers: $n for the whole run (fixed runner; $SLOT_PATH)$PRSAY"
      "${X[@]}" zsh -c "$(sub "$TPL" $n)" > "$OUT" 2>&1; print -r -- $? > "$RCF"
    fi
    rm -f "$SLOT_PATH.jobs" "$SLOT_PATH.limit" "$SLOT_PATH.limit.tmp" "$SLOT_PATH.limit.active" "$SLOT_PATH.whole"
    [[ -n $WHERE ]] && print -r -- "$WHERE: a codex role'"'"'s run through the heavy channel; the remote runner waits for A2b-2" >> "$OUT"
    tail -25 "$OUT"
    # selected N - accounted for N (a run given guards by --only): fewer is the environment, 69, before any rerun
    COUNTED=1
    if [[ -n $SELFILE ]] && ! node "$GR" count "$OUT" "$RERUN" "$SELFILE" "$LPAT"; then print -r -- 69 > "$RCF"; COUNTED=; fi
    if [[ -n $RERUN && -n $COUNTED ]]; then node "$GR" rerun "$WT" "$OUT" "$(<$RCF)" "$RERUN" "$BASELINE" "$QFILE" "$QRO" ${SELFILE:+"$SELFILE"}; print -r -- $? > "$RCF"; fi
    node "$GR" meta-end "$WT" "$OUT" "$(<$RCF)" "$QFILE"' guards-all "$H/slots.zsh" "$WT" "$OUT" "$CMD" "$mode" "$RCF" "$H/guards-result.js" "$RERUN" "$BASELINE" "$QFILE" "$QRO" "$SELFILE" "$LPAT" "${TPL:-$CMD}" "$ONLY" "${${PRIO:#0}:+priority}" "$ENVID" "$WHERE"
  rc=$?
  [[ -s $RCF ]] && exit $(<$RCF)          # the runner ran: its code
  (( rc == 75 )) || exit $rc              # 75 without a run: no worker budget - queue again
  sleep $SLOT_SAY
done
