#!/bin/zsh
# Tester guard U1b: the edges of the Linux readings that tests/slots-linux.test.sh does not reach, on a FAKE Linux
# machine (SLOT_OS=linux, SLOT_PROC=<static fake /proc dirs under $T>), so it runs the same on macOS and on Linux.
#   usage: tests/slots-linux-edges.test.sh
# Cases:
#   R1. no swap (SwapTotal 0), default threshold - guards-all.sh refuses with 78 too: the runner never starts, one
#       refusal line, journaled (rc 78);
#   R2. ... and medium.sh: 78, the command does not run;
#   R3. swap at least the threshold but full (SwapTotal 8 GB or exactly 4194304 kB = 4096 MB, SwapFree 0) - a WAIT
#       with "swap: capacity 0 MB < 4096", not the refusal: SwapFree can come back up to SwapTotal;
#   R6. swap present but smaller than the threshold (0 < SwapTotal / 1024 < SLOT_SWAP_MIN_MB: 4194300 kB - a 4 GiB swap
#       minus its header page - is 4095 MB; 1048572 kB is 1023 MB) - SwapFree never exceeds SwapTotal and Linux swap
#       does not grow by itself, so no slot would ever be given: heavy.sh, medium.sh and guards-all.sh refuse at once
#       with 78 and the numbers, the hint names SLOT_SWAP_MIN_MB and the value that would fit, journaled, no queue
#       ticket; with SLOT_SWAP_MIN_MB lowered to fit the slot is given;
#   R4. meminfo without the SwapTotal line - "swap not measured (no SwapTotal ...)", the slot is given, never 78;
#   R5. explicit SLOT_THIRD_FREE_PCT, the extra slot cannot be measured - refused as "memory not measured" naming the
#       reason: /proc/vmstat missing; no pswpout in it; getconf PAGESIZE failing; MemTotal 0.
#   R7. (round 2) the refusal follows the threshold that is set (8192 on a 4096 MB swap, 2048 on 1023 MB), a lowered
#       threshold below the swap gives the slot, SwapTotal 1 kB is "smaller" (hint "0 or less"), a swap at the threshold
#       but partly used waits, and macOS with a small swap waits (never 78).
H=${0:A:h:h}/scripts
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-linux-edges.XXXXXX"); T=${T:A}
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK= SLOT_POLL=0.2 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
# hermetic inside an outer slot: drop what an outer slots.zsh exported and thresholds set outside
unset GUARDS_EXCLUSIVE_LOCK SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
export SLOT_OS=linux SLOT_PROC=$T/proc/ok
J=$SLOTS_DIR/journal.tsv
mkdir -p $T/shared $T/wts/w1 $T/bin
git -C $T/wts/w1 init -q && git -C $T/wts/w1 -c user.email=t@t -c user.name=t commit -q --allow-empty -m x
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared", "guardCommand": "cd {wt} && touch '$T'/runner.ran"}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
# Fake macOS tools (a Linux reading must never call them: they mark $T/mac.called); getconf PAGESIZE 4096, or a
# failure while $T/getconf.broken exists.
print -r -- '#!/bin/zsh
: >> '$T'/mac.called; exit 1' > $T/bin/sysctl
cp $T/bin/sysctl $T/bin/memory_pressure; cp $T/bin/sysctl $T/bin/vm_stat; cp $T/bin/sysctl $T/bin/df
print -r -- '#!/bin/zsh
[[ -e '$T'/getconf.broken ]] && exit 1
[[ $1 == PAGESIZE || $1 == PAGE_SIZE ]] && { print 4096; exit 0 }; exit 1' > $T/bin/getconf
chmod +x $T/bin/*; export PATH=$T/bin:$PATH

# mkproc <dir> <MemTotal> <MemAvailable> <SwapTotal|-> <SwapFree|-> <vmstat: yes|nopswpout|no>  ("-" leaves the line out)
mkproc() {
  local d=$T/proc/$1; mkdir -p $d
  { print -r -- "MemTotal:       $2 kB"; print -r -- "MemFree:          123456 kB"; print -r -- "MemAvailable:   $3 kB"
    [[ $4 == - ]] || print -r -- "SwapTotal:      $4 kB"; [[ $5 == - ]] || print -r -- "SwapFree:       $5 kB" } > $d/meminfo
  case $6 in
    yes) print -r -- "nr_free_pages 30864
pswpin 7
pswpout 11
pgfault 99" > $d/vmstat ;;
    nopswpout) print -r -- "nr_free_pages 30864
pswpin 7
pgfault 99" > $d/vmstat ;;
  esac
}
mkproc ok      16000000 14400000 30720000 20480000 yes
mkproc noswap  16000000 3200000  0        0        yes
mkproc full    16000000 3200000  8388608  0        yes
mkproc nototal 16000000 3200000  -        20480000 yes
mkproc novm    16000000 14400000 30720000 20480000 no
mkproc nopsw   16000000 14400000 30720000 20480000 nopswpout
mkproc mem0    0        0        30720000 20480000 yes
mkproc small4  16000000 3200000  4194300  4194300  yes
mkproc small1  16000000 3200000  1048572  1048572  yes
mkproc exact4  16000000 3200000  4194304  0        yes

pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
waitlong() { local i; for i in {1..900}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
started() { [[ -e $T/$1.start ]] }
JP=()
# hjob <script> <name> - holds its slot until $T/rel.<name>; stdout+stderr in $T/<name>.out
hjob() { "$H/$1" zsh -c 'touch '$T'/$1.start; while [[ ! -e '$T'/rel.$1 ]]; do sleep 0.1; done' _ $2 > $T/$2.out 2>&1 & JP+=$! }
rel() { local n; for n; do touch $T/rel.$n; done }
# once <name> <script> <command...> - in the background, its code in $T/<name>.rc ("hang" after 90 s)
once() {
  local n=$1 s=$2; shift 2
  ( "$H/$s" "$@" > $T/$n.out 2> $T/$n.err; print -r -- $? > $T/$n.rc ) & local p=$!
  waitlong "[[ -s $T/$n.rc ]]" || { pkill -P $p 2>/dev/null; kill $p 2>/dev/null; print -r -- hang > $T/$n.rc }
}
rc() { print -r -- $(<$T/$1.rc) }
clean() {
  local p live
  waitlong 'live=(); for p in $JP; do kill -0 $p 2>/dev/null && live+=$p; done; (( ! ${#live} ))' || {
    (( fail++ )); print -r -- "  FAIL a job of the case still waits after 90 s (killed): pids $live"
    for p in $live; do pkill -P $p 2>/dev/null; kill $p 2>/dev/null; done }
  wait $JP 2>/dev/null; JP=(); rm -f $T/*.start(N) $T/rel.*(N)
}
trap 'touch $T/rel.{a,b,c}{1,2,3,4}(N) 2>/dev/null; wait 2>/dev/null; rm -rf $T' EXIT

# R1. guards-all.sh on a machine without swap: 78, the runner does not start
rm -f $J
SLOT_PROC=$T/proc/noswap once g1 guards-all.sh $T/wts/w1
ok 'R1. SwapTotal 0, threshold 4096 - guards-all.sh exits 78 (not an endless wait)' '[[ $(rc g1) == 78 ]]' "code $(rc g1); $(cat $T/g1.out $T/g1.err)"
ok 'R1. ... the runner (guardCommand) never started' '[[ ! -e $T/runner.ran ]]'
ok 'R1. ... the refusal line names SwapTotal 0 and SLOT_SWAP_MIN_MB=0' 'grep -q "no swap (SwapTotal 0 kB" $T/g1.err && grep -q "SLOT_SWAP_MIN_MB=0" $T/g1.err' "$(cat $T/g1.err)"
jl=( "${(@s:	:)$(tail -1 $J 2>/dev/null)}" )
ok 'R1. ... journaled: class heavy, acquire "-", rc 78' '[[ $jl[5] == heavy && $jl[3] == - && $jl[9] == 78 ]]' "$(tail -1 $J 2>/dev/null)"

# R2. medium.sh on a machine without swap: 78, the command does not run
SLOT_PROC=$T/proc/noswap once m1 medium.sh zsh -c 'touch '$T'/m1.ran'
ok 'R2. SwapTotal 0 - medium.sh exits 78, the command did not run' '[[ $(rc m1) == 78 && ! -e $T/m1.ran ]]' "code $(rc m1); $(cat $T/m1.out $T/m1.err)"

# R3. swap present but full: a temporary wait with the number, not the refusal
SLOT_PROC=$T/proc/full hjob heavy.sh a1
waitlong '(( $(grep -c "waiting for slot heavy" $T/a1.out 2>/dev/null) > 0 ))'
ok 'R3. SwapTotal 8 GB, SwapFree 0 - heavy.sh WAITS with "swap: capacity 0 MB < 4096" (no 78)' '! started a1 && grep -q "swap: capacity 0 MB < 4096" $T/a1.out && ! grep -q "refused" $T/a1.out' "$(cat $T/a1.out)"
kill $JP 2>/dev/null; clean
SLOT_PROC=$T/proc/exact4 hjob heavy.sh a2
waitlong '(( $(grep -c "waiting for slot heavy" $T/a2.out 2>/dev/null) > 0 ))'
ok 'R3. SwapTotal 4194304 kB = 4096 MB (equal to the threshold), SwapFree 0 - heavy.sh WAITS (no 78)' '! started a2 && grep -q "swap: capacity 0 MB < 4096" $T/a2.out && ! grep -q "refused" $T/a2.out' "$(cat $T/a2.out)"
kill $JP 2>/dev/null; clean

# R6. swap smaller than the threshold: refused at once with the numbers, in every slot script
small() { # small <name> <proc dir> <SwapTotal kB> <MB> <script> <command...>
  local n=$1 d=$2 kb=$3 mb=$4 s=$5; shift 5
  rm -f $J; rm -rf $SLOTS_DIR/queue
  SLOT_PROC=$T/proc/$d once $n $s "$@"
  ok "R6. SwapTotal $kb kB = $mb MB < 4096 - $s exits 78 at once (not an endless wait)" '[[ $(rc $n) == 78 ]]' "code $(rc $n); $(cat $T/$n.out $T/$n.err)"
  ok "R6. ... ($s) one refusal line with SwapTotal $kb kB = $mb MB, the threshold, MemTotal and MemAvailable" \
    '[[ $(grep -c "refused" $T/$n.err) -eq 1 ]] && grep -qF "SwapTotal $kb kB = $mb MB" $T/$n.err && grep -qF "SLOT_SWAP_MIN_MB = 4096 MB" $T/$n.err && grep -q "MemTotal 15625 MB" $T/$n.err && grep -q "MemAvailable 3125 MB" $T/$n.err' "$(cat $T/$n.err)"
  ok "R6. ... ($s) the hint names the threshold that fits: SLOT_SWAP_MIN_MB to $mb or less" 'grep -qF "set SLOT_SWAP_MIN_MB to $mb or less" $T/$n.err' "$(cat $T/$n.err)"
  jl=( "${(@s:	:)$(tail -1 $J 2>/dev/null)}" )
  ok "R6. ... ($s) journaled: acquire \"-\", rc 78; no queue ticket left" '[[ $jl[3] == - && $jl[9] == 78 ]] && [[ -z $(print -r -- $SLOTS_DIR/queue/*(N)) ]]' "$(tail -1 $J 2>/dev/null); $(ls $SLOTS_DIR/queue 2>&1)"
}
small s4h small4 4194300 4095 heavy.sh zsh -c 'touch '$T'/s4h.ran'
ok 'R6. ... the heavy command did not run' '[[ ! -e $T/s4h.ran ]]'
small s4m small4 4194300 4095 medium.sh zsh -c 'touch '$T'/s4m.ran'
ok 'R6. ... the medium command did not run' '[[ ! -e $T/s4m.ran ]]'
rm -f $T/runner.ran
small s4g small4 4194300 4095 guards-all.sh $T/wts/w1
ok 'R6. ... the runner (guardCommand) never started' '[[ ! -e $T/runner.ran ]]'
small s1h small1 1048572 1023 heavy.sh zsh -c 'touch '$T'/s1h.ran'
SLOT_SWAP_MIN_MB=1023 SLOT_PROC=$T/proc/small1 once s1ok heavy.sh zsh -c 'exit 7'
ok 'R6. SwapTotal 1048572 kB with SLOT_SWAP_MIN_MB=1023 (the hinted value) - the slot is given, code 7' '[[ $(rc s1ok) == 7 ]]' "code $(rc s1ok); $(cat $T/s1ok.out $T/s1ok.err)"

# R4. no SwapTotal line: not measured, the slot is given
SLOT_PROC=$T/proc/nototal once n1 heavy.sh zsh -c 'exit 7'
ok 'R4. meminfo without SwapTotal - the command runs (code 7), never 78' '[[ $(rc n1) == 7 ]]' "code $(rc n1); $(cat $T/n1.out $T/n1.err)"
ok 'R4. ... one line "swap not measured (no SwapTotal in .../meminfo) - not checked"' '[[ $(grep -c "swap not measured" $T/n1.err) -eq 1 ]] && grep -q "no SwapTotal in $T/proc/nototal/meminfo" $T/n1.err' "$(cat $T/n1.err)"

# R5. the extra slot with an explicit threshold, but one of its readings cannot be taken: refused, reason named
third() { # third <proc dir> <expected reason> <label>
  SLOT_PROC=$T/proc/$1 hjob heavy.sh b1; SLOT_PROC=$T/proc/$1 hjob heavy.sh b2
  waitlong 'started b1 && started b2'
  SLOT_THIRD_FREE_PCT=50 SLOT_PROC=$T/proc/$1 hjob heavy.sh b3
  waitlong 'grep -q "extra slot:" $T/b3.out'
  WANT="extra slot: memory not measured ($2"
  ok "R5. $3 - the third waits: \"$WANT\"" '! started b3 && grep -qF -- "$WANT" $T/b3.out' "$(cat $T/b3.out)"
  rel b1; waitlong 'started b3'; rel b2 b3; clean; rm -f $SLOTS_DIR/mem.hist
}
third novm  "$T/proc/novm/vmstat cannot be read" 'no /proc/vmstat'
third nopsw "no pswpout in $T/proc/nopsw/vmstat" 'vmstat without pswpout'
: > $T/getconf.broken
third ok    "getconf PAGESIZE failed" 'getconf PAGESIZE failing'
rm -f $T/getconf.broken
third mem0  "MemTotal 0 in $T/proc/mem0/meminfo" 'MemTotal 0'

ok 'Linux readings never called the macOS tools' '[[ ! -e $T/mac.called ]]'

# R7 (tester, round 2). The swap-smaller-than-threshold refusal follows the threshold that is set, not 4096; a 1 kB
# swap is "smaller", not "no swap"; a swap that fits a lowered threshold but is partly used waits; macOS never refuses
# a small swap (its swap file grows: capacity = vm.swapusage free + free space of /System/Volumes/VM).
mkproc used1 16000000 3200000  1048572  524288   yes
mkproc tiny  16000000 3200000  1        1        yes
rm -f $J; rm -rf $SLOTS_DIR/queue
SLOT_SWAP_MIN_MB=8192 SLOT_PROC=$T/proc/exact4 once t8 heavy.sh zsh -c 'touch '$T'/t8.ran'
ok 'R7. SLOT_SWAP_MIN_MB=8192, SwapTotal 4194304 kB = 4096 MB - heavy.sh exits 78, the command does not run' '[[ $(rc t8) == 78 && ! -e $T/t8.ran ]]' "code $(rc t8); $(cat $T/t8.out $T/t8.err)"
ok 'R7. ... the line names the threshold that is set (8192) and the value that fits (4096)' 'grep -qF "SwapTotal 4194304 kB = 4096 MB" $T/t8.err && grep -qF "SLOT_SWAP_MIN_MB = 8192 MB" $T/t8.err && grep -qF "set SLOT_SWAP_MIN_MB to 4096 or less" $T/t8.err && ! grep -q "no swap" $T/t8.err' "$(cat $T/t8.err)"
SLOT_SWAP_MIN_MB=2048 SLOT_PROC=$T/proc/small1 once t2 heavy.sh zsh -c 'touch '$T'/t2.ran'
ok 'R7. SLOT_SWAP_MIN_MB=2048, SwapTotal 1048572 kB = 1023 MB - 78 naming 2048 and 1023' '[[ $(rc t2) == 78 && ! -e $T/t2.ran ]] && grep -qF "SLOT_SWAP_MIN_MB = 2048 MB" $T/t2.err && grep -qF "set SLOT_SWAP_MIN_MB to 1023 or less" $T/t2.err' "code $(rc t2); $(cat $T/t2.err)"
SLOT_SWAP_MIN_MB=1024 SLOT_PROC=$T/proc/small4 once t1 heavy.sh zsh -c 'exit 7'
ok 'R7. SLOT_SWAP_MIN_MB=1024 below a 4095 MB swap that is free - the slot is given (code 7), no refusal' '[[ $(rc t1) == 7 ]] && ! grep -q refused $T/t1.err' "code $(rc t1); $(cat $T/t1.err)"
SLOT_PROC=$T/proc/tiny once ty heavy.sh zsh -c 'touch '$T'/ty.ran'
ok 'R7. SwapTotal 1 kB = 0 MB - 78 as a swap smaller than the threshold (not "no swap"), hint "to 0 or less"' '[[ $(rc ty) == 78 && ! -e $T/ty.ran ]] && grep -qF "SwapTotal 1 kB = 0 MB" $T/ty.err && grep -qF "set SLOT_SWAP_MIN_MB to 0 or less" $T/ty.err && ! grep -q "no swap" $T/ty.err' "code $(rc ty); $(cat $T/ty.err)"
SLOT_SWAP_MIN_MB=1023 SLOT_PROC=$T/proc/used1 hjob heavy.sh a3
waitlong '(( $(grep -c "waiting for slot heavy" $T/a3.out 2>/dev/null) > 0 ))'
ok 'R7. SLOT_SWAP_MIN_MB=1023 = SwapTotal 1023 MB, SwapFree 512 MB - heavy.sh WAITS with "capacity 512 MB < 1023" (no 78)' '! started a3 && grep -q "swap: capacity 512 MB < 1023" $T/a3.out && ! grep -q "refused" $T/a3.out' "$(cat $T/a3.out)"
kill $JP 2>/dev/null; clean
# macOS: a fake mac with 1024 MB of swap free and 0 MB free on its VM volume - a WAIT, never the Linux refusal
mkdir -p $T/macbin
print -r -- '#!/bin/zsh
[[ "$*" == *vm.swapusage* ]] && { print "total = 1024.00M  used = 0.00M  free = 1024.00M  (encrypted)"; exit 0 }; exit 1' > $T/macbin/sysctl
print -r -- '#!/bin/zsh
print "Filesystem 1M-blocks Used Available Capacity Mounted"; print "/dev/disk3s6 100 100 0 100% /System/Volumes/VM"' > $T/macbin/df
chmod +x $T/macbin/*
PATH=$T/macbin:$PATH SLOT_OS=darwin hjob heavy.sh a4
waitlong '(( $(grep -c "waiting for slot heavy" $T/a4.out 2>/dev/null) > 0 ))'
ok 'R7. macOS, swap capacity 1024 MB < 4096 - heavy.sh WAITS (its swap grows), never 78' '! started a4 && grep -q "swap: capacity 1024 MB < 4096" $T/a4.out && ! grep -q "refused" $T/a4.out' "$(cat $T/a4.out)"
kill $JP 2>/dev/null; clean
print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
