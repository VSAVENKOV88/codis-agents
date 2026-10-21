#!/bin/zsh
# Memory and swap readings of the slot scripts on a FAKE Linux machine (task U1b): SLOT_OS=linux and SLOT_PROC=<a
# directory with meminfo and vmstat written by the test>, so it runs the same on macOS and on Linux; a temporary slot
# directory, the commands are sleeps. Exit code 0 - everything holds.
#   usage: tests/slots-linux.test.sh
# Cases (cells B2-B10 of the U1 matrix):
#   B2/B8. swap capacity is SwapFree / 1024 MB; below SLOT_SWAP_MIN_MB - waiting with "swap: capacity N MB < M";
#   B7.    no swap (SwapTotal 0) and a threshold above 0 - one refusal line with the numbers, code 78, journaled, the
#          command does not run, no endless wait;
#   B9.    SLOT_SWAP_MIN_MB=0 - the swap check is off: no refusal, no waiting, not even a "not measured" note;
#   B4.    the extra heavy slot is off on Linux by default (MemAvailable is not the free percentage it was measured with);
#   B5.    an explicit SLOT_THIRD_FREE_PCT switches it on with MemAvailable / MemTotal, the minimum over the window;
#   B6.    swap-out growth = pswpout (/proc/vmstat) x getconf PAGESIZE over the window refuses the extra slot;
#   B3.    swap used = SwapTotal - SwapFree; its growth over the window refuses the extra slot;
#   B10.   a source that cannot be read (no meminfo, an unknown OS, a failing sysctl on macOS) - "swap not measured -
#          not checked" once, the slot is given; the extra slot is refused as "not measured".
# On Linux the macOS tools (sysctl, memory_pressure, vm_stat, df) are never called; with SLOT_OS unset the source
# follows $OSTYPE. A job of a case that never ends is a failure after 90 s, not a stuck test.
H=${0:A:h:h}/scripts
zmodload zsh/datetime
T=$(mktemp -d "${${TMPDIR:-/tmp}%/}/slots-linux.XXXXXX"); T=${T:A}
export SLOTS_DIR=$T/slots SLOT_LEGACY_LOCK= SLOT_POLL=0.2 SLOT_SAY=1 SLOT_THIRD_WINDOW=1 SLOT_HIST_GAP=2
# hermetic inside an outer slot (heavy.sh node tests/run.js): drop what the outer slots.zsh exported, and the thresholds
# set outside (SLOT_SWAP_MIN_MB=0 on Linux): the cases rely on the defaults on the fake machine.
unset GUARDS_EXCLUSIVE_LOCK SLOT_JOURNAL SLOT_MEDIUM_N SLOT_HEAVY_N SLOT_TOTAL_MAX GUARDS_JOBS_ALONE GUARDS_JOBS_SHARED SLOT_EXCL_TOOLS SLOT_PATH SLOT_LABEL SLOT_KIND SLOT_RETRY_RC SLOT_SWAP_MIN_MB SLOT_THIRD_FREE_PCT SLOT_THIRD_SWAP_GROW_MB GUARDS_EXCL_GLOB GUARDS_EXCL_MARKER
export SLOT_OS=linux SLOT_PROC=$T/proc
J=$SLOTS_DIR/journal.tsv
mkdir -p $T/shared $T/wts $T/proc $T/noproc
print -r -- '{"repoDir": "'$T'/main", "worktreeRoot": "'$T'/wts", "sharedDir": "'$T'/shared"}' > $T/cfg.json
export CODIS_AGENTS_CONFIG=$T/cfg.json
# Fake macOS tools in front of PATH: they mark $T/mac.called (a Linux reading must never call them) and fail while
# $T/m.broken exists (case B10 on macOS); getconf PAGESIZE is 4096, as on x86-64 Linux.
mkdir -p $T/bin
print -r -- '#!/bin/zsh
[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"
: >> '$T'/mac.called; [[ -e '$T'/m.broken ]] && exit 1
print -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"' > $T/bin/sysctl
print -r -- '#!/bin/zsh
: >> '$T'/mac.called; print -r -- "System-wide memory free percentage: 80%"' > $T/bin/memory_pressure
print -r -- '#!/bin/zsh
: >> '$T'/mac.called; print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
print -r -- "Swapouts:                                   5."' > $T/bin/vm_stat
print -r -- '#!/bin/zsh
: >> '$T'/mac.called; print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"
print -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"' > $T/bin/df
print -r -- '#!/bin/zsh
[[ $1 == PAGESIZE || $1 == PAGE_SIZE ]] && { print 4096; exit 0 }; exit 1' > $T/bin/getconf
chmod +x $T/bin/*; export PATH=$T/bin:$PATH

# The fake /proc: values (kB, pages) in $T/p.*, published as meminfo and vmstat by a writer loop every 0.1 s (tmp + mv,
# a reader never sees half a file). p.step pages are added to pswpout and p.drop kB taken from SwapFree on every tick.
setp() { print -r -- $2 > $T/p.$1.tmp && mv -f $T/p.$1.tmp $T/p.$1 }
wproc() {
  print -r -- "MemTotal:       $(<$T/p.memtotal) kB
MemFree:          123456 kB
MemAvailable:   $(<$T/p.memavail) kB
Buffers:           10000 kB
SwapCached:            0 kB
SwapTotal:      $(<$T/p.swtotal) kB
SwapFree:       $(<$T/p.swfree) kB" > $T/proc/meminfo.tmp && mv -f $T/proc/meminfo.tmp $T/proc/meminfo
  print -r -- "nr_free_pages 30864
pgpgin 1000
pswpin 7
pswpout $(<$T/p.so)
pgfault 99" > $T/proc/vmstat.tmp && mv -f $T/proc/vmstat.tmp $T/proc/vmstat
}
setp memtotal 16000000; setp memavail 3200000; setp swtotal 30720000; setp swfree 20480000; setp so 0; setp step 0; setp drop 0
wproc
( while [[ ! -e $T/stop.writer ]]; do
    s=$(<$T/p.step) d=$(<$T/p.drop)
    (( s > 0 )) && setp so $(( $(<$T/p.so) + s ))
    (( d > 0 )) && setp swfree $(( $(<$T/p.swfree) - d ))
    wproc; sleep 0.1
  done ) &
WRITER=$!

pass=0 fail=0
ok() { if eval "$2"; then (( pass++ )); print -r -- "  ok   $1"; else (( fail++ )); print -r -- "  FAIL $1${3:+
       $3}"; fi }
started() { [[ -e $T/$1.start ]] }
waitlong() { local i; for i in {1..900}; do eval "$1" && return 0; sleep 0.1; done; return 1 }
# hjob <script> <name> - holds its slot until $T/rel.<name> exists; output (stdout and stderr) in $T/<name>.out
JP=()
hjob() { "$H/$1" zsh -c 'touch '$T'/$1.start; while [[ ! -e '$T'/rel.$1 ]]; do sleep 0.1; done; touch '$T'/$1.end' _ $2 > $T/$2.out 2>&1 & JP+=$! }
rel() { local n; for n; do touch $T/rel.$n; done }
lines() { local n; n=$(grep -c -- "$2" $T/$1.out 2>/dev/null); print -r -- ${n:-0} }
newline() { waitlong "(( \$(lines $1 '$2') > $3 ))" }
# once <name> <command...> - heavy.sh <command> in the background, its code in $T/<name>.rc (a hang is a failure,
# not a stuck test: "hang" after 90 s); stdout in $T/<name>.out, stderr in $T/<name>.err
once() {
  local n=$1; shift
  ( "$H/heavy.sh" "$@" > $T/$n.out 2> $T/$n.err; print -r -- $? > $T/$n.rc ) & local p=$!
  waitlong "[[ -s $T/$n.rc ]]" || { pkill -P $p 2>/dev/null; kill $p 2>/dev/null; print -r -- hang > $T/$n.rc }
}
rc() { print -r -- $(<$T/$1.rc) }
# clean - the jobs of the case end; one still running after 90 s is a failure, killed, never an endless wait of the test
clean() {
  local p live
  waitlong 'live=(); for p in $JP; do kill -0 $p 2>/dev/null && live+=$p; done; (( ! ${#live} ))' || {
    (( fail++ )); print -r -- "  FAIL a job of the case still waits after 90 s (killed): pids $live"
    for p in $live; do pkill -P $p 2>/dev/null; kill $p 2>/dev/null; done }
  wait $JP 2>/dev/null; JP=(); rm -f $T/*.start(N) $T/*.end(N) $T/rel.*(N)
}

# pub <meminfo line> - wait until the writer loop has published it (a job started before that reads the old value:
# in the Ubuntu container the first medium got its slot on SwapFree 20000 MB, 3 runs of 3)
pub() { waitlong "grep -qx -- '$1' $T/proc/meminfo" || print -r -- "  (not published in 90 s: $1)" }

# B2/B8. SwapFree 1000 MB < 4096: even the first medium waits, with the number of /proc/meminfo
setp swfree 1024000; pub 'SwapFree: *1024000 kB'
hjob medium.sh s1
newline s1 'waiting for slot medium' 0
ok 'B2/B8. SwapFree 1024000 kB = 1000 MB < 4096 - the first medium waits and names the capacity' '! started s1 && grep -q "swap: capacity 1000 MB < 4096" $T/s1.out' "$(cat $T/s1.out)"
setp swfree 20480000
waitlong 'started s1'
ok 'B2/B8. SwapFree back to 20000 MB - it went' 'started s1' "$(cat $T/s1.out)"
rel s1; clean

# B7. no swap at all and the default threshold: refusal at once, with the numbers, code 78
setp swtotal 0; setp swfree 0; pub 'SwapTotal: *0 kB'; pub 'SwapFree: *0 kB'
rm -f $J
once nsw zsh -c 'touch '$T'/nsw.ran'
ok 'B7. SwapTotal 0, threshold 4096 - heavy.sh exits 78 at once (not an endless wait)' '[[ $(rc nsw) == 78 ]]' "code $(rc nsw); $(cat $T/nsw.out $T/nsw.err)"
ok 'B7. ... the command did not run' '[[ ! -e $T/nsw.ran ]]'
ok 'B7. ... one refusal line on stderr, nothing on stdout' '[[ $(wc -l < $T/nsw.err) -eq 1 && ! -s $T/nsw.out ]]' "$(cat $T/nsw.out $T/nsw.err)"
ok 'B7. ... it names the numbers: SwapTotal 0, the threshold 4096 MB, MemTotal 15625 MB, MemAvailable 3125 MB' \
  'grep -q "SwapTotal 0" $T/nsw.err && grep -q "4096 MB" $T/nsw.err && grep -q "MemTotal 15625 MB" $T/nsw.err && grep -q "MemAvailable 3125 MB" $T/nsw.err' "$(cat $T/nsw.err)"
ok 'B7. ... and the way out: SLOT_SWAP_MIN_MB=0 switches the swap check off' 'grep -q "SLOT_SWAP_MIN_MB=0" $T/nsw.err' "$(cat $T/nsw.err)"
jl=( "${(@s:	:)$(tail -1 $J 2>/dev/null)}" )
ok 'B7. ... journaled: acquire "-", rc 78' '[[ $jl[3] == - && $jl[9] == 78 ]]' "$(tail -1 $J 2>/dev/null)"
ok 'B7. ... no queue ticket left behind' '[[ -z $(print -r -- $SLOTS_DIR/queue/<->(N)) ]]' "$(ls $SLOTS_DIR/queue)"

# B9. threshold 0: the swap check is off - no refusal, no waiting, no note (even when meminfo cannot be read)
SLOT_SWAP_MIN_MB=0 once off0 zsh -c 'exit 7'
ok 'B9. SwapTotal 0 and SLOT_SWAP_MIN_MB=0 - the command runs, its code 7 comes back' '[[ $(rc off0) == 7 ]]' "code $(rc off0); $(cat $T/off0.out $T/off0.err)"
ok 'B9. ... nothing said about swap' '! grep -qi swap $T/off0.out $T/off0.err' "$(cat $T/off0.out $T/off0.err)"
SLOT_SWAP_MIN_MB=0 SLOT_PROC=$T/noproc once off1 zsh -c 'exit 7'
ok 'B9. SLOT_SWAP_MIN_MB=0 and no meminfo - runs, no "not measured" note' '[[ $(rc off1) == 7 ]] && ! grep -qi "swap\|measured" $T/off1.out $T/off1.err' "code $(rc off1); $(cat $T/off1.out $T/off1.err)"
setp swtotal 30720000; setp swfree 20480000; sleep 0.3

# B4. the extra heavy slot is off on Linux by default, even with plenty of memory and flat swap
setp memavail 14400000
hjob heavy.sh a1; hjob heavy.sh a2
waitlong 'started a1 && started a2'
hjob heavy.sh a3
newline a3 'waiting for slot heavy' 1
ok 'B4. two heavy run, the third waits at 90 % MemAvailable: extra slot off on Linux' '! started a3 && grep -q "extra slot: off on Linux" $T/a3.out' "$(cat $T/a3.out)"
ok 'B4. ... the line says how to switch it on (SLOT_THIRD_FREE_PCT)' 'grep -q "SLOT_THIRD_FREE_PCT" $T/a3.out' "$(tail -1 $T/a3.out)"
rel a1; waitlong 'started a3'; rel a2 a3; clean

# B5. SLOT_THIRD_FREE_PCT set explicitly: MemAvailable / MemTotal as the minimum over the window
setp memavail 3200000
hjob heavy.sh b1; hjob heavy.sh b2
waitlong 'started b1 && started b2'
SLOT_THIRD_FREE_PCT=50 hjob heavy.sh b3
waitlong 'grep -q "free 20%" $T/b3.out'
ok 'B5. explicit SLOT_THIRD_FREE_PCT=50, MemAvailable 3200000 / MemTotal 16000000 = 20 % - the third waits' '! started b3 && grep -q "extra slot: free 20% < 50%" $T/b3.out' "$(cat $T/b3.out)"
setp memavail 11200000
waitlong 'started b3'
ok 'B5. MemAvailable 70 % over the whole window - the third went (3 heavy at once)' 'started b3 && [[ ! -e $T/b1.end ]]' "$(cat $T/b3.out)"
rel b1 b2 b3; clean

# B6. swap-out: pswpout grows 100000 pages (x 4096 = 390 MB) every 0.1 s - the extra slot is refused, by the counter
hjob heavy.sh c1; hjob heavy.sh c2
waitlong 'started c1 && started c2'
setp step 100000; sleep 0.5    # the growth is in the history before the third asks (no window of flat samples)
SLOT_THIRD_FREE_PCT=50 hjob heavy.sh c3
waitlong 'grep -q "swapped out" $T/c3.out'
ok 'B6. pswpout x PAGESIZE grows - the third waits: "MB swapped out"' '! started c3 && grep -q "extra slot: swap - [0-9]* MB swapped out in 1 s" $T/c3.out' "$(cat $T/c3.out)"
setp step 0
waitlong 'started c3'
ok 'B6. the counter stands still - the third went' 'started c3' "$(tail -3 $T/c3.out)"
rel c1 c2 c3; clean

# B3. swap used = SwapTotal - SwapFree grows (SwapFree drops 300000 kB = 293 MB every 0.1 s), pswpout flat - refused
setp swtotal 102400000; setp swfree 92160000
hjob heavy.sh d1; hjob heavy.sh d2
waitlong 'started d1 && started d2'
setp drop 300000; sleep 0.5
SLOT_THIRD_FREE_PCT=50 hjob heavy.sh d3
waitlong 'grep -q "swap grew by" $T/d3.out'
ok 'B3. SwapTotal - SwapFree grows - the third waits: "swap grew by"' '! started d3 && grep -q "extra slot: swap grew by [0-9]* MB in 1 s" $T/d3.out' "$(cat $T/d3.out)"
setp drop 0
waitlong 'started d3'
ok 'B3. used stands still - the third went' 'started d3' "$(tail -3 $T/d3.out)"
rel d1 d2 d3; clean
setp swtotal 30720000; setp swfree 20480000; sleep 0.3

# The source follows the OS by default ($OSTYPE: "linux-gnu" -> linux, "darwin25.0" -> darwin); SLOT_OS overrides it.
osd() { ( unset SLOT_OS; OSTYPE=$1; source $H/slots.zsh >/dev/null 2>&1; print -r -- $SLOT_OS ) }
ok 'SLOT_OS unset: OSTYPE linux-gnu -> linux, darwin25.0 -> darwin, freebsd14.1 -> freebsd (not measured)' \
  '[[ $(osd linux-gnu) == linux && $(osd darwin25.0) == darwin && $(osd freebsd14.1) == freebsd ]]' \
  "linux-gnu -> $(osd linux-gnu), darwin25.0 -> $(osd darwin25.0), freebsd14.1 -> $(osd freebsd14.1)"
ok 'Linux readings never called the macOS tools (sysctl, memory_pressure, vm_stat, df)' '[[ ! -e $T/mac.called ]]'

# B10. a source that cannot be read: the slot is given with one note, the extra slot is refused as not measured
SLOT_PROC=$T/noproc once nm1 zsh -c 'exit 7'
ok 'B10. Linux without meminfo - the command runs, code 7' '[[ $(rc nm1) == 7 ]]' "code $(rc nm1); $(cat $T/nm1.out $T/nm1.err)"
ok 'B10. ... one line "swap not measured ... - not checked" naming the file' '[[ $(grep -c "swap not measured" $T/nm1.err) -eq 1 ]] && grep -q "$T/noproc/meminfo" $T/nm1.err && grep -q "not checked" $T/nm1.err' "$(cat $T/nm1.err)"
SLOT_OS=plan9 once nm2 zsh -c 'exit 7'
ok 'B10. an unknown OS (SLOT_OS=plan9) - runs, code 7, "swap not measured" naming the OS' '[[ $(rc nm2) == 7 ]] && grep -q "swap not measured.*plan9" $T/nm2.err' "code $(rc nm2); $(cat $T/nm2.out $T/nm2.err)"
: > $T/m.broken
SLOT_OS=darwin once nm3 zsh -c 'exit 7'
ok 'B10. macOS with a failing sysctl vm.swapusage - runs, code 7, "swap not measured" (was: capacity 0 MB, endless wait)' '[[ $(rc nm3) == 7 ]] && grep -q "swap not measured.*sysctl" $T/nm3.err' "code $(rc nm3); $(cat $T/nm3.out $T/nm3.err)"
rm -f $T/m.broken
# the extra slot with an explicit threshold but nothing to measure: refused as "not measured"
SLOT_PROC=$T/noproc hjob heavy.sh e1; SLOT_PROC=$T/noproc hjob heavy.sh e2
waitlong 'started e1 && started e2'
SLOT_THIRD_FREE_PCT=50 SLOT_PROC=$T/noproc hjob heavy.sh e3
waitlong 'grep -q "extra slot:" $T/e3.out'
ok 'B10. explicit SLOT_THIRD_FREE_PCT, no meminfo - the third waits: "extra slot: memory not measured"' '! started e3 && grep -q "extra slot: memory not measured" $T/e3.out' "$(cat $T/e3.out)"
rel e1; waitlong 'started e3'; rel e2 e3; clean

touch $T/stop.writer; wait $WRITER 2>/dev/null
rm -rf $T
print -r -- "TOTAL: $pass ok, $fail fail"
(( fail == 0 ))
