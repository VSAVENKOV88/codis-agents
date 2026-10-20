#!/bin/zsh
# The ticket of the project's shared stand: one Docker stack (config section "stand") that tasks take in turn instead
# of each building its own. The plugin holds the ticket and calls the project's commands (scripts/stand.js fills their
# placeholders); what the commands do is the project's.
#
# usage: stand.sh take [--wt <dir>]       - wait for the ticket in the queue and HOLD it: this process is the holder
#                                           and keeps running until release (start it with run_in_background; the
#                                           line "ticket taken by <wt>" says it is yours). Refused (69) while the
#                                           stand is not up (its status command fails); nothing is held then.
#        stand.sh deploy [<wt>]           - the holder's worktree only: the project's deploy {wt} in a medium slot
#        stand.sh reset                   - the holder's worktree only: the project's reset
#        stand.sh release [--force]       - the holder's worktree only (--force: the coordinator, any worktree, written
#                                           to the journal): reset while still held, then the ticket is free
#        stand.sh status                  - the stand (its status command), the ticket (holder, since when, how long),
#                                           the queue
#        stand.sh up | down [--force]     - the coordinator: the project's up / down (down refused while held)
#        stand.sh image-diff --base <ref> [--wt <dir>]
#                                         - do the worktree's commits since <ref> touch the stand's image files
#                                           (stand.imageFiles)? exit 0 no (the stand fits), 1 yes (own stack), 2 error
# The worktree is the argument of deploy or --wt, else the nearest directory with .git above the working directory.
# deploy, reset and release for another worktree than the holder's are refused (77): "the ticket is held by <wt>". This
# guards against mistakes of cooperating agents (a wrong worktree, a stale holder), not against a hostile one.
#
# How the ticket works (the memory slots of slots.zsh, one class more):
#  * Exactly one ticket: <SLOTS_DIR>/stand.lock, held by the holder process itself with zsystem flock (fcntl) - the
#    process dies (kill -9 too), the kernel drops the lock. <SLOTS_DIR>/stand.lock.who says who holds it:
#    "stand <pid> <acquire> <request> <worktree>" (the first two fields as in a slot's .who, so
#    role-leftovers-check.js names the ticket next to the holder; the holder's cwd is its worktree, so the post-check
#    finds and stops it).
#  * Waiters queue with the tickets of slots.zsh (class stand, own queue, shared numbers; a stand ticket never counts as
#    "the other queue" of medium/heavy) and say "waiting for the stand ticket <project>, position N in queue" at least
#    every SLOT_SAY s. A dead waiter's ticket is removed by the next waiter.
#  * The project's reset runs before the ticket is given (the previous holder may have died without one) and at
#    release, both while the ticket is held. A failing reset at issue gives no ticket.
#  * No idle limit: a limit without data would be a guess. The ticket is freed by release, by the holder's death, by
#    the leftovers post-check at the end of a task and by release --force; how long it was held is in status and in
#    the journal.
#  * The stand holds no memory slot (its memory is the stand's own, fixed ceiling, stand.memLimitMB); deploy runs in a
#    medium slot (an archive and a restart, no image build).
#  * Journal (slots.zsh, v1): one line per hold with class "stand", slot 1, kind = release | force | term (stopped by a
#    signal, rc 143) | dead (found dead by the next holder or a release; release time = when found, rc "-") |
#    refused (the reset or status failed at issue) | waiting (stopped before it got the ticket, acquire "-").
H=${0:A:h}
source "$H/slots.zsh" || exit $?
_st_err=$(node "$H/stand.js" check 2>&1) || { print -u2 -r -- "$_st_err"; exit 78 }
PROJECT=$(node "$H/stand.js" get project)
MEMLIM=$(node "$H/stand.js" get memLimitMB)
LOCK=$SLOTS_DIR/stand.lock WHO=$SLOTS_DIR/stand.lock.who REL=$SLOTS_DIR/stand.release
mkdir -p $SLOTS_DIR/queue
: >> $LOCK; : >> $SLOTS_DIR/admit.lock; : >> $SLOTS_DIR/queue.lock

