#!/bin/zsh
# A heavy command (a guard with a bundler or browser, a docker image build, a test stack) in a heavy slot
# (slots.zsh: SLOT_HEAVY_N slots, one more only while memory is free and swap is flat; medium + heavy <= SLOT_TOTAL_MAX).
# A guard marked exclusive also takes the exclusive lock ($GUARDS_EXCLUSIVE_LOCK), waiting out loud ("waiting for the
# exclusive lock ..." at least every SLOT_SAY s): an argument that is a file matching the project's guardExclusive glob
# with a line `<marker> guards:exclusive — <reason>` (default *-run.js / *-run.mjs and //; slots.zsh#slot_is_exclusive_guard).
# Under that lock already (a heavy.sh inside the command of another heavy.sh of an exclusive guard, in the same process
# group: slots.zsh#slot_exclusive_held) the guard runs in its slot without taking the lock again.
# usage: heavy.sh <command...>
source "${0:A:h}/slots.zsh" || exit $?
if slot_is_exclusive_guard "$@" && ! slot_exclusive_held; then SLOT_LABEL="$*" slot_run heavy zsh -c 'source "$1"; shift; slot_exclusive_run "$@"' heavy-excl "${0:A:h}/slots.zsh" "$@"
else slot_run heavy "$@"; fi
