# Memory slots for heavy jobs on one machine shared by several agents.
# Sourced by heavy.sh / medium.sh / guards-all.sh / stand.sh:  source slots.zsh || exit $?; slot_run <medium|heavy> <cmd...>
# (sourcing returns 78 when the project config does not validate: see below).
#
# Classes: medium - SLOT_MEDIUM_N slots (default 2: tsc, a plugin build, one bundler build without a browser);
#          heavy  - SLOT_HEAVY_N slots (default 2), one more only while free memory holds and swap does not grow;
#          medium + heavy together (with the optional legacy lock) <= SLOT_TOTAL_MAX (default 4).
# A slot is a file <SLOTS_DIR>/<class>.<i>.lock held with `zsystem flock` (fcntl, zsh/system; the same on macOS and
# Linux) for the whole command. The HOLDER is a small zsh that takes the lock (-t 0: busy - exit 75, "lost the race"),
# writes the got-file, runs the command as its CHILD, waits for it and exits with its code. Measured on macOS
# (experiments E1-E3 of the U1 analysis): the holder dies (kill -9 too) - the kernel drops the lock, and the command it
# leaves behind does not hold the slot (neither did the children of lockf -k before); the command opening and closing
# its slot file in its own process does not drop the lock (fcntl locks belong to the process that took them). Rule:
# the holder never opens its own slot file in its own process after taking the lock - closing any descriptor of that
# file drops an fcntl lock (man zshmodules); so the command is never exec-ed in place of the holder.
# The slot is chosen under a short admission lock (zsystem flock on admit.lock), so two waiters cannot count the same
# "free" and overshoot the ceiling.
# The EXCLUSIVE lock (GUARDS_EXCLUSIVE_LOCK, guards marked `guards:exclusive`) is different: it is a flock(2) lock by
# contract, because the project's own guard runner takes the same file with lockf(1) (macOS) or flock(1) (Linux), and
# on Linux flock(2) and fcntl locks do not see each other. slot_exclusive_run takes it with the first executable of
# SLOT_EXCL_TOOLS (default /usr/bin/lockf /usr/bin/flock /bin/flock; a name ending in "flock" is called as flock(1),
# anything else as lockf(1)); none - one refusal line, code 72.
# Requirements checked when this file is sourced: ps and pgrep (procps: live queue tickets, stopping a command tree);
# missing - one refusal line, code 72 (EX_OSFILE), never a silent cleaning of every ticket as dead.
# Temporary files use a template with XXXXXX in ${TMPDIR:-/tmp} (BSD and GNU mktemp alike; GNU refuses `-t name`).
# Legacy: while SLOT_LEGACY_LOCK (a single shared lock of an older setup) is held, it counts as one busy heavy slot.
#
# THRESHOLDS COME FROM MEASUREMENT (16 GB macOS machine, ~20k samples every 15 s over five days):
#  * macOS swap grows in 1 GB files under /System/Volumes/VM, so "free" in vm.swapusage is only what is left in the
#    current files. Swap capacity = that rest + free space of the VM volume (df). Any slot needs SLOT_SWAP_MIN_MB = 4096:
#    the ceiling is 4 slots x ~1 GB (bundler + Chromium is about 1 GB), so even if everything goes to swap there is room.
#  * The extra heavy slot: memory_pressure "free percentage" >= SLOT_THIRD_FREE_PCT (50) as the MINIMUM over a window,
#    not one reading. Under load the mean was 52-55 % and the minimum 29-31 %; one heavy job is ~1 GB, ~6 % of 16 GB,
#    so from 50 % at least 44 % stays, ~13 points above the observed minimum. Under three full guard runs free memory
#    swung 30 <-> 55 % within 15 s; a single reading let the extra slot in at a 43 % mean. Hence the minimum and a long
#    window.
#  * And swap must not grow over the window: the monotonic Swapouts counter (vm_stat, pages x page size) grows by
#    <= SLOT_THIRD_SWAP_GROW_MB (256) and used(now) - used(window start) <= 256 MB. "used minus the window minimum"
#    lied: used dips for a moment (21.4 -> 19.7 GB) and 3.4 GB of growth in 5 minutes showed as <= 0. At rest Swapouts
#    stands still; under three full runs used grew ~0.7 GB/min.
#  * Window SLOT_THIRD_WINDOW = 300 s: the failing run gathered 3.4 GB of swap in 5 minutes, while the free-memory swings
#    take tens of seconds; the window covers several swings. History is written only while somebody waits for the
#    extra slot (every SLOT_POLL), so the window must be covered by samples with no gap > SLOT_HIST_GAP (30 s);
#    otherwise the answer is "unknown" and the extra slot is refused until history accumulates.
# All thresholds and sources come from the environment, so tests/slots-check.sh can check them on a fake machine.
#
# Settings: environment first, then the project config (.claude/codis-agents.json, key "slots"), then the defaults.
#
# JOURNAL: every slot hold appends ONE line to SLOT_JOURNAL (default <SLOTS_DIR>/journal.tsv; empty - off), so that the
# time agents spend queueing for a slot can be told apart from the time the heavy jobs themselves take
# (scripts/slot-journal.js sums it up). Tab-separated, one record per hold, written when the hold ends:
#   v1  request  acquire  release  class  slot  kind  pid  rc  worktree  command
#   request/acquire/release - epoch seconds with milliseconds (acquire "-": never got the slot, e.g. killed while
#   waiting); class medium|heavy|exclusive; slot - its number (exclusive: "-"); kind single|full|whole; pid of the waiter;
#   rc - exit code; worktree - the nearest directory with .git above the working directory (else the directory);
#   command - at most 6 words, each cut to 40 characters, words with "=" (environment, --key=value) masked as "name=*".
# queue wait = acquire - request, hold = release - acquire. A retry with the same ticket (SLOT_RETRY_RC) is a new record
# whose request is the previous release. The line goes out in one write(2) on an O_APPEND file (atomic between
# writers); any error of the write is ignored - the journal never stops or fails a slot. SLOT_LABEL=<text> replaces the
# command shown (wrappers such as guards-all.sh name the real job).

