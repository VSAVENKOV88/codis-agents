#!/usr/bin/perl
# Process groups of the memory slots (scripts/slots.zsh, scripts/slot-holder.zsh). zsh can neither make a process the
# leader of a new group nor tell EPERM from ESRCH after kill(2); perl does both with its core modules (/usr/bin/perl on
# macOS; the remote runner requires perl already, scripts/corpus-remote.js).
#   lead <command...>           this process leads a new group, then becomes the command (the slot holder)
#   run <slot> <command...>     the same for the command of a slot, which first names its group in the exec marker
#                               <slot>.exec.<pgid> (content "<pgid>", written as <slot>.exectmp.<pgid> and renamed into
#                               place: a reader never sees half a marker, and no code of the command runs before it);
#                               with SLOT_EXEC_NOTE set it also appends "<pgid>" to that file (the train lock,
#                               scripts/train-lock.js); the command does not inherit SLOT_EXEC_NOTE
#   alive <pgid...>             0 when any of the groups lives: kill(-pgid, 0) succeeds, or fails with EPERM (a group of
#                               another user, or a group whose only members are zombies - macOS answers EPERM for it);
#                               1 when all are gone (ESRCH). A pgid below 2 counts as alive: kill(-1, 0) would ask about
#                               every process, and no slot command has such a group
#   pgrp                        prints the process group of the caller (perl inherits it)
#   stop <pgid> <grace> <wait>  TERM and CONT to the group (CONT: a member stopped by SIGTTIN or SIGTSTP gets the TERM),
#                               up to <grace> s for it to be gone, then KILL and up to <wait> s more; polls every 0.1 s
#                               (the period slot_run waits for its holder); 0 - gone, 1 - not gone. The perl of `run`
#                               before its setpgrp (no group <pgid> yet) gets the same signals as the pid <pgid>. It
#                               is the only place that signals the command of a slot
# Exit codes of lead and run when the command cannot start: 127 not found, 126 not executable (as zsh), 72 no new
# group, 73 the marker cannot be written (the command does not run unmarked).
use strict;
use warnings;
use POSIX ();
use Time::HiRes ();

sub alive {
  for my $g (@_) {
    return 1 unless $g =~ /^\d+$/ && $g > 1;
    return 1 if kill(0, -$g) || $! + 0 == POSIX::EPERM();
  }
  return 0;
}

sub newgroup { setpgrp(0, 0) or do { print STDERR "slot_run: refused - setpgrp: $!\n"; exit 72 } }

sub become {
  { no warnings 'exec'; exec { $_[0] } @_; }
  my $e = $! + 0;
  print STDERR "slot_run: $_[0]: $!\n";
  exit($e == POSIX::ENOENT() ? 127 : 126);
}

my $cmd = shift @ARGV // '';
if ($cmd eq 'lead') {
  newgroup();
  become(@ARGV);
} elsif ($cmd eq 'run') {
  my $slot = shift @ARGV;
  newgroup();
  my ($tmp, $mark) = ("$slot.exectmp.$$", "$slot.exec.$$");
  my $f;
  unless (open($f, '>', $tmp) && print($f "$$\n") && close($f) && rename($tmp, $mark)) {
    print STDERR "slot_run: refused - the exec marker $mark cannot be written: $!\n";
    unlink $tmp;
    exit 73;
  }
  if (defined(my $note = delete $ENV{SLOT_EXEC_NOTE})) {
    if ($note ne '' && open(my $n, '>>', $note)) { print $n "$$\n"; close $n; }
  }
  become(@ARGV);
} elsif ($cmd eq 'alive') {
  exit(alive(@ARGV) ? 0 : 1);
} elsif ($cmd eq 'pgrp') {
  print getpgrp(0), "\n";
} elsif ($cmd eq 'stop') {
  my ($g, $grace, $wait) = @ARGV;
  exit 64 unless defined $g && $g =~ /^\d+$/ && $g > 1;
  # Before its setpgrp the perl of `run` is the pid <g> in the caller's group (the holder's) and the group <g> does not
  # exist yet: the signal then goes to that pid, so it dies before the command starts. A pid <g> in any other group is
  # never signalled (a pid reused after the leader was reaped); a group made between the two calls gets the signal by
  # the second call to it. That perl dies at once, so only the group is waited for.
  my $pre = sub { my $p = getpgrp($g); $p > 0 && $p == getpgrp(0) };
  my $sig = sub { kill($_[0], -$g) || ($pre->() && kill($_[0], $g)) || kill($_[0], -$g) };
  $sig->('TERM');
  $sig->('CONT');
  for my $i (0, 1) {
    my $until = Time::HiRes::time() + (($i ? $wait : $grace) // 0);
    while (alive($g) && Time::HiRes::time() < $until) { select(undef, undef, undef, 0.1); }
    exit 0 unless alive($g);
    $sig->('KILL') unless $i;
  }
  exit 1;
} else {
  print STDERR "usage: slot-group.pl lead|run|alive|pgrp|stop ...\n";
  exit 64;
}
