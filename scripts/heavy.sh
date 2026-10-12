#!/bin/zsh
# A heavy command (a guard with a bundler or browser, a docker image build, a test stack) in a heavy slot
# (slots.zsh: SLOT_HEAVY_N slots, one more only while memory is free and swap is flat; medium + heavy <= SLOT_TOTAL_MAX).
# A guard marked `// guards:exclusive — <reason>` also takes the exclusive lock ($GUARDS_EXCLUSIVE_LOCK), waiting out
# loud ("waiting for the exclusive lock ..." at least every SLOT_SAY s).
# usage: heavy.sh <command...>
source "${0:A:h}/slots.zsh"
if slot_is_exclusive_guard "$@"; then slot_run heavy zsh -c 'source "$1"; shift; slot_exclusive_run "$@"' heavy-excl "${0:A:h}/slots.zsh" "$@"
else slot_run heavy "$@"; fi
