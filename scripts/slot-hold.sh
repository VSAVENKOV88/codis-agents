#!/bin/zsh
# Holds a memory slot for a process that cannot hold an fcntl lock itself (the adapter of a codex role, scripts/
# role-exec.js, part A2b): it queues like heavy.sh / medium.sh, then prints ONE line "acquired <slot file> <epoch.ms>" on
# stdout and holds the slot until a line "release" comes on stdin or stdin ends (EOF: the caller is gone) - no polling,
# no timer. The holding loop runs as the slot's command, so it has an exec marker of its own; the caller marks the
# groups it starts in the slot itself (<slot>.exec.<pgid>, slots.zsh), and the slot stays busy while any of them lives.
# A signal to slot-hold.sh stops the loop like any slot command (slots.zsh, STOP). One journal line of kind "hold" with
# SLOT_LABEL (default "slot-hold <class>"). Lines "waiting for slot ..." may come on stdout before "acquired".
# usage: slot-hold.sh <medium|heavy>
source "${0:A:h}/slots.zsh" || exit $?
[[ $# == 1 && $1 == (medium|heavy) ]] || { print -u2 -r -- "usage: slot-hold.sh <medium|heavy>"; exit 64; }
SLOT_KIND=hold SLOT_LABEL=${SLOT_LABEL:-slot-hold $1} slot_run $1 zsh -c 'zmodload zsh/datetime
  t=${EPOCHREALTIME/,/.}; print -r -- "acquired $SLOT_PATH ${t%%.*}.${${t#*.}[1,3]}"
  while IFS= read -r l; do [[ $l == release ]] && exit 0; done
  exit 0'
