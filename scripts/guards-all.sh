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
#   {limitFile} (optional).
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
#   commits them. The hash of that file as the run read it goes into the meta: a changed quarantine is never reused. --no-quarantine (the
#   remote runner's own call) neither reads nor writes it: the quarantine belongs to this machine.
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
# usage: guards-all.sh [--force] [--main-checkout] [--local] [--no-quarantine] <worktree>   (a name under worktreeRoot, or a path) -> log in <sharedDir>/guards-<name>.txt
#   A worktree directly under worktreeRoot (by name or by path) logs as guards-<name>.txt; any other path as
#   guards-<basename>-<cksum of its resolved path>.txt, so two worktrees with the same basename never share a log and
#   its reuse record.
H=${0:A:h}
FORCE=0 LOCAL=0 NOQ=0 MAINOK=(); typeset -a POS
for a in "$@"; do if [[ $a == --force ]]; then FORCE=1; elif [[ $a == --local ]]; then LOCAL=1; elif [[ $a == --no-quarantine ]]; then NOQ=1; elif [[ $a == --main-checkout ]]; then MAINOK=(--main-checkout); else POS+=("$a"); fi; done
set -- "${POS[@]}"
[[ -n $1 ]] || { print -u2 "usage: guards-all.sh [--force] [--main-checkout] [--local] [--no-quarantine] <worktree name or path>"; exit 64; }
cfg() { node "$H/config.js" get "$1" 2>/dev/null }
source "$H/slots.zsh" || exit $?
[[ -n $CODIS_WORKTREE_ROOT && -n $CODIS_SHARED_DIR ]] || { print -u2 "guards-all: no project config (.claude/codis-agents.json) found"; exit 78; }
if [[ $1 == /* ]]; then WT=$1; else WT=$CODIS_WORKTREE_ROOT/$1; fi
[[ -d $WT ]] || { print -u2 "guards-all: no worktree $WT"; exit 66; }
node "$H/main-checkout.js" $MAINOK "$WT" || exit $?
NAME=${WT:A:t}
[[ ${WT:A:h} == ${CODIS_WORKTREE_ROOT:A} ]] || NAME=$NAME-${${=$(print -rn -- ${WT:A} | cksum)}[1]}
OUT=$CODIS_SHARED_DIR/guards-$NAME.txt
mkdir -p $CODIS_SHARED_DIR
CMD=$(cfg guardCommand); LEGACY=$(cfg guardCommandLegacy); PFILE=$(cfg guardAdaptiveProbe.file); PTEXT=$(cfg guardAdaptiveProbe.contains)
[[ -n $CMD ]] || { print -u2 "guards-all: guardCommand is not set in the project config"; exit 78; }
# Older branches may carry a runner without the adaptive limit: the probe decides per worktree.
if [[ -n $PFILE ]] && ! grep -qF -- "$PTEXT" "$WT/$PFILE" 2>/dev/null; then CMD=$LEGACY; fi
mode=fixed; [[ $CMD == *'{jobs}'* ]] || mode=whole; [[ $CMD == *'{limitFile}'* ]] && mode=adaptive
kind=full; [[ $mode == whole ]] && kind=whole
RERUN=$(cfg guardRerun); [[ $RERUN == null ]] && RERUN=   # config get prints null for an unset object key
BASELINE=$(cfg guardBaseline)
QFILE=; [[ -n $BASELINE ]] && (( ! NOQ )) && QFILE=$CODIS_SHARED_DIR/guards-quarantine.json
ENVID=local
if (( ! LOCAL )) && RHOST=$(cfg remote.host) && [[ -n $RHOST ]]; then
  if RCMD=$(cfg remoteRun.command) && [[ -n $RCMD ]]; then ENVID=remote:$RHOST CMD=$RCMD
  else print -u2 -r -- "guards-all: note: the machine file names the remote runner $RHOST, but the project config has no remoteRun - the run stays on this machine"; fi
fi
if (( ! FORCE )) && node "$H/guards-result.js" reuse "$WT" "$OUT" "$CMD" "$ENVID" "$QFILE" > /dev/null 2>&1; then
  tail -40 "$OUT"; print -r -- ""; node "$H/guards-result.js" reuse "$WT" "$OUT" "$CMD" "$ENVID" "$QFILE"; exit 0
fi
if [[ $ENVID == remote:* ]]; then
  treq=$(_slot_now)
  node "$H/guards-remote.js" run "$WT" "$OUT" "$NAME"; rc=$?
  # one line of class remote for the whole run (no slot here: acquire = request), in the worktree's name
  ( cd "$WT" 2>/dev/null; SLOT_LABEL="guards-all $NAME on $RHOST" _slot_journal $treq $treq $(_slot_now) remote - full $rc guards-all )
  exit $rc
fi
RCF=$(_slot_tmp guardsrc) || { print -u2 "guards-all: no temporary file in ${TMPDIR:-/tmp} (mktemp failed)"; exit 73; }
trap 'rm -f $RCF' EXIT
while true; do
  : > $RCF
  SLOT_KIND=$kind SLOT_RETRY_RC=75 SLOT_LABEL="guards-all $NAME" slot_run heavy zsh -c '
    source "$1"; WT="$2"; OUT="$3"; CMD="$4"; mode="$5"; RCF="$6"; GR="$7"; RERUN="$8"; BASELINE="$9"; QFILE="${10}"
    cd "$WT" || exit 1
    t0=$EPOCHSECONDS said=0
    while true; do
      p=( $(slot_guard_plan "$SLOT_PATH" $mode start) ); n=$p[1]
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
    node "$GR" meta-start "$WT" "$OUT" "$CMD"
    sub() { local c=$1; c=${c//\{wt\}/${(q)WT}}; c=${c//\{jobs\}/$2}; c=${c//\{limitFile\}/${(q)SLOT_PATH}.limit}; print -r -- $c }
    if [[ $mode == adaptive ]]; then
      print -r -- "workers at start: $n (ceiling $GUARDS_JOBS_ALONE, re-evaluated every $SLOT_POLL s; $SLOT_PATH)"
      { while sleep $SLOT_POLL; do slot_guard_plan "$SLOT_PATH" adaptive run > /dev/null; done } &
      tk=$!
      zsh -c "$(sub "$CMD" $GUARDS_JOBS_ALONE)" > "$OUT" 2>&1; print -r -- $? > "$RCF"
      pkill -P $tk 2>/dev/null; kill $tk 2>/dev/null   # and its sleep - no orphans
    elif [[ $mode == whole ]]; then
      print -r -- "workers: set by the runner itself (guardCommand has no {jobs}), counted as the whole budget $n ($SLOT_PATH)"
      zsh -c "$(sub "$CMD" $n)" > "$OUT" 2>&1; print -r -- $? > "$RCF"
    else
      print -r -- "workers: $n for the whole run (fixed runner; $SLOT_PATH)"
      zsh -c "$(sub "$CMD" $n)" > "$OUT" 2>&1; print -r -- $? > "$RCF"
    fi
    rm -f "$SLOT_PATH.jobs" "$SLOT_PATH.limit" "$SLOT_PATH.limit.tmp" "$SLOT_PATH.limit.active" "$SLOT_PATH.whole"
    tail -25 "$OUT"
    if [[ -n $RERUN ]]; then node "$GR" rerun "$WT" "$OUT" "$(<$RCF)" "$RERUN" "$BASELINE" "$QFILE"; print -r -- $? > "$RCF"; fi
    node "$GR" meta-end "$WT" "$OUT" "$(<$RCF)" "$QFILE"' guards-all "$H/slots.zsh" "$WT" "$OUT" "$CMD" "$mode" "$RCF" "$H/guards-result.js" "$RERUN" "$BASELINE" "$QFILE"
  rc=$?
  [[ -s $RCF ]] && exit $(<$RCF)          # the runner ran: its code
  (( rc == 75 )) || exit $rc              # 75 without a run: no worker budget - queue again
  sleep $SLOT_SAY
done
