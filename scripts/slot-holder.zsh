#!/bin/zsh
# The holder of a memory slot (H), started by slot_run (scripts/slots.zsh) only:
#   perl slot-group.pl lead zsh slot-holder.zsh <got-file> <slot file> <command...>
# It leads a process group of its own, so a signal to the group of the caller (Ctrl-C, wait-step.js's TERM to -pid)
# never reaches it. It takes the slot's fcntl lock (-t 0: busy - exit 75, "lost the race"), writes the got-file
# "<pid> <epoch.ms>", and runs the command C in a process group of its own through `slot-group.pl run`, which names the
# group in the exec marker <slot>.exec.<pgid> before the command's first instruction. The lock is never re-opened here
# (closing any descriptor of the file drops an fcntl lock, man zshmodules), so the command is never exec-ed in place of
# the holder.
# The holder is the only one that stops C. INT/TERM/HUP (slot_run's trap sends TERM when its caller is signalled):
# TERM and CONT to the group of C at once, then the pause SLOT_KILL_GRACE, KILL, and up to SLOT_EMPTY_WAIT for the group
# to be gone (slot-group.pl stop). The same stop runs when the leader of C has exited and members of its group remain.
# A second signal changes nothing: the stop already runs. The marker is removed only once the group is gone; a group not
# gone after KILL keeps its marker, and with it the slot, until it ends (slots.zsh: a slot is busy while a marker names
# a live group). The exit code is the leader's (a signal to the holder before the command started: 143).
zmodload zsh/system zsh/datetime
G=${0:A:h}/slot-group.pl
got=$1 slot=$2; shift 2
c= stop=0 rc= r=
trap 'stop=1; [[ -n $c ]] && { kill -TERM -- -$c; kill -CONT -- -$c } 2>/dev/null' INT TERM HUP
zsystem flock -t 0 -f _slot_fd "$slot" 2>/dev/null || exit 75
t=${EPOCHREALTIME/,/.}; print -r -- $$ ${t%%.*}.${${t#*.}[1,3]} > "$got"
(( stop )) && exit 143
perl $G run "$slot" "$@" 0<&0 &
c=$!
(( stop )) && { kill -TERM -- -$c; kill -CONT -- -$c } 2>/dev/null
# wait for the leader; a trapped signal interrupts `wait` and starts the stop
while (( ! stop )); do
  wait $c; r=$?
  kill -0 $c 2>/dev/null || { rc=$r; break }
done
if (( stop )) || perl $G alive $c; then
  if ! perl $G stop $c $SLOT_KILL_GRACE $SLOT_EMPTY_WAIT; then
    print -u2 -r -- "slot_run: group $c not empty after KILL and ${SLOT_EMPTY_WAIT} s: the slot ${slot:t} stays held by its marker ${slot:t}.exec.$c until the group ends"
    [[ -n $rc ]] || rc=137
    exit $rc
  fi
fi
# the group is gone: its marker goes; the leader's status, unless the wait above already took it
rm -f "$slot.exec.$c"
[[ -n $rc ]] || { wait $c 2>/dev/null; rc=$?; }
exit $rc