# _st_cmd <name> [wt] - the project's command, with zsh in repoDir; its exit code.
_st_cmd() {
  local c; c=$(node "$H/stand.js" cmd $1 ${2:+--wt} ${2:+"$2"}) || return 78
  ( cd -- "$CODIS_REPO_DIR" || exit 66; zsh -c "$c" )
}
# Is the ticket free right now (a lock attempt in a subshell: its fd closes with it, the holder's lock is untouched).
_st_lockfree() { ( zsystem flock -t 0 -f _f $LOCK ) 2>/dev/null }
# _st_who -> W_PID W_TACQ W_TREQ W_WT from the holder file; 1 when there is none.
_st_who() {
  [[ -s $WHO ]] || return 1
  local l=$(<$WHO); local w=( ${(s: :)l} )
  W_PID=$w[2] W_TACQ=$w[3] W_TREQ=$w[4] W_WT="${(j: :)w[5,-1]}"
}
# held | dead (no lock, a holder file left) | free
_st_state() { if ! _st_lockfree; then print held; elif [[ -s $WHO ]]; then print dead; else print free; fi }
# _st_journal <request> <acquire> <release> <kind> <pid> <rc> <worktree> - one v1 line (slots.zsh format), errors ignored.
_st_journal() {
  [[ -n $SLOT_JOURNAL ]] || return 0
  local line="v1"$'\t'$1$'\t'$2$'\t'$3$'\t'stand$'\t'1$'\t'$4$'\t'$5$'\t'$6$'\t'"${7//[$'\t\n']/ }"$'\t'"stand $PROJECT"
  { syswrite -- "$line"$'\n' >> $SLOT_JOURNAL } 2>/dev/null
  return 0
}
# Under admit.lock, the ticket free: a holder file left by a dead holder -> its journal line, the file removed.
_st_reap() { _st_who || return 1; _st_journal $W_TREQ $W_TACQ $(_slot_now) dead $W_PID - "$W_WT"; rm -f $WHO; return 0 }
_st_since() { print -r -- "$(strftime '%Y-%m-%d %H:%M:%S' ${1%.*}), $(( EPOCHSECONDS - ${1%.*} )) s" }
_st_wt() { local w=${1:-$(_slot_wt)}; [[ -d $w ]] || { print -u2 -r -- "stand: no directory $w"; return 66 }; print -r -- ${w:A} }
# _st_need_holder <worktree> - the ticket is held by exactly this worktree, else the refusal (77).
_st_need_holder() {
  if [[ $(_st_state) != held ]] || ! _st_who; then
    print -u2 -r -- "stand: refused - the ticket of $PROJECT is not taken; take it first (stand.sh take, kept running)"; return 77
  fi
  [[ $W_WT == $1 ]] && return 0
  print -u2 -r -- "stand: refused - the ticket is held by $W_WT (pid $W_PID), not by $1"; return 77
}

