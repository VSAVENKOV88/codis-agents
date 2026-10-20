#!/bin/zsh
# Full guard run of one worktree in a heavy slot (slots.zsh). Guards that share a machine resource
# (`// guards:exclusive — <reason>`) are run one at a time by the project's runner through $GUARDS_EXCLUSIVE_LOCK,
# across runs too.
# Workers follow the budget of slots.zsh#slot_guard_plan: all full runs together <= GUARDS_JOBS_ALONE (6); the only
# heavy job -> 6, another heavy job -> <= GUARDS_JOBS_SHARED (3), and never more than what the neighbours leave.
#   Adaptive runner (guardCommand has {limitFile}): the limit is re-evaluated every SLOT_POLL s - a neighbour comes,
#   new guards wait until fewer than the limit run; it leaves, the limit goes back up.
#   Fixed runner (guardCommandLegacy, or guardCommand without {limitFile}): the count is chosen once at start.
#   No budget -> "waiting for workers ..." (inside the slot with an adaptive neighbour; outside it otherwise).
# Queue (slots.zsh, FIFO): a full run waits by ticket as kind "full" - without a budget it does not take the slot, but
#   late single heavy jobs do not pass it either; exit 75 (budget taken after admission) - back to the queue with the
#   same ticket (SLOT_RETRY_RC).
# Command: project config key guardCommand, run with zsh in the worktree; placeholders {wt}, {jobs}, {limitFile}.
# Exit code: the runner's own (the last 25 log lines are printed either way). The runner's code travels through a file,
#   so a runner that itself exits 75 is never mistaken for "no worker budget" and retried.
# usage: guards-all.sh <worktree>   (a name under worktreeRoot, or a path) -> log in <sharedDir>/guards-<name>.txt
H=${0:A:h}
[[ -n $1 ]] || { print -u2 "usage: guards-all.sh <worktree name or path>"; exit 64; }
cfg() { node "$H/config.js" get "$1" 2>/dev/null }
source "$H/slots.zsh" || exit $?
[[ -n $CODIS_WORKTREE_ROOT && -n $CODIS_SHARED_DIR ]] || { print -u2 "guards-all: no project config (.claude/codis-agents.json) found"; exit 78; }
if [[ $1 == /* ]]; then WT=$1; else WT=$CODIS_WORKTREE_ROOT/$1; fi
[[ -d $WT ]] || { print -u2 "guards-all: no worktree $WT"; exit 66; }
NAME=${WT:t}; OUT=$CODIS_SHARED_DIR/guards-$NAME.txt
mkdir -p $CODIS_SHARED_DIR
CMD=$(cfg guardCommand); LEGACY=$(cfg guardCommandLegacy); PFILE=$(cfg guardAdaptiveProbe.file); PTEXT=$(cfg guardAdaptiveProbe.contains)
[[ -n $CMD ]] || { print -u2 "guards-all: guardCommand is not set in the project config"; exit 78; }
# Older branches may carry a runner without the adaptive limit: the probe decides per worktree.
if [[ -n $PFILE ]] && ! grep -qF -- "$PTEXT" "$WT/$PFILE" 2>/dev/null; then CMD=$LEGACY; fi
mode=fixed; [[ $CMD == *'{limitFile}'* ]] && mode=adaptive
RCF=$(mktemp -t guardsrc)
trap 'rm -f $RCF' EXIT
while true; do
  : > $RCF
  SLOT_KIND=full SLOT_RETRY_RC=75 SLOT_LABEL="guards-all $NAME" slot_run heavy zsh -c '
    source "$1"; WT="$2"; OUT="$3"; CMD="$4"; mode="$5"; RCF="$6"
    cd "$WT" || exit 1
    t0=$EPOCHSECONDS said=0
    while true; do
      p=( $(slot_guard_plan "$SLOT_PATH" $mode start) ); n=$p[1]
      (( n > 0 )) && break
      if (( p[2] == 0 )); then
        print -r -- "waiting for workers outside the slot: neighbouring full runs hold the whole budget of $GUARDS_JOBS_ALONE until they end"
        exit 75
      fi
      if (( EPOCHSECONDS - said >= SLOT_SAY )); then
        print -r -- "waiting for workers in the slot ($(( EPOCHSECONDS - t0 )) s): a neighbour is shedding workers to its share"; said=$EPOCHSECONDS
      fi
      sleep $SLOT_POLL
    done
    sub() { local c=$1; c=${c//\{wt\}/${(q)WT}}; c=${c//\{jobs\}/$2}; c=${c//\{limitFile\}/${(q)SLOT_PATH}.limit}; print -r -- $c }
    if [[ $mode == adaptive ]]; then
      print -r -- "workers at start: $n (ceiling $GUARDS_JOBS_ALONE, re-evaluated every $SLOT_POLL s; $SLOT_PATH)"
      { while sleep $SLOT_POLL; do slot_guard_plan "$SLOT_PATH" adaptive run > /dev/null; done } &
      tk=$!
      zsh -c "$(sub "$CMD" $GUARDS_JOBS_ALONE)" > "$OUT" 2>&1; print -r -- $? > "$RCF"
      pkill -P $tk 2>/dev/null; kill $tk 2>/dev/null   # and its sleep - no orphans
    else
      print -r -- "workers: $n for the whole run (fixed runner; $SLOT_PATH)"
      zsh -c "$(sub "$CMD" $n)" > "$OUT" 2>&1; print -r -- $? > "$RCF"
    fi
    rm -f "$SLOT_PATH.jobs" "$SLOT_PATH.limit" "$SLOT_PATH.limit.tmp" "$SLOT_PATH.limit.active"
    tail -25 "$OUT"' guards-all "$H/slots.zsh" "$WT" "$OUT" "$CMD" "$mode" "$RCF"
  rc=$?
  [[ -s $RCF ]] && exit $(<$RCF)          # the runner ran: its code
  (( rc == 75 )) || exit $rc              # 75 without a run: no worker budget - queue again
  sleep $SLOT_SAY
done
