#!/bin/zsh
# A medium command (<= 0.85 GB: tsc, a plugin build, one bundler build without a browser) in a medium slot
# (SLOT_MEDIUM_N slots; medium + heavy <= SLOT_TOTAL_MAX, see slots.zsh).
# usage: medium.sh <command...>
source "${0:A:h}/slots.zsh" || exit $?
slot_run medium "$@"
