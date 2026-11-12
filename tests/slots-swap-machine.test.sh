#!/bin/zsh
# tests:quiet - waits on slot polls; a slow machine stretches the waits
# The swap threshold of the slot scripts comes from the machine file (swapMinMB), the same source env-check reads
# (task p-runner-swap, cells S1-S6, S8-S15 of the analysis p-runner-cleanup): a job runs medium.sh / heavy.sh with a
# project config (CODIS_AGENTS_CONFIG), as a job of the remote runner does, and a machine file named by
# CODIS_AGENTS_MACHINE; the readings come from a fake Linux /proc (SLOT_OS=linux, SLOT_PROC) or fake macOS tools.
#   usage: tests/slots-swap-machine.test.sh
# Cases:
#   S1/S13. machine file 3000, SwapFree 3988 MB, no variable - medium and heavy get their slot at once;
#   S2.     machine file 3000, SwapFree 2900 MB - waits with "swap: capacity 2900 MB < 3000", goes once swap is back;
#   S3.     SLOT_SWAP_MIN_MB=4000 in the environment wins over the file's 3000 - waits at 3988 MB;
#   S4.     SLOT_SWAP_MIN_MB=0 in the environment - no swap check, even at 100 MB;
#   S12.    SLOT_SWAP_MIN_MB='' (empty) - the file's 3000 applies;
#   S5.     a machine file without swapMinMB - 4000, as before (waits at 3988 MB);
#           no machine file at all - 4000, as before;
#   S6.     machine file swapMinMB 0 - no swap check and no note, even at 100 MB;
#   S8.     no machine file, the project's older preconditions.minSwapGB 3 - 3072 MB;
#   S9.     project minSwapGB 3 and machine file 3000 - two values of one setting: refused, 78;
#   S10.    CODIS_AGENTS_MACHINE names a missing file - refused, 78;
#   S11.    Linux SwapTotal 4095 MB below the file's 5000 - refused at once (78), naming swapMinMB and the machine file;
#           the same from the environment names the environment;
#   S14.    one machine file: env-check's verdict on swap and the slot's agree (3988 ok and given, 2900 a problem and a wait);
#   S15.    macOS readings (fake sysctl and df): the file's 3000 applies.
# A case that never ends is a failure after 90 s, not a stuck test.
H=${0:A:h:h}/scripts
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-swapm.XXXXXX"); T=${T:A}
# hermetic: drop every knob an outer slots.zsh or the shell exported; the machine file is the test's own
unset GUARDS_EXCLUSIVE_LOCK SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_PRIORITY SLOT_KILL_GRACE SLOT_EMPTY_WAIT SLOT_EXEC_NOTE GUARDS_EXCLUSIVE_HELD CODIS_SLOT_HELD SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER CLAUDE_PROJECT_DIR
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK= SLOT_POLL=0.2 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
mkdir -p $T/xdg $T/shared $T/wts $T/proc $T/bin
export XDG_CONFIG_HOME=$T/xdg CODIS_AGENTS_MACHINE=$T/machine.json
export SLOT_OS=linux SLOT_PROC=$T/proc
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared"}' > $T/cfg.json
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared", "preconditions": {"minSwapGB": 3}}' > $T/cfg-gb.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
# Fake macOS tools: sysctl vm.swapusage reports $T/mac.free MB free; the VM volume has nothing free.
print -r -- '#!/bin/zsh
[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"
print -r -- "total = 30000,00M  used = 1000,00M  free = $(<'$T'/mac.free),00M  (encrypted)"' > $T/bin/sysctl
print -r -- '#!/bin/zsh
print -r -- "System-wide memory free percentage: 80%"' > $T/bin/memory_pressure
print -r -- '#!/bin/zsh
print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
print -r -- "Swapouts:                                   5."' > $T/bin/vm_stat
print -r -- '#!/bin/zsh
print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"
print -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"' > $T/bin/df
print -r -- '#!/bin/zsh
[[ $1 == PAGESIZE || $1 == PAGE_SIZE ]] && { print 4096; exit 0 }; exit 1' > $T/bin/getconf
chmod +x $T/bin/*; export PATH=$T/bin:$PATH

# swap <SwapFree MB> [SwapTotal MB] - the fake /proc (and the fake sysctl) show it; written whole (tmp + mv)
swap() {
  local tot=${2:-30000}
  print -r -- "MemTotal:       16000000 kB
MemFree:          123456 kB
MemAvailable:    3200000 kB
SwapTotal:      $(( tot * 1024 )) kB
SwapFree:       $(( $1 * 1024 )) kB" > $T/proc/meminfo.tmp && mv -f $T/proc/meminfo.tmp $T/proc/meminfo
  print -r -- "pswpout 0" > $T/proc/vmstat
  print -r -- $1 > $T/mac.free.tmp && mv -f $T/mac.free.tmp $T/mac.free
}
mach() { print -r -- "$1" > $T/machine.json }

pass=0 fail=0
# ok <name> <condition> [<detail command>] - the detail command runs only on a failure, after the condition
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1"; [[ -n $3 ]] && print -r -- "       $(eval "$3")"; fi }
waitlong() { local i; for i in {1..900}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
# go <name> <medium.sh|heavy.sh> [VAR=value | -u VAR ...] - the script runs "touch $T/<name>.ran" in the background
# under env(1) with those changes; stdout and stderr in $T/<name>.out, the exit code in $T/<name>.rc
go() {
  local n=$1 s=$2; shift 2
  rm -f $T/$n.ran $T/$n.rc $T/$n.out
  ( env "$@" "$H/$s" zsh -c 'touch '$T'/'$n'.ran' > $T/$n.out 2>&1; print -r -- $? > $T/$n.rc ) &
}
done_() { waitlong "[[ -s $T/$1.rc ]]" || { print -r -- hang > $T/$1.rc; pkill -f "$T/$1.ran" 2>/dev/null } }
rc() { print -r -- "$(cat $T/$1.rc 2>/dev/null)" }
show() { print -r -- "rc $(rc $1): $(out $1)" }
out() { cat $T/$1.out 2>/dev/null }
# given <name> - ended with 0 and ran
given() { done_ $1; [[ $(rc $1) == 0 && -e $T/$1.ran ]] }
# waits <name> <threshold> <capacity> - says "swap: capacity <capacity> MB < <threshold>" and has not run; then swap is
# made plentiful, and the job must run
waits() {
  local re="swap: capacity $3 MB < $2([^0-9]|\$)"
  waitlong "grep -qE '$re' $T/$1.out || [[ -s $T/$1.rc ]]"
  local said=0; grep -qE "$re" $T/$1.out && [[ ! -e $T/$1.ran && ! -s $T/$1.rc ]] && said=1
  swap 20000; done_ $1
  (( said )) && [[ $(rc $1) == 0 && -e $T/$1.ran ]]
}

# S1/S13. the remote runner's case: file 3000, SwapFree 3988 MB (the queue of 2026-11-09 stood at "3988 MB < 4000")
mach '{"configVersion": 1, "swapMinMB": 3000}'; swap 3988
go s1m medium.sh
ok 'S1. machine file 3000, SwapFree 3988 MB, project config - medium.sh gets its slot at once' 'given s1m' 'show s1m'
ok 'S1. ... nothing said about swap' '! grep -q "swap" $T/s1m.out' "$(out s1m)"
go s1h heavy.sh
ok 'S13. ... heavy.sh (the full run of a runner job) too' 'given s1h' 'show s1h'

# S2. below the file's threshold: a wait naming the file's 3000
swap 2900; go s2 medium.sh
ok 'S2. file 3000, SwapFree 2900 MB - waits with "swap: capacity 2900 MB < 3000", runs once swap is back' 'waits s2 3000 2900' 'show s2'

# S3. the environment wins
swap 3988; go s3 medium.sh SLOT_SWAP_MIN_MB=4000
ok 'S3. SLOT_SWAP_MIN_MB=4000 in the environment, file 3000, SwapFree 3988 - waits at 4000' 'waits s3 4000 3988' 'show s3'

# S4. the environment's 0 switches the check off
swap 100; go s4 medium.sh SLOT_SWAP_MIN_MB=0
ok 'S4. SLOT_SWAP_MIN_MB=0, file 3000, SwapFree 100 MB - runs, nothing said about swap' 'given s4 && ! grep -q "swap" $T/s4.out' 'show s4'

# S12. an empty variable is no value: the file applies
swap 3988; go s12 medium.sh SLOT_SWAP_MIN_MB=
ok 'S12. SLOT_SWAP_MIN_MB empty, file 3000, SwapFree 3988 - runs' 'given s12' 'show s12'

# S5. a machine file without swapMinMB, and no machine file at all: 4000 as before
mach '{"configVersion": 1}'; swap 3988; go s5 medium.sh
ok 'S5. machine file without swapMinMB, SwapFree 3988 - waits at the default 4000' 'waits s5 4000 3988' 'show s5'
swap 3988; go s5n medium.sh -u CODIS_AGENTS_MACHINE
ok 'S5. no machine file at all (empty XDG_CONFIG_HOME), SwapFree 3988 - waits at the default 4000' 'waits s5n 4000 3988' 'show s5n'

# S6. the file's 0 switches the check off, without a note
mach '{"configVersion": 1, "swapMinMB": 0}'; swap 100; go s6 medium.sh
ok 'S6. machine file swapMinMB 0, SwapFree 100 MB - runs, nothing said about swap' 'given s6 && ! grep -q "swap" $T/s6.out' 'show s6'

# S8. no machine file: the project's older minSwapGB 3 = 3072 MB, as env-check of the chain takes it
swap 3988; go s8 medium.sh -u CODIS_AGENTS_MACHINE CODIS_AGENTS_CONFIG=$T/cfg-gb.json
ok 'S8. no machine file, project minSwapGB 3, SwapFree 3988 - runs (3072 MB)' 'given s8' 'show s8'
swap 3000; go s8w medium.sh -u CODIS_AGENTS_MACHINE CODIS_AGENTS_CONFIG=$T/cfg-gb.json
ok 'S8. ... SwapFree 3000 - waits at 3072' 'waits s8w 3072 3000' 'show s8w'

# S9. two values of one setting: refused
mach '{"configVersion": 1, "swapMinMB": 3000}'; swap 3988; go s9 medium.sh CODIS_AGENTS_CONFIG=$T/cfg-gb.json
ok 'S9. project minSwapGB 3 and machine file 3000 - refused 78, the command does not run' 'done_ s9; [[ $(rc s9) == 78 && ! -e $T/s9.ran ]]' 'show s9'

# S10. a named machine file that is not there
go s10 medium.sh CODIS_AGENTS_MACHINE=$T/nope.json
ok 'S10. CODIS_AGENTS_MACHINE names a missing file - refused 78' 'done_ s10; [[ $(rc s10) == 78 && ! -e $T/s10.ran ]]' 'show s10'

# S11. a swap smaller than the threshold on Linux: refusal at once, naming where the threshold comes from
mach '{"configVersion": 1, "swapMinMB": 5000}'; swap 4095 4095
go s11 heavy.sh
ok 'S11. SwapTotal 4095 MB, file 5000 - refused at once with 78, the command does not run' 'done_ s11; [[ $(rc s11) == 78 && ! -e $T/s11.ran ]]' 'show s11'
ok 'S11. ... it names the threshold 5000, swapMinMB and the machine file' 'grep -q "5000 MB" $T/s11.out && grep -q "swapMinMB" $T/s11.out && grep -qF "$T/machine.json" $T/s11.out' 'show s11'
go s11e heavy.sh SLOT_SWAP_MIN_MB=4500
ok 'S11. ... from the environment (4500): it names the environment, not the machine file' 'done_ s11e; [[ $(rc s11e) == 78 ]] && grep -q "4500 MB" $T/s11e.out && grep -q "environment" $T/s11e.out && ! grep -qF "$T/machine.json" $T/s11e.out' 'show s11e'

# S14. one machine file, one verdict: env-check (its judge over the same machine values) and the slot agree
mach '{"configVersion": 1, "swapMinMB": 3000}'
ec() { node -e 'const { judge } = require(process.argv[1] + "/env-check.js"); const m = require(process.argv[1] + "/config.js").loadMachine();
const r = judge({ disk: [], swap: Number(process.argv[2]) * 1048576, swapWhy: null }, { swapMinMB: m.values.swapMinMB }); process.exit(r.ok ? 0 : 1)' $H $1 }
swap 3988; go s14 medium.sh
ok 'S14. file 3000, 3988 MB: env-check ok and the slot given' 'ec 3988 && given s14' 'show s14'
swap 2900; go s14w medium.sh
ok 'S14. file 3000, 2900 MB: env-check a problem and the slot waits' '! ec 2900 && waits s14w 3000 2900' 'show s14w'

# S15. macOS readings: the file applies there too
swap 3988; go s15 medium.sh SLOT_OS=darwin
ok 'S15. macOS (fake sysctl free 3988 MB), file 3000 - runs' 'given s15' 'show s15'
swap 2900; go s15w medium.sh SLOT_OS=darwin
ok 'S15. macOS, 2900 MB - waits at 3000' 'waits s15w 3000 2900' 'show s15w'

wait 2>/dev/null
rm -rf $T
print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