zmodload zsh/system zsh/datetime
_SLOTS_HERE=${${(%):-%x}:A:h}
# ps (start time of a waiter: is its ticket alive) and pgrep (the command tree on TERM) - procps on Linux.
() {
  local t miss=()
  for t in ps pgrep; do (( $+commands[$t] )) || miss+=$t; done
  (( ${#miss} )) || return 0
  print -u2 -r -- "codis-agents slots: refused - ${(j: and :)miss} not found in PATH (ps tells live queue tickets from dead ones, pgrep stops a command tree); install procps (Debian/Ubuntu: apt-get install procps)"
  return 72
} || return 72
# A project config that exists but does not validate is a refusal, never a silent default: falling back to
# ~/.cache/codis-agents/slots made a second, separate queue whose waiters did not see the first one's (one unknown key
# in the config was enough), and the memory ceiling of the machine no longer held. No config at all keeps the defaults.
if _slot_cfgf=$(node "$_SLOTS_HERE/config.js" path 2>/dev/null); then
  if _slot_cfg=$(node "$_SLOTS_HERE/config.js" shell "$_slot_cfgf" 2>/dev/null); then eval "$_slot_cfg"
  else
    print -u2 -r -- "codis-agents slots: refused - the project config does not validate, so the slot directory is unknown (no fallback to another directory):"
    node "$_SLOTS_HERE/config.js" check "$_slot_cfgf" >&2
    unset _slot_cfg _slot_cfgf
    return 78
  fi
fi
unset _slot_cfg _slot_cfgf
: ${SLOTS_DIR:=$HOME/.cache/codis-agents/slots}
[[ -v SLOT_LEGACY_LOCK ]] || SLOT_LEGACY_LOCK=
: ${SLOT_MEDIUM_N:=2}
: ${SLOT_HEAVY_N:=2}
: ${SLOT_POLL:=5}                 # pause between attempts, s
: ${SLOT_SAY:=30}                 # "waiting for slot ..." at least this often, s (an agent silent for 10 min is killed)
: ${SLOT_SWAP_MIN_MB:=4096}
: ${SLOT_THIRD_FREE_PCT:=50}
: ${SLOT_THIRD_SWAP_GROW_MB:=256}
: ${SLOT_THIRD_WINDOW:=300}
: ${SLOT_HIST_GAP:=30}
: ${SLOT_TOTAL_MAX:=4}
: ${GUARDS_JOBS_ALONE:=6}          # workers of a full guard run while it is the only heavy job
: ${GUARDS_JOBS_SHARED:=3}         # ... while at least one more heavy slot is busy
: ${GUARDS_EXCLUSIVE_LOCK:=$SLOTS_DIR/exclusive.lock}
: ${SLOT_EXCL_TOOLS:=/usr/bin/lockf /usr/bin/flock /bin/flock}   # flock(2) utilities for the exclusive lock, first found
# Which guards are exclusive (project config key guardExclusive; config.js has the same default): zsh patterns of the
# file name, one per line, and the line-comment marker. Not exported: a child shell reads its own project's config.
[[ -v GUARDS_EXCL_GLOB ]] || GUARDS_EXCL_GLOB=$'*-run.js\n*-run.mjs'
: ${GUARDS_EXCL_MARKER:=//}
# Exported so that child shells (which source this file again, possibly from another directory) agree.
[[ -v SLOT_JOURNAL ]] || SLOT_JOURNAL=$SLOTS_DIR/journal.tsv
export GUARDS_EXCLUSIVE_LOCK SLOTS_DIR SLOT_JOURNAL SLOT_LEGACY_LOCK SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED
mkdir -p "$SLOTS_DIR"
_SLOT_HEAVY_MAX=$(( SLOT_HEAVY_N + 1 ))

# -- Journal ---------------------------------------------------------------------------------------------------------
# _slot_wt -> the nearest directory with .git (a file in linked worktrees) above $PWD, else $PWD; no processes forked.
_slot_wt() { local d=$PWD; while [[ $d != / && -n $d ]]; do [[ -e $d/.git ]] && { print -r -- $d; return }; d=${d:h}; done; print -r -- $PWD }
# _slot_cmd <words...> -> a short, secret-free command line for the journal.
_slot_cmd() {
  local w out=() n=0
  for w; do
    (( ++n > 6 )) && { out+=('...'); break }
    w=${w//[$'\t\n\r']/ }
    [[ $w == *=* ]] && w="${w%%=*}=*"
    (( ${#w} > 40 )) && w="${w[1,39]}~"
    out+=("$w")
  done
  print -r -- "${(j: :)out}"
}
# _slot_journal <request> <acquire> <release> <class> <slot> <kind> <rc> <command words...> - one line, errors ignored.
_slot_journal() {
  [[ -n $SLOT_JOURNAL ]] || return 0
  local req=$1 acq=$2 rel=$3 class=$4 slot=$5 kind=$6 rc=$7 cmd; shift 7
  cmd=${SLOT_LABEL:+$(_slot_cmd ${=SLOT_LABEL})}; [[ -n $cmd ]] || cmd=$(_slot_cmd "$@")
  local line="v1"$'\t'$req$'\t'$acq$'\t'$rel$'\t'$class$'\t'$slot$'\t'$kind$'\t'$sysparams[pid]$'\t'$rc$'\t'"${$(_slot_wt)//[$'\t\n']/ }"$'\t'$cmd
  { syswrite -- "$line"$'\n' >> $SLOT_JOURNAL } 2>/dev/null
  return 0
}
# Epoch seconds with milliseconds; no printf (it writes "," under a locale with a decimal comma).
_slot_now() { local t=${EPOCHREALTIME/,/.}; print -r -- ${t%%.*}.${${t#*.}[1,3]} }

# Busy: an fcntl lock is held on the file. The probe runs in a subshell (its own process): taking and dropping the lock
# there never touches a lock of this process. zsystem flock -t 0: 0 - free (taken, dropped on exit), 1 - busy.
_slot_busy() { [[ -n $1 && -e $1 ]] || return 1; ( zsystem flock -t 0 -f _slot_probe_fd "$1" ) 2>/dev/null; (( $? == 1 )) }
# A lock this user cannot open for writing -> its path in $SLOT_BAD (return 0). zsystem flock opens the file for
# writing, and a failed open returns 1 - the same code as "busy": a slot file left by sudo (or by root in a container
# over a shared slot directory) counted as busy forever, an unwritable admit.lock was "admission lock busy" forever, and
# the job never got a slot and never learned why. The slot directory and its queue need writing too (files are created
# there). File tests only, no processes forked: it runs on every poll.
_slot_unwritable() {
  local f; SLOT_BAD=
  for f in $SLOTS_DIR $SLOTS_DIR/queue $SLOTS_DIR/admit.lock $SLOTS_DIR/queue.lock $SLOTS_DIR/medium.<->.lock(N) \
    $SLOTS_DIR/heavy.<->.lock(N) $SLOT_LEGACY_LOCK; do
    [[ -e $f && ! -w $f ]] && { SLOT_BAD=$f; return 0 }
  done
  return 1
}
_slot_unwritable_say() {
  print -u2 -r -- "slot_run: refused - $SLOT_BAD is not writable for this user (uid $UID): a slot lock is opened for writing, so it would count as busy forever; fix its owner or mode (left by sudo or by root in a container?)"
}
# A temporary file from a template (BSD and GNU mktemp).
_slot_tmp() { mktemp "${${TMPDIR:-/tmp}%/}/$1.XXXXXX" }

_slot_swap_free_mb() {
  local f d
  f=$(sysctl -n vm.swapusage | awk '{for(i=1;i<=NF;i++) if($i=="free"){v=$(i+2); gsub("M","",v); gsub(",",".",v); printf "%d", v}}')
  d=$(df -m /System/Volumes/VM 2>/dev/null | awk 'NR==2{print $4}')
  print -r -- $(( ${f:-0} + ${d:-0} ))
}
_slot_swap_used_mb() {
  sysctl -n vm.swapusage | awk '{for(i=1;i<=NF;i++) if($i=="used"){v=$(i+2); gsub("M","",v); gsub(",",".",v); printf "%d", v}}'
}
_slot_free_pct() {
  memory_pressure 2>/dev/null | awk -F': ' '/free percentage/{gsub("%","",$2); print $2+0}'
}
# Monotonic swap-out counter in MB (pages x page size from the vm_stat header).
_slot_swapouts_mb() {
  vm_stat | awk '/page size of/{for(i=1;i<=NF;i++) if($i=="of") ps=$(i+1)} /^Swapouts:/{gsub("\\.","",$2); so=$2}
    END{printf "%d", so*ps/1048576}'
}

# Memory history: "epoch free% used_MB swapouts_MB" in <SLOTS_DIR>/mem.hist, last 15 minutes kept.
# Prints "min_free% swapouts_growth_MB used_growth_MB" over the window, or "?" when the window is not covered by
# samples without gaps.
_slot_third_stats() {
  local now=$EPOCHSECONDS h=$SLOTS_DIR/mem.hist pct used so
  pct=$(_slot_free_pct); used=$(_slot_swap_used_mb); so=$(_slot_swapouts_mb)
  print -r -- "$now ${pct:-0} ${used:-0} ${so:-0}" >> $h
  sort -n -k1,1 $h | awk -v now=$now -v win=$SLOT_THIRD_WINDOW -v gap=$SLOT_HIST_GAP '
    { t[++n]=$1; p[n]=$2; u[n]=$3; s[n]=$4 }
    END {
      # walk back from now without gaps > gap; the base is the newest sample not later than now-win
      base=0
      for (i=n; i>=1; i--) {
        if (i<n && t[i+1]-t[i] > gap) break
        if (t[i] <= now-win) { base=i; break }
      }
      if (!base) { print "?"; exit }
      min=p[base]; for (i=base; i<=n; i++) if (p[i]<min) min=p[i]
      printf "%d %d %d\n", min, s[n]-s[base], u[n]-u[base]
    }'
  awk -v now=$now '$1 >= now-900' $h > $h.tmp 2>/dev/null && mv -f $h.tmp $h
}

# Admission decision: the slot path goes to $SLOT_PICK (empty - refused), the reason to $SLOT_WHY.
# Busy medium/heavy counts go to $SLOT_M / $SLOT_H (the queues need them: "last slot of the ceiling", see slot_run).
_slot_pick() {
  local class=$1 m=0 h=0 legacy=0 f i swapfree
  SLOT_PICK= SLOT_WHY=
  for i in {1..$SLOT_MEDIUM_N}; do _slot_busy $SLOTS_DIR/medium.$i.lock && (( m++ )); done
  for i in {1..$_SLOT_HEAVY_MAX}; do _slot_busy $SLOTS_DIR/heavy.$i.lock && (( h++ )); done
  _slot_busy "$SLOT_LEGACY_LOCK" && legacy=1
  (( h += legacy ))
  SLOT_M=$m SLOT_H=$h
  swapfree=$(_slot_swap_free_mb)
  if (( swapfree < SLOT_SWAP_MIN_MB )); then SLOT_WHY="swap: capacity ${swapfree} MB < ${SLOT_SWAP_MIN_MB}"; return; fi
  if (( m + h >= SLOT_TOTAL_MAX )); then SLOT_WHY="busy: medium $m + heavy $h = ceiling $SLOT_TOTAL_MAX"; return; fi
  if [[ $class == medium ]]; then
    for i in {1..$SLOT_MEDIUM_N}; do f=$SLOTS_DIR/medium.$i.lock; _slot_busy $f || { SLOT_PICK=$f; return; }; done
    SLOT_WHY="all $SLOT_MEDIUM_N medium slots busy"; return
  fi
  if (( h >= _SLOT_HEAVY_MAX )); then SLOT_WHY="all $_SLOT_HEAVY_MAX heavy slots busy"; (( legacy )) && SLOT_WHY+=" (including the legacy lock)"; return; fi
  if (( h == SLOT_HEAVY_N )); then
    local st=( $(_slot_third_stats) )
    if [[ $st[1] == '?' ]]; then SLOT_WHY="$h heavy busy; extra slot: memory history still accumulating (${SLOT_THIRD_WINDOW} s)"; return; fi
    if (( st[1] < SLOT_THIRD_FREE_PCT )); then SLOT_WHY="$h heavy busy; extra slot: free ${st[1]}% < ${SLOT_THIRD_FREE_PCT}% (minimum over ${SLOT_THIRD_WINDOW} s)"; return; fi
    if (( st[2] > SLOT_THIRD_SWAP_GROW_MB )); then SLOT_WHY="$h heavy busy; extra slot: swap - ${st[2]} MB swapped out in ${SLOT_THIRD_WINDOW} s"; return; fi
    if (( st[3] > SLOT_THIRD_SWAP_GROW_MB )); then SLOT_WHY="$h heavy busy; extra slot: swap grew by ${st[3]} MB in ${SLOT_THIRD_WINDOW} s"; return; fi
  fi
  for i in {1..$_SLOT_HEAVY_MAX}; do f=$SLOTS_DIR/heavy.$i.lock; _slot_busy $f || { SLOT_PICK=$f; return; }; done
  SLOT_WHY="no free slot file"
}

# -- Waiting queue (FIFO) -------------------------------------------------------------------------------------------
# Without a queue the slot went to whoever polled first: a late waiter overtook one that had waited for 15 minutes, and
# a full run without a worker budget left the slot and queued again while single heavy jobs slipped past it.
# A waiter takes a ticket: file <SLOTS_DIR>/queue/<number, 10 digits> "class pid pid_start_time kind" (the number comes
# from the counter queue.seq; both are written only under queue.lock). There are two queues, one per class (medium,
# heavy), with shared numbers. Only the FIRST live ticket of its class may take a slot; those behind it wait even if
# they would pass:
#  * when the first is a full run (SLOT_KIND=full, guards-all.sh) with no worker budget and no adaptive neighbour
#    (slot_guard_plan would return "0 0"), it does not take the slot, but single heavy jobs behind it do not pass
#    either: it is never starved;
#  * the first of its class may take the last slot of the shared ceiling (medium + heavy = SLOT_TOTAL_MAX - 1) only if
#    the first of the OTHER queue with a smaller number cannot take it right now.
# Any waiter removes tickets of dead waiters (no pid, or the pid was reused - a different start time) under admit.lock;
# on TERM/INT/HUP a trap removes its own ticket. SLOT_RETRY_RC=<code>: the command exited with that code - back to the
# queue with the SAME number (guards-all.sh: 75 - the budget was taken between admission and start).

_slot_pstart() { local s; s=$(LC_ALL=C ps -o lstart= -p $1 2>/dev/null) || return 1; print -r -- ${(j::)${=s}} }

# Under admit.lock: remove tickets of dead waiters.
_slot_q_clean() {
  local f t
  for f in $SLOTS_DIR/queue/<->(N); do
    t=( $(<$f) )
    [[ -n $t[2] ]] && kill -0 $t[2] 2>/dev/null && [[ "$(_slot_pstart $t[2])" == $t[3] ]] && continue
    rm -f $f
  done
}

# Ticket (number $1 or a new one; $4 - optional extra field, the worktree of a stand ticket) -> path in $SLOT_QF. Under its own short lock queue.lock, not admit.lock: admit.lock
# is held while a slot is chosen (memory_pressure, ps, the busy probes - up to a second), and a waiter that came earlier but hit
# it got a number after the one that came next. The ticket file goes through tmp + mv: the cleaner (under admit.lock)
# never sees a half-written ticket and never takes it for a dead one.
_slot_q_take() {
  local num=$1 class=$2 kind=$3 extra=$4 pid=$sysparams[pid] seq=0 qfd tmp
  zsystem flock -t 30 -i 0.02 -f qfd $SLOTS_DIR/queue.lock || return 1
  if [[ -z $num ]]; then
    [[ -s $SLOTS_DIR/queue.seq ]] && seq=$(<$SLOTS_DIR/queue.seq); [[ $seq == <-> ]] || seq=0
    num=$(( seq + 1 ))
    print -r -- $num > $SLOTS_DIR/queue.seq.tmp && mv -f $SLOTS_DIR/queue.seq.tmp $SLOTS_DIR/queue.seq
  fi
  SLOT_QF=$SLOTS_DIR/queue/${(l:10::0:)num}; tmp=$SLOTS_DIR/queue/.tmp.$pid
  print -r -- "$class $pid $(_slot_pstart $pid) $kind${extra:+ $extra}" > $tmp && mv -f $tmp $SLOT_QF
  zsystem flock -u $qfd
}

# Under admit.lock: position of ticket $1 in the queue of class $2 -> $SLOT_QPOS; first ticket of the other queue ->
# $SLOT_QOTHER ("path class kind", empty - none; only medium and heavy share the ceiling, so a stand ticket is never
# the other queue - scripts/stand.sh); first ticket of my queue -> $SLOT_QHEAD.
_slot_q_where() {
  local me=$1 class=$2 f t
  SLOT_QPOS=0 SLOT_QOTHER= SLOT_QHEAD=
  for f in $SLOTS_DIR/queue/<->(N); do       # the glob is sorted by name = by number
    t=( $(<$f) )
    if [[ $t[1] == $class ]]; then
      [[ -z $SLOT_QHEAD ]] && SLOT_QHEAD="${f:t} $t[4] pid $t[2]"
      (( SLOT_QPOS++ ))
      [[ $f == $me ]] && break
    elif [[ -z $SLOT_QOTHER && $t[1] == (medium|heavy) ]]; then SLOT_QOTHER="$f $t[1] $t[4]"
    fi
  done
  # only a smaller number than mine matters in the other queue
  [[ -n $SLOT_QOTHER && ${${=SLOT_QOTHER}[1]} > $me ]] && SLOT_QOTHER=
}

# Under admit.lock: may the first of the queue of class $1, kind $2, take a slot now -> $SLOT_PICK / $SLOT_WHY.
# Kind "whole" is a full run whose runner sets its own workers (guardCommand without {jobs}): it is counted as the
# whole budget, so it is admitted only when its budget is the whole GUARDS_JOBS_ALONE.
_slot_admit() {
  local class=$1 kind=$2 sc n
  _slot_pick $class
  [[ -n $SLOT_PICK && $class == heavy && $kind == (full|whole) ]] || return 0
  sc=( $(_slot_heavy_scan $SLOT_PICK) )
  n=$(slot_jobs_budget $sc[1] $sc[2] $(( sc[3] + sc[5] )))
  if [[ $kind == whole ]]; then
    (( n >= GUARDS_JOBS_ALONE )) || SLOT_PICK= SLOT_WHY="$(slot_whole_why $n)"
  elif (( n == 0 && sc[4] == 0 )); then
    SLOT_PICK= SLOT_WHY="full run: neighbouring full runs hold the whole budget of $GUARDS_JOBS_ALONE workers until they end - waiting for workers outside the slot, first in the queue"
  fi
}
# slot_whole_why <budget now> -> why a full run without {jobs} waits
slot_whole_why() { print -r -- "full run without {jobs}: the runner sets its own workers and is counted as the whole budget of $GUARDS_JOBS_ALONE workers, $1 free now while other heavy jobs run - waiting outside the slot, first in the queue" }

# slot_run <class> <command...> - waits for a slot (in the queue by ticket), holds it for the command, returns its code.
slot_run() {
  local class=$1; shift
  local got slot fd holder rc why t0=$EPOCHSECONDS said=0
  got=$(_slot_tmp slotgot) || { print -u2 -r -- "slot_run: no temporary file in ${TMPDIR:-/tmp} (mktemp failed)"; return 73; }
  local kind=${SLOT_KIND:-single} retry=${SLOT_RETRY_RC:-} qnum= qf= pos=0 m h o treq=$(_slot_now) tacq= jslot= jcmd=( "$@" )
  [[ $class == (medium|heavy) ]] || { print -u2 "slot_run: class must be medium|heavy, not \"$class\""; return 64; }
  if _slot_unwritable; then _slot_unwritable_say; rm -f $got; _slot_journal $treq - $(_slot_now) $class - $kind 77 "${jcmd[@]}"; return 77; fi
  : > $SLOTS_DIR/admit.lock; mkdir -p $SLOTS_DIR/queue
  # The trap is set before the holder starts: a signal between the command start and `wait` would otherwise kill only
  # us (the command an orphan outside the slot). No holder - remove the ticket and exit; a holder - stop the whole
  # command tree: collect the descendants first (while the holder lives they are its children), then TERM from the
  # leaves up to the holder. Killing the holder first sent its children to launchd and they ran on outside the slot.
  local killed=0
  trap 'killed=1; if [[ -n $holder ]]; then _slot_kill_tree $holder; else [[ -n $qf ]] && rm -f $qf; rm -f $got; _slot_journal $treq - $(_slot_now) $class - $kind 143 "${jcmd[@]}"; exit 143; fi' INT TERM HUP
  : > $SLOTS_DIR/queue.lock
  _slot_q_take "" $class $kind && { qf=$SLOT_QF; qnum=$(( 10#${qf:t} )); }   # the number is given on arrival
  while true; do
    while true; do
      # a lock turned unwritable while we wait (a sudo job started meanwhile) - the same refusal
      if _slot_unwritable; then
        _slot_unwritable_say; [[ -n $qf ]] && rm -f $qf; rm -f $got
        _slot_journal $treq - $(_slot_now) $class - $kind 77 "${jcmd[@]}"; return 77
      fi
      if zsystem flock -t 30 -i 0.1 -f fd $SLOTS_DIR/admit.lock; then
        _slot_q_clean
        # no ticket (a retry after SLOT_RETRY_RC, or it was cleaned) - the same number; no queue.lock on arrival - a new one
        if [[ -z $qf || ! -e $qf ]]; then _slot_q_take "$qnum" $class $kind && { qf=$SLOT_QF; qnum=$(( 10#${qf:t} )); }; fi
        slot= why=
        if [[ -z $qf ]]; then pos=0; why="no ticket - the queue lock (queue.lock) is busy"
        elif _slot_q_where $qf $class; pos=$SLOT_QPOS; (( pos > 1 )); then
          why="$(( pos - 1 )) ahead; the first is ticket ${SLOT_QHEAD}"
        else
          _slot_admit $class $kind; slot=$SLOT_PICK; why=$SLOT_WHY
          m=$SLOT_M h=$SLOT_H
          if [[ -n $slot && -n $SLOT_QOTHER ]] && (( m + h + 1 >= SLOT_TOTAL_MAX )); then
            o=( ${=SLOT_QOTHER} )
            _slot_admit $o[2] $o[3]
            if [[ -n $SLOT_PICK ]]; then
              why="leaving the last slot of ceiling $SLOT_TOTAL_MAX to an earlier waiter ($o[2], ticket ${o[1]:t})"; slot=
            fi
          fi
        fi
        if [[ -n $slot ]]; then
          : > $got; : >> $slot   # zsystem flock does not create the file; created here, never by the holder
          # The holder: lock (-t 0, busy -> 75), got-file, the command as a child, its code. kind/retry are not for the children.
          SLOT_KIND= SLOT_RETRY_RC= SLOT_LABEL= SLOT_PATH=$slot zsh -c 'zmodload zsh/system zsh/datetime
            zsystem flock -t 0 -f _slot_fd "$2" 2>/dev/null || exit 75
            t=${EPOCHREALTIME/,/.}; print -r -- $$ ${t%%.*}.${${t#*.}[1,3]} > "$1"; shift 2
            "$@"; exit $?' slot-holder "$got" "$slot" "$@" 0<&0 &
          holder=$!
          while [[ ! -s $got ]] && kill -0 $holder 2>/dev/null; do sleep 0.1; done
          if [[ -s $got ]]; then
            tacq=${${=$(<$got)}[2]}; [[ -n $tacq ]] || tacq=$(_slot_now)   # the holder's own start time
            jslot=${${slot:t:r}##*.}
            print -r -- "$class $$ $(date '+%F %T') $*" > $slot.who
            rm -f $slot.jobs $slot.limit $slot.limit.active   # numbers of the previous holder (slot_guard_plan) are not inherited
            rm -f $qf; qf=                                     # ticket used - the next in the queue is now first
            zsystem flock -u $fd
            break
          fi
          wait $holder 2>/dev/null; holder=   # lost the race for the file (75: held by a waiter without a ticket) - again
          why="slot $slot was taken first"
        fi
        zsystem flock -u $fd
      else why="admission lock busy"; fi
      if (( EPOCHSECONDS - said >= SLOT_SAY )); then
        print -r -- "waiting for slot $class, position ${pos} in queue ($(( EPOCHSECONDS - t0 )) s): $why"
        said=$EPOCHSECONDS
      fi
      sleep $SLOT_POLL
    done
    wait $holder; rc=$?
    (( killed )) && { wait $holder 2>/dev/null; rc=143; }
    holder=
    _slot_journal $treq $tacq $(_slot_now) $class $jslot $kind $rc "${jcmd[@]}"
    treq=$(_slot_now)
    [[ -n $retry ]] && (( rc == retry && ! killed )) || break
    # back to the queue with the same number at once: during a pause without a ticket a late waiter would slip past
    _slot_q_take "$qnum" $class $kind && qf=$SLOT_QF
  done
  trap - INT TERM HUP
  rm -f $got
  return $rc
}

_slot_tree() { local c; for c in $(pgrep -P $1); do _slot_tree $c; done; print -r -- $1 }
_slot_kill_tree() { local p; for p in $(_slot_tree $1); do kill -TERM $p 2>/dev/null; done }

# Is a command argument a guard file marked exclusive (a guard that shares a fixed port, a temp dir or a docker project
# with others and must run alone): its file name matches one of GUARDS_EXCL_GLOB, and it has a line
# `<GUARDS_EXCL_MARKER> guards:exclusive — <reason>` (blanks around the marker allowed, the reason not empty). The
# marker is taken literally (a parameter on the right of == is not a pattern unless ${~...}); the globs are patterns.
slot_is_exclusive_guard() {
  setopt localoptions extendedglob
  local a g l m=$GUARDS_EXCL_MARKER hit
  [[ -n $m ]] || return 1
  for a in "$@"; do
    [[ -f $a ]] || continue
    hit=0; for g in ${(f)GUARDS_EXCL_GLOB}; do [[ -n $g && ${a:t} == ${~g} ]] && { hit=1; break }; done
    (( hit )) || continue
    for l in "${(@f)$(<$a)}"; do
      [[ $l == [[:space:]]#${m}[[:space:]]#guards:exclusive[[:space:]]##—[[:space:]]##[^[:space:]]* ]] && return 0
    done
  done
  return 1
}

# -- Workers of a full guard run -------------------------------------------------------------------------------------
# A full run holds ONE heavy slot. Workers of all full runs together are at most GUARDS_JOBS_ALONE (6): the only heavy
# job -> 6; another heavy job -> at most GUARDS_JOBS_SHARED (3), and with k full runs at most 6/k; and never more than
# what is left of the budget: 6 minus what the neighbours ALREADY hold. Choosing only by "is the second slot busy" gave
# 6 + 3 = 9 when an old runner came first alone (its worker count fixed for the whole run).
# A neighbour writes what it holds next to its slot (slot_run deletes these files when it takes the slot):
#   <slot>.jobs = "fixed N"  - a runner without an adaptive limit, N workers until the end (N = 0 - still waiting);
#               = "adaptive" - a runner with an adaptive limit: the limit in <slot>.limit, running guards in
#                 <slot>.limit.active (written by the runner itself). Such a neighbour counts as max(limit, running):
#                 its limit drops at once, while the guards already running finish.
#   A full run without .jobs (recognised by "guards-all" in <slot>.who) and the legacy lock - worker count unknown,
#   counted as the ceiling 6.
# A newcomer with no budget (0) waits: inside the slot if there is an adaptive neighbour (it will see the newcomer and
# shed workers), outside the slot if the neighbours have fixed counts (holding the slot would be wasted).

# _slot_heavy_scan <my slot> -> "other_heavy full_runs sum_fixed adaptive_neighbours sum_adaptive"
_slot_heavy_scan() {
  local me=$1 i f others=0 full=0 fx=0 ad=0 adnow=0 j a l
  for i in {1..$_SLOT_HEAVY_MAX}; do
    f=$SLOTS_DIR/heavy.$i.lock; [[ $f == $me ]] && continue
    _slot_busy $f || continue
    (( others++ ))
    if [[ -s $f.jobs ]]; then
      j=( $(<$f.jobs) )
      if [[ $j[1] == fixed ]]; then (( full++, fx += ${j[2]:-$GUARDS_JOBS_ALONE} ))
      else
        a=0 l=0
        [[ -s $f.limit.active ]] && a=$(<$f.limit.active)
        [[ -s $f.limit ]] && l=$(<$f.limit)
        [[ $a == <-> ]] || a=$GUARDS_JOBS_ALONE; [[ $l == <-> ]] || l=$GUARDS_JOBS_ALONE
        (( full++, ad++, adnow += (a > l ? a : l) ))
      fi
    elif [[ -f $f.who ]] && grep -q ' guards-all ' $f.who; then
      (( full++, fx += GUARDS_JOBS_ALONE ))
    fi
  done
  _slot_busy "$SLOT_LEGACY_LOCK" && (( others++, full++, fx += GUARDS_JOBS_ALONE ))
  print -r -- $others $full $fx $ad $adnow
}

# slot_jobs_budget <other_heavy> <neighbour_full_runs> <their_workers> -> workers for me (0 - wait)
slot_jobs_budget() {
  local others=$1 full=$2 used=$3 s r
  (( others == 0 )) && { print -r -- $GUARDS_JOBS_ALONE; return }
  s=$(( GUARDS_JOBS_ALONE / (full + 1) )); (( s > GUARDS_JOBS_SHARED )) && s=$GUARDS_JOBS_SHARED
  r=$(( GUARDS_JOBS_ALONE - used )); (( r < 0 )) && r=0
  print -r -- $(( s < r ? s : r ))
}

# slot_guard_plan <my slot> <fixed|whole|adaptive> <start|run> -> "workers_for_me adaptive_neighbours"
# Under the admission lock: two newcomers do not count the same remainder. Writes my share for the neighbours:
# fixed -> "fixed N"; whole (a runner without {jobs}) -> "fixed GUARDS_JOBS_ALONE" when the whole budget is mine, else
# "fixed 0" and "0 0" (wait outside the slot); adaptive -> "adaptive" and the limit in <slot>.limit (at start only when N >= 1; mid-run at least
# 1: the runner reads 0 as "no limit"). No lock within 30 s - 0 (wait), nothing written.
slot_guard_plan() {
  local me=$1 mode=$2 phase=$3 fd n=0 ad=0 sc
  if zsystem flock -t 30 -f fd $SLOTS_DIR/admit.lock 2>/dev/null; then
    sc=( $(_slot_heavy_scan $me) )
    n=$(slot_jobs_budget $sc[1] $sc[2] $(( sc[3] + sc[5] ))); ad=$sc[4]
    # whole: an adaptive neighbour sheds only to its share, never to 0, so waiting in the slot cannot help - "0 0"
    [[ $mode == whole ]] && { (( n < GUARDS_JOBS_ALONE )) && n=0; ad=0 }
    if [[ $mode == (fixed|whole) ]]; then print -r -- "fixed $n" > $me.jobs
    else
      print -r -- adaptive > $me.jobs
      [[ $phase == run ]] && (( n < 1 )) && n=1
      (( n >= 1 )) && print -r -- $n > $me.limit.tmp && mv -f $me.limit.tmp $me.limit
    fi
    zsystem flock -u $fd
  fi
  print -r -- $n $ad
}

# A guard marked exclusive runs under the exclusive lock, waiting out loud (`lockf -k` without -t waited silently
# while holding a heavy slot). Attempts every SLOT_SAY s; a marker file tells "lock not given" (75 from the utility)
# apart from the command's own exit code. The lock is flock(2) (see the header): lockf(1) -k -t <s>, or flock(1)
# -o (the command does not inherit the lock) -w <s> -E 75.
slot_exclusive_run() {
  local m rc t0=$EPOCHSECONDS treq=$(_slot_now) tacq tool w=${SLOT_SAY%.*} pre
  for tool in ${=SLOT_EXCL_TOOLS} ''; do [[ -n $tool && -x $tool ]] && break; done
  if [[ -z $tool ]]; then
    print -u2 -r -- "codis-agents slots: refused - the exclusive lock $GUARDS_EXCLUSIVE_LOCK is a flock(2) lock (the project runner takes it with lockf or flock), but none of SLOT_EXCL_TOOLS is executable ($SLOT_EXCL_TOOLS); install util-linux (flock) or set SLOT_EXCL_TOOLS"
    return 72
  fi
  if [[ ${tool:t} == *flock ]]; then pre=( $tool -o -w ${w:-0} -E 75 ); else pre=( $tool -k -t ${w:-0} ); fi
  m=$(_slot_tmp exclgot) || { print -u2 -r -- "slot_exclusive_run: no temporary file in ${TMPDIR:-/tmp} (mktemp failed)"; return 73; }
  rm -f $m
  while true; do
    $pre "$GUARDS_EXCLUSIVE_LOCK" zsh -c 'zmodload zsh/datetime; t=${EPOCHREALTIME/,/.}; print -r -- ${t%%.*}.${${t#*.}[1,3]} > "$1"; shift; exec "$@"' excl $m "$@" 0<&0
    rc=$?
    if [[ -e $m ]]; then
      tacq=$(<$m); rm -f $m
      _slot_journal $treq ${tacq:--} $(_slot_now) exclusive - single $rc "$@"
      return $rc
    fi
    (( rc == 75 )) || return $rc
    print -r -- "waiting for the exclusive lock ($(( EPOCHSECONDS - t0 )) s): $GUARDS_EXCLUSIVE_LOCK is held by another exclusive guard"
  done
}