st_take() {
  local wt=$1 out rc
  out=$(_st_cmd status 2>&1); rc=$?
  if (( rc )); then
    print -u2 -r -- "stand: refused - the stand $PROJECT is not up (status exit $rc)${out:+: $out}. It is brought up by the coordinator (stand.sh up); nothing is held."
    return 69
  fi
  if [[ $(_st_state) == held ]] && _st_who && [[ $W_WT == $wt ]]; then
    print -r -- "stand $PROJECT: this worktree already holds the ticket (pid $W_PID, since $(_st_since $W_TACQ)); nothing changed"; return 0
  fi
  cd -- $wt || return 66            # the holder's cwd is its worktree: the leftovers post-check finds it there
  G_WT=$wt G_GOT=0 G_TREQ=$(_slot_now) G_TACQ= G_QF= SFD=
  local qnum= pos=0 why afd t0=$EPOCHSECONDS said=0
  trap _st_signal INT TERM HUP
  _slot_q_take "" stand single "$wt" && { G_QF=$SLOT_QF; qnum=$(( 10#${G_QF:t} )); }
  while true; do
    if zsystem flock -t 30 -i 0.1 -f afd $SLOTS_DIR/admit.lock; then
      _slot_q_clean
      if [[ -z $G_QF || ! -e $G_QF ]]; then _slot_q_take "$qnum" stand single "$wt" && { G_QF=$SLOT_QF; qnum=$(( 10#${G_QF:t} )); }; fi
      if [[ -z $G_QF ]]; then pos=0 why="no ticket - the queue lock (queue.lock) is busy"
      else
        _slot_q_where $G_QF stand; pos=$SLOT_QPOS
        if (( pos > 1 )); then why="$(( pos - 1 )) ahead"
        elif zsystem flock -t 0 -f SFD $LOCK 2>/dev/null; then
          G_TACQ=$(_slot_now) G_GOT=1
          _st_reap                     # the previous holder died without a release
          print -r -- "stand $$ $G_TACQ $G_TREQ $wt" > $WHO.tmp && mv -f $WHO.tmp $WHO
          rm -f $G_QF; G_QF=
        elif _st_who; then why="held by $W_WT (pid $W_PID) since $(_st_since $W_TACQ)"
        else why="held"
        fi
      fi
      zsystem flock -u $afd
      (( G_GOT )) && break
    else why="admission lock busy"; fi
    if (( EPOCHSECONDS - said >= SLOT_SAY )); then
      print -r -- "waiting for the stand ticket $PROJECT, position $pos in queue ($(( EPOCHSECONDS - t0 )) s): $why"; said=$EPOCHSECONDS
    fi
    sleep $SLOT_POLL
  done
  out=$(_st_cmd status 2>&1); rc=$?
  (( rc )) && { print -u2 -r -- "stand: refused - the stand $PROJECT went down while waiting (status exit $rc)${out:+: $out}"; _st_end refused 69; }
  print -r -- "stand $PROJECT: ticket acquired, resetting the stand before it is given"
  _st_cmd reset; rc=$?
  (( rc )) && { print -u2 -r -- "stand: reset failed (exit $rc) - the ticket is not given and is free again"; _st_end refused $rc; }
  print -r -- "stand $PROJECT: ticket taken by $wt (pid $$) at $(strftime '%Y-%m-%d %H:%M:%S' ${G_TACQ%.*}). Deploy: stand.sh deploy; release: stand.sh release. The ticket lives as long as this process."
  while true; do sleep 1; done
}
# The holder ends: its file removed, its journal line, exit (the kernel frees the ticket with the process).
_st_end() {
  if _st_who && [[ $W_PID == $$ ]]; then rm -f $WHO; fi
  _st_journal $G_TREQ $G_TACQ $(_slot_now) $1 $$ $2 "$G_WT"
  exit $2
}
_st_signal() {
  if (( G_GOT )); then
    local kind=term rc=143 r
    if [[ -s $REL ]]; then r=( $(<$REL) ); [[ $r[2] == $$ ]] && kind=$r[1] rc=0; fi
    _st_end $kind $rc
  fi
  [[ -n $G_QF ]] && rm -f $G_QF
  _st_journal $G_TREQ - $(_slot_now) waiting $$ 143 "$G_WT"
  exit 143
}

st_release() {
  local wt=$1 force=$2 afd msg= rcr i
  zsystem flock -t 30 -i 0.1 -f afd $SLOTS_DIR/admit.lock || { print -u2 "stand: the admission lock is busy - try again"; return 75 }
  if [[ $(_st_state) != held ]]; then
    _st_reap && msg=" (its holder pid $W_PID of $W_WT had died)"
    zsystem flock -u $afd
    print -r -- "stand $PROJECT: the ticket is free$msg"; return 0
  fi
  _st_who; zsystem flock -u $afd
  [[ -n $W_PID ]] || { print -u2 "stand: the ticket is held but its holder file is not written yet - try again"; return 75 }
  if [[ $W_WT != $wt ]] && (( ! force )); then
    print -u2 -r -- "stand: refused - the ticket is held by $W_WT (pid $W_PID); only its holder releases it (the coordinator: stand.sh release --force)"; return 77
  fi
  local pid=$W_PID tacq=$W_TACQ hwt=$W_WT
  print -r -- "${${force:#0}:+force}${${force:#1}:+release} $pid $wt" > $REL
  print -r -- "stand $PROJECT: resetting before the ticket is free"
  _st_cmd reset; rcr=$?
  kill -TERM $pid 2>/dev/null
  for i in {1..300}; do _st_lockfree && break; sleep 0.1; done
  _st_lockfree || { kill -KILL $pid 2>/dev/null; for i in {1..50}; do _st_lockfree && break; sleep 0.1; done }
  rm -f $REL
  if (( rcr )); then print -u2 -r -- "stand: reset failed at release (exit $rcr); the ticket is free, the next take resets again"; return $rcr; fi
  print -r -- "stand $PROJECT: released${${force:#0}:+ (--force)} by $wt; held by $hwt for $(( EPOCHSECONDS - ${tacq%.*} )) s"
}

st_status() {
  local out rc f t n=0 lines=()
  out=$(_st_cmd status 2>&1); rc=$?
  print -r -- "stand $PROJECT: $( (( rc )) && print -r -- "down (status exit $rc)" || print up )${MEMLIM:+, memory limit $MEMLIM MB}"
  [[ -n $out ]] && print -r -- "  ${out//$'\n'/$'\n'  }"
  case $(_st_state) in
    held) if _st_who; then print -r -- "ticket: held by $W_WT (pid $W_PID) since $(_st_since $W_TACQ)"; else print -r -- "ticket: held (holder file not written yet)"; fi ;;
    dead) _st_who; print -r -- "ticket: free (its holder pid $W_PID of $W_WT died; the next take resets the stand first)" ;;
    *) print -r -- "ticket: free" ;;
  esac
  for f in $SLOTS_DIR/queue/<->(N); do
    t=( ${(s: :)$(<$f)} )
    [[ $t[1] == stand ]] && kill -0 $t[2] 2>/dev/null || continue
    lines+=( "$(( ++n )). ${(j: :)t[5,-1]} (pid $t[2], ticket ${f:t})" )
  done
  if (( n )); then print -r -- "queue: $n waiting: ${(pj:\n                  :)lines}"; else print -r -- "queue: empty"; fi
  return 0
}

cmd=$1; shift 2>/dev/null
OPT_WT= OPT_FORCE=0 POS=()
while (( $# )); do
  case $1 in
    --wt) OPT_WT=$2; shift 2 ;;
    --force) OPT_FORCE=1; shift ;;
    *) POS+=( "$1" ); shift ;;
  esac
done
case $cmd in
  take) W=$(_st_wt "$OPT_WT") || exit $?; st_take "$W"; exit $? ;;
  release) W=$(_st_wt "$OPT_WT") || exit $?; st_release "$W" $OPT_FORCE; exit $? ;;
  reset) W=$(_st_wt "$OPT_WT") || exit $?; _st_need_holder "$W" || exit $?; _st_cmd reset; exit $? ;;
  deploy)
    W=$(_st_wt "${POS[1]:-$OPT_WT}") || exit $?
    _st_need_holder "$W" || exit $?
    c=$(node "$H/stand.js" cmd deploy --wt "$W") || exit 78
    cd -- $W || exit 66
    SLOT_LABEL="stand deploy ${W:t}" slot_run medium zsh -c 'cd -- "$1" || exit 66; eval "$2"' stand-deploy "$CODIS_REPO_DIR" "$c"
    exit $? ;;
  status) st_status; exit $? ;;
  up) _st_cmd up; exit $? ;;
  down)
    if [[ $(_st_state) == held ]] && (( ! OPT_FORCE )); then _st_who; print -u2 -r -- "stand: refused - the ticket is held by $W_WT (pid $W_PID); down --force to take the stand down anyway"; exit 77; fi
    _st_cmd down; exit $? ;;
  image-diff) exec node "$H/stand.js" image-diff ${OPT_WT:+--wt} ${OPT_WT:+"$OPT_WT"} "${POS[@]}" ;;
  *) print -u2 "usage: stand.sh take|deploy [<wt>]|reset|release [--force]|status|up|down [--force]|image-diff --base <ref> [--wt <dir>]"; exit 64 ;;
esac
