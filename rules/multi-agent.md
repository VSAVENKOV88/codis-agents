# Multi-agent work: process rules

These are the rules of the codis-agents process. A project imports them from its `CLAUDE.md`
(`@<plugin>/rules/multi-agent.md`, or a copy) so that the coordinator session follows them.

Workflow agents do **not** see `CLAUDE.md`: a rule reaches a role only through its prompt. Lines marked
`<!-- role:<id> -->` are therefore carried into every role prompt by `workflows/role-chain.js` (`RULE_LIST`, same id),
and `tests/role-chain.test.js` fails when a marked line has no rule or a role prompt lacks one.

## Roles

Larger changes run as a chain of agents, each in its own role:

- **Coordinator.** The main session. Writes `BRIEF.md`, launches and routes roles, merges accepted branches and resolves
  merge conflicts. Does not write product code inside a role's task. When roles disagree or the brief does not answer a
  question, it decides by three layers, in this order:
  1. **Follows from an accepted principle** of the arc (its numbered `PRINCIPLES.md`): the coordinator decides itself,
     writes "decided by principle N" into the brief and tells the owner in one line.
  2. **No principle answers it, but the answer is reversible and local** (one task; not a storage format, an address,
     sharing, data deletion or security): the coordinator decides itself, writes "coordinator's decision, not from the
     model - candidate" into the brief and lists it in its report, where the owner can overturn it.
  3. **Everything else goes to the owner**: anything the owner judges by the screen (look, placement, wording of the
     UI), anything new (scope, a new principle), irreversible, or two principles in conflict. Questions are collected
     and sent as one list at a seam between tasks, each with a recommendation. (A "local" layout decision taken from a
     mockup had to be redone: what is judged by the screen is never decided by an agent.)
  - Only the coordinator writes the owner's decisions into a brief: verbatim, dated, in the same turn, before the next
    action. A role that meets an open question writes it into its own report as "❓ coordinator:" and does not answer it itself (a programmer once recorded "owner's answers" that the owner never gave). <!-- role:decisions -->
  - The coordinator's own context grows too: around 700k it saves the continuation point and continues in a fresh
    session or after a compaction, in a pause between runs (an early compaction loses the owner's exact words).
- **Analyst or diagnoser.** Goes before the programmer when the work needs a spec, or when a defect needs its cause
  found first. A diagnosis costs little and halves code rejections, so use it by default for defects.
  - Every chain task carries exactly one of `analystFirst`, `analysis`, `noAnalysis`. A reused analysis is named per task
    (`analysis`: the path of the earlier analyst or diagnosis report), not left in free text, so the programmer gets it
    by name and the Analyst phase shows it. Skipping a diagnosis for a defect needs a written reason (`noAnalysis`).
    With no marker or several the chain does not start the task: it does not guess whether a task is a defect.
  - Every chain task also carries exactly one `kind`: `feature`, `defect` or `tail`. Without it, or with any other
    value, the task stops before any agent, with no guess from its other fields. A `feature` without `useCases` and
    without `useCasesFirst` stops too, before any agent ("feature without use cases"): no tokens go into a feature
    whose use cases nobody wrote. A defect or a tail needs no use cases.
  - **A feature gets its own analysis; the arc specification does not replace it.** `analysis` names a matrix of cases
    or a diagnosis of this task: an absolute path inside the task's folder, or inside the folder of the feature it was
    split from (task field `feature`). The arc specification goes into the separate field `spec`: every role gets it as
    context, and an `analysis` equal to it or outside those folders stops the task before any agent. A task without its
    own analysis is either `analystFirst` or a tail with `noAnalysis` and a named reason ("the arc specification covers
    it" is not one; the preconditions refuse it). Why: tasks that had only the arc specification had 44 % red testers
    and 2.4 programmer rounds, tasks with their own analysis 24 % and 1.65: the specification describes the surface, not
    the matrix of the task.
  - **Use cases before the matrix, for a feature** (not a defect, not a tail). The analyst's first step is the use
    cases, `use-cases.md` in the folder of the task or of the feature: for every use case the actor, trigger, main flow,
    alternative flows, errors, out of scope. The open questions of the use cases go to the owner as one list and are
    settled with the owner before the matrix of cases; every cell of the matrix then cites its use case. Every role gets
    the use cases as context (task field `useCases`, a path inside the task's or feature's folder, like `analysis`); the
    tester builds the acceptance along the flows (main, alternative, errors), the reviewer checks that the alternative
    flows and errors are closed too, not only the main flow. In the chain: `useCasesFirst` (`true`, with `analystFirst`):
    the analyst writes only the use cases with their questions and the task stops with status `use-cases-review`;
    after the review with the owner the coordinator relaunches it with `useCases` set to that path and `analystFirst`
    (the matrix on the use cases).
    Why: questions were born during the task instead of before it - in one task about 40 questions to the coordinator on
    the way and 8 programmer rounds, almost all from one flow nobody had written down (an AI edited the code, then a
    person sent the result back).
  - For a feature with several dimensions the analyst first writes a matrix of cases into the brief (every dimension:
    states x events x environments). Without it each round closed one cell and broke the next.
  - **Split the task before the first programmer** if any holds: the matrix has more than ~30 cells; it spans more
    than two subsystems; acceptance depends on a question the owner has not answered; or the change lifts an
    "inactive while ..." restriction (that creates new pairs of transports). Rounds grow with the number of dimensions,
    not with lines of code.
- **Programmer.** Commits a red guard first, then the code: for a defect the guard reproduces it; for a feature it is
  the brief's acceptance scenario turned into a test before any code.
- **Tester.** Builds an inventory independently of the programmer (routes, controls, places) and compares the two.
  Adds guards and mutation-tests them after committing. Does not edit product code. Runs the brief's acceptance
  scenario in the real environment and puts the evidence (log, screenshot, numbers) into `test.md`.
- **Reviewer.** Reads only and tries to refute the claim; may rerun guards. Checks the tester's evidence against the
  acceptance scenario rather than re-running the scenario. Gives a verdict of done or rejected, with file:line. Do not
  lower the reviewer's effort: it pays for itself (security holes, a guard fed data the server never sends).
- **Security reviewer.** Only when the brief marks the task as security work (accounts and login, connectors and OAuth,
  access passes, rollout to a host). Reads the diff with an attacker's view against the project's threat model.

## Arcs: specification, principles, mockups

- **An arc starts with a specification agreed with the owner before its first task.** An arc (a set of tasks over one
  surface) is specified up front, not discovered task by task. What the specification holds depends on the arc: use
  cases, user flows, a state model with an action x state matrix over the whole surface (not one task), cross-cutting
  rules (errors, retry, cancel, codes, navigation, security), the look of every state. The analyst writes it; its open
  questions go to the owner as one list and are answered in one sitting. Tasks then cite its cells and do not reopen
  them. (A specification that covered only the architecture left the behaviour to be settled piecemeal, task by task:
  about ten owner questions per task.)
- **One numbered `PRINCIPLES.md` per arc**, every accepted decision with its source and date, and a new decision with
  a "Replaces: N" line naming the one it overturns, so no rule exists in several versions (one decision flipped three
  times before this rule). A decision that is not in the principles is lost.
- **A mockup of all states before code** for whatever the owner judges by the screen: one page with every state (rows,
  buttons, hints) is shown to the owner before the programmer starts. It costs less than the fix rounds that the first
  look at the live screen otherwise starts.
- Living specs change in the same commit as the behaviour they describe (UX specs, state models, gap lists): a spec left behind at one redesign says nothing about what came after. <!-- role:specs -->

## Order and shortcuts

- If the tester finds red, skip the review and send the task straight back to the programmer.
- **A red from the environment goes to the coordinator, not to the programmer.** The tester tells a red of the product
  from a red of the environment (a full run cut off before its tally, the slot queue refused the job, disk or swap
  exhausted, Docker down; a long queue while its own process is alive is not one) and gives the latter its own verdict, `environment`, with the cause and its evidence; the workflow stops the
  task with that cause, and the coordinator frees the machine and relaunches it. The preconditions check free disk and
  swap headroom (`scripts/env-check.js`, floors in the machine file, `minFreeDiskGB` and `swapMinMB`: by default 10 GB
  of disk and 4000 MB of swap, so a 4 GiB swap passes; older `preconditions` keys of a project config apply only with
  no machine file). Why: programmer rounds "without changes" after such reds cost about 3.3M tokens in one window.
- **A new red is first rerun alone.** After a red full run `guards-all.sh` reruns each new red by itself in the same slot (project config `guardRerun`): red again alone - a new red, a regression for the programmer; green alone - flaky, red only under load: not a regression and not sent to the programmer as one, but named in the role's report and written into the project backlog by the coordinator. Known reds of the project (config `guardBaseline`, each with its reason) are subtracted first and never rerun. With `guardBaseline` a guard green alone is also written into the project's quarantine (`<sharedDir>/guards-quarantine.json`, outside the worktree, the same format `{"<guard>": "flaky: <run>, green alone, <date>"}`), which every later run subtracts as known; the coordinator moves its entries into `guardBaseline` and commits them (`guards-result.js quarantine-take`), or drops one after its fix (`quarantine-drop`); an entry `flaky:` is never named as "not red now". On the remote runner the quarantine of this machine goes with the run and is subtracted there read-only; this machine writes the flaky guards of the log that comes back, and a broken quarantine or one the runner cannot take is an environment red (69), never a run without it. A flaky guard of a task's selection (not a full run) goes only into the role's report. A full run on the same HEAD with a clean tracked tree that ended without a repeated new red is not run again: `guards-all.sh` prints "reused, HEAD <sha>" with the saved summary (`--force` runs anyway). <!-- role:rerun -->
  Why: 6 of 17 full runs ended red only from guards unstable under load, and each cost a programmer round or a stopped
  task.
- On rejection: a fix round, then a second review. A second rejection for a code defect sends the task to the analyst
  (cases, cause) inside the same run, then one more full round; a third rejection goes to the coordinator. A question
  of scope goes to the owner.
- **The second red tester round sends the task to the analyst, like the second rejection.** Red tester verdicts for the product are counted per task: the second one, in any cells (not only the same ones), sends the task to the analyst inside the same run; the analyst writes the matrix of cases from the tester's findings (`test.md`, every round) and their cause (`prog.md`), then one round programmer -> tester -> review on that matrix; a red tester round after that analyst goes to the coordinator (the task stops with that cause). A red of the environment (verdict `environment`) does not count; the light mode has no tester, so the rule does not apply there. The tester names every failed case in `test.md` with its expected and actual result, so the analyst builds the matrix from them. Only one analyst runs inside a run: after the analyst of the second rejection the tester rounds stay as they were. <!-- role:testerred -->
  Why: cvm-xy-1 (2026-10-23) went tester -> programmer four times in a row, each red opening a new cell of a matrix
  nobody had written; the chain counted only rejections, so it never stopped for the analyst.
- A rejection only for docs, guard wording or comments is fixed by the programmer and re-reviewed on that diff only,
  without a tester round. The workflow checks the claim: a fix that touches only docs and the guard files the tester
  may change (`testerWritable`) goes straight to the second review; a fix that touches other files (a comment in
  product code) goes to the second review too, which must confirm on the diff that it changes no behaviour
  (`fixBehaviourUnchanged`); only an unconfirmed fix gets a tester round. Why: when only `.md` and `docs/` counted,
  4 of 5 such rejections still went through the tester for a stale comment in a `.js` or `.html` file.
- **A fix round reads the findings and the diff, and mutates only the guards of its fix.** A programmer round after the first (after a red tester, a red full run or a rejection) is a new agent: its prompt names the report with the findings (`test.md`, `review.md` or the log of the full run) and the task's diff; it reads the brief, the analysis and the arc specification only in the sections the findings cite, of `prog.md` only the last round, and mutates only the guards new or changed in this round (the diff of the round from the HEAD before it), the guards the findings name (a finding "guard G has no mutation" is fixed by mutating G) and the guards that cover the product code changed in it, not the whole table again. The first round, and the first round after an analyst (a new matrix), read and mutate as before. <!-- role:fixround -->
  Why (audit of 2026-10-24, P5): the workflow runtime does not continue an agent, so every fix round reread the brief, the analysis, `prog.md`, `test.md` and the code - 33 % of its input, a median of 0.13M per round, about 8M in the measured window - and mutated every guard again (1.3-2.9M).
- **One full guard run per task, run by the workflow after the programmer's last commit.** With `guardSubsetCommand` in the project config the programmer runs only its new guards and mutations, never the selection and never the full suite: the workflow runs `guards-all.sh` once on its HEAD as a wait step (`scripts/wait-step.js`, a cheap agent waiting in slices of at most 270 s while no role waits, for as long as the run is alive), and that full run includes every guard of the selection (the contract of the key: `guardSubsetCommand` narrows `guardCommand` to the selected guards of the same suite). Red (after the rerun of new reds) - a programmer round with the log, then the full run again; exit 124 (the deadline of the step) or a refusal of the slot queue before the run (exit 77, 78) is a red of the environment: `environment`, the task stops for the coordinator; green - the tester, who reuses that log, runs its own guards, mutations and, after its own commits, their selection by `scripts/guards-select.js` (changed guards, guards that import a changed file or name it, plus the project's `guardAlways`, such as scanners of the diff), not the full suite. A HEAD whose full run is done is not run again. Without the key the programmer runs the full run itself and the tester reuses its log. <!-- role:onerun -->
  Why (measurement 2026-10-10..20, 73 tasks): 3.9 full runs per task took about 81 min, 37 % of a task's calendar
  (up to 64 %); about 80 % of their new reds were the environment, flaky guards or an expectedly red new guard; real
  findings in other guards came in 26 % of tasks (6-7 product regressions, 12 stale guards). Selection by imports alone
  caught 1 of 6 of those regressions, by imports plus the names of the changed files all of them; the one full run
  catches the rest before acceptance.
- **Light mode for small tasks** (task field `mode: "light"`). For a task of up to ~100 lines of product in one subsystem, not on the attack surface (no security work, no routes or access classes) and whose acceptance needs no Docker stack, the coordinator may choose it, and the owner may overturn it: preconditions -> one programmer-checker (brief, red guard, code, mutations after the commit, its own acceptance with evidence in `test.md`) -> the same one full run -> one reviewer, who only reads. No tester role and no tester post-check; the reviewer's git post-check and the leftovers check run as usual. A rejection -> a programmer round -> the second review; a second rejection goes to the coordinator with the proposal to relaunch the task in the full mode.
  Why: tasks of up to 100 lines of product took 2-2.6 h through the chain against about 0.6 h in one session.
- After the tester and after each reviewer, a git post-check (`scripts/role-diff-check.js`) compares the worktree with
  the HEAD of the previous committing role: the tester may change only guards and their fixtures, a reviewer nothing.
  A violation stops the chain. A post-check that fails (or returns nothing) is repeated once by the default model (the
  roles' model when the project config names one) and
  the second answer decides: a cheap agent sometimes reports a failure without running the script, while the script
  itself gives the same answer twice.
- **One post-check agent after the tester; the reviewers together.** After the tester one service agent runs the git post-check and the leftovers post-check in one command (`scripts/role-post-check.js`, one JSON with both answers); with security work the reviewer and the security reviewer run at the same time on the same HEAD, and one git post-check after both: neither may change the worktree, a change by either stops the task, a rejection by either is a rejection. <!-- role:postcheck -->
  Why (plugin audit 2026-10-24, P2 and P3): two service agents per tester round each paid a system prompt and the tool
  descriptions for one deterministic command, and the security reviewer waited for the reviewer and its post-check
  although both only read.
- **Do not resume a multi-task workflow run with `resumeFromRunId`.** Cached agent results replay by call order; with
  tasks in parallel the order differs, so results land in the wrong task (after a pause one task's programmer HEAD
  became another task's base, and the post-check stopped both chains on files their testers never touched). Relaunch
  each unfinished task alone, with `start` pointing to its report and the step it stopped at.
- **Check the seam of parallel branches.** After merging the second of parallel branches that touched the same files,
  the coordinator runs the new and touched guards of both tasks, then the full guard run. Each branch was green alone;
  after such a merge one guard gave six red from the seam alone. After any other merge the coordinator runs a full
  guard run only at a seam: when the merged branch and another branch merged since the last full run touched the same
  files; otherwise the CI of the branch decides (each task already had its one full run).

## Task folder and reports

- **One shared directory per task**: `<sharedDir>/<task>/` holds `BRIEF.md` and one report per role (`analyst.md`,
  `prog.md`, `test.md`, `review.md`, `review-sec.md`).
- Agents write their report as they go. A restarted agent resumes from its report plus `git log`, not from scratch. The report always ends with an up-to-date line "Next step: ...". <!-- role:report -->
- The brief states the owner's acceptance as a scenario in the real environment ("Add -> the item builds with no tab
  open"), not just a feature name. The review checks the scenario, not the wording.
- A workflow gives agents only tasks the owner asked for, and says so explicitly; an agent that sees "the owner asked only for H" next to task F refuses F. <!-- role:scope -->

## Waiting, context and cost

- **Never sit idle longer than 270 s at a time.** Prompt caches of workflow agents expire after about 5 minutes; after a longer pause the whole context is written again (such pauses were 21 % of all token spend before this rule, 7.4 % after it). Run anything long through Bash `run_in_background` and wait with Monitor in slices of at most 270 s. An agent with no output for 10 minutes is killed. A long deterministic step (the one full guard run of a task) is waited for by the workflow's wait step, a cheap agent, not by a role. A role waits for its own heavy commands itself, in slices, while its process is alive in the slot queue or running, and does not end its work to wait: the chain has no status "continue after the wait" (a role returns only its verdict), and a handover would not pay (in a long episode a role spends about 0.37-0.43M per hour of waiting, while a fresh role costs 0.13-0.33M to read in plus about 0.06M per handover, and the waiting itself remains). <!-- role:pauses -->
- **Context about 200k is a cost signpost, not a limit.** Every call re-reads the whole context, so a step at 400k costs twice a step at 200k. Past ~200k an agent finishes its current stage instead of starting a new large one; if much work remains, it writes the report with its next step and hands over to a fresh agent; if the task is nearly done, it finishes itself. <!-- role:context -->
- Size the task so one programmer can finish it (see "Split the task") rather than relying on the handover.
- After a run, `scripts/chain-cost.js` computes the cost of each task from the transcripts and flags tasks above twice
  the median (`medianTaskIE`); the next similar task is split.
- **Cost is also counted per feature.** The parts of a split feature carry the same task field `feature` (named
  explicitly, never guessed from a common key prefix); `chain-cost.js` sums them across all the runs it is given and
  flags the feature above `featureIELimit` (default 3 x `medianTaskIE`, about 15M), next to the flag per part. Why:
  parts stayed under their own flag (above 10M only 4 of 62) while whole features cost 8-30M.

## Machine and environment

- **Heavy work goes through memory slots, not one shared lock.** Light (read-only agents, guards without a bundler, browser or tsc): no slot. Medium (<= 0.85 GB: tsc, a plugin build, one bundler build without a browser): `scripts/medium.sh <cmd>`. Heavy (~1 GB+: browser and bundler guards, full guard runs, measurements, docker image builds and test stacks): `scripts/heavy.sh <cmd>` and `scripts/guards-all.sh <worktree>`, run by a role only through Bash `run_in_background` and waited for with Monitor in slices of at most 270 s, never as a blocking Bash call: the Bash timeout kills the waiter, the slot's trap drops its ticket, and it rejoins the queue at the end. <!-- role:slots -->
- **Every slot hold is journaled**, so the queue for a slot can be told from the job itself: one line per hold in
  `<lockDir>/journal.tsv` (request, acquire, release, class, slot, pid, worktree, short command, exit code; a failed
  write never stops the slot). `scripts/slot-journal.js --since <2d>` gives queue wait and hold, total and median, per
  class and per worktree.
- A full guard run picks its worker count from what else holds heavy slots: all full runs together never exceed the
  budget (`slots.jobsAlone`).
- Guards that share a resource (a fixed port, a shared temp dir or corpus file, a docker project) carry
  `// guards:exclusive — <reason>` (the comment marker of the project's language, config key `guardExclusive`) and
  run one at a time under their own lock.
- **Docker.** The owner's stack is read-only for roles (`docker cp` out is fine); writing into its containers needs explicit consent. Only a tester runs its own stack, and only when the brief asks for one; afterwards it removes that stack with its images and volumes: `docker compose -p <stack> down -v --rmi all`. The owner's stack and its images are never removed; other images and the shared build cache are not cleaned by roles (that is the coordinator's or the owner's call). A post-check, `scripts/role-leftovers-check.js`, runs after the tester and at the end of the task: what the task left (containers, networks, volumes and images labelled with its compose project, processes whose cwd or argv lies in its worktree, slots they hold) it removes and writes into the task's `leftovers.md`; what it cannot remove stops the task. <!-- role:docker -->
- **At most two chains with acceptance in Docker at once.** An acceptance stack (several services, its image build, a
  browser driving it) is the heaviest job on a 16 GB machine; the coordinator starts a third such chain only after one
  of the two is done. Acceptance on the project's shared stand does not count: its testers queue for the ticket.
- **A project with a shared stand (config `stand`) accepts in that one stand, by ticket, instead of a stack per task.** The tester takes the ticket (`scripts/stand.sh take`, kept running in the background: that process is the holder), deploys the committed HEAD of its worktree (`stand.sh deploy`, in a medium slot), runs the acceptance and releases the ticket (`stand.sh release`: the project's reset runs first); waiters queue in order, a dead holder frees the ticket, the stand is reset before every holder. A task whose commits change the stand's image files (`stand.sh image-diff --base <ref>`, config `imageFiles`) builds its own stack as before. The stand holds no memory slot (it has its own fixed ceiling); roles never bring it up or down, that is the coordinator's. The stand's config is the project config found from the directory `stand.sh` is called in (or `CODIS_AGENTS_CONFIG`), not from the task's worktree, so the tester calls every stand command from one directory. Why: a stack per task held its own memory, so only two acceptances in Docker ran at once (36 stack tasks: bring-up median 35 s, acceptance about 11 min each); a shared stand with a queue lifts that limit, while the image built from the branch caught defects only in tasks that changed compose or the image files. <!-- role:stand -->
- A step that changes process launch, permissions, Docker or the runtime version is accepted only after a smoke run in
  the real image (an own compose project, torn down after).
- **Worktrees get their own copy of ignored data** (an APFS clone, `scripts/wt-setup.sh`), never a symlink to the main
  checkout: with a symlink, guards in the worktree write into the main data.
- **A remote runner gets the corpus one way only** (`scripts/corpus-sync.js`, machine key `remote`): from the main
  checkout to a donor on the runner, and from the donor a real copy per run; nothing comes back, and the donor never
  changes during a run. Secrets and sessions never leave the machine: the ready file list is checked before any
  transfer, and a `.env*` or a `sessions/` folder in it (in any case: a case-insensitive disk opens `Sessions/` as
  `sessions/`) refuses the sync. An empty source never empties the donor; an interrupted sync marks it
  incomplete and no run copies it until a full sync. The donor is wiped only by its list, in two commands.
  Why: the corpus is the owner's data with the project's secrets next to it, and a guard once wiped a corpus it could reach.
- **With a remote runner, the full guard run goes there** (`guards-all.sh` through `scripts/guards-remote.js`: machine
  key `remote` and project key `remoteRun`; without either nothing changes). Only the committed HEAD runs there
  (tracked changes are refused with 78): it is pushed over the pinned ssh into the runner's bare repository at
  `refs/runs/<name>/<sha>`, never a branch or a tag and never forced. The runner makes its own worktree with its own
  copy of the donor (a copy that changes a file the commit holds, or brings a `.env*` the commit does not hold, is
  refused with 69 before any project code runs) and dependencies from a cache keyed by the lock files, runs its own
  `guards-all.sh` detached from
  ssh and reruns new reds there; this machine holds no slot while it waits (one journal line of class `remote`), and
  the guards the runner cannot run (`remoteRun.localPattern`) run here afterwards in a heavy slot, the worse exit code
  being the run's. The log keeps its name and starts "ran on runner <host>, HEAD <sha>, workers N"; its meta names the
  environment, and a result is never reused across environments. A red of the environment (runner unreachable, host
  key mismatch, another plugin version there, a push refused, dependencies failing, the run vanished) is exit 69 with
  the first log line `environment: <reason>`; there is no fallback to this machine.
  Why: full runs held a heavy slot of a 16 GB machine for about 37 % of a task's calendar; a runner with its own memory
  takes them, and a red found on its Linux must stay red there, not turn green alone on the Mac.
  The dependency cache is read-only after its install, and a reuse checks it against the manifest written then (paths,
  types, modes, sizes, link targets); an incomplete or changed cache is installed again before any guard (write bits
  back, removed, installed, read-only again). A manual clone on the runner (an agent's experiment) takes its
  dependencies only by the layout of `remoteRun.deps` or from its own copy, and never links its `node_modules` into the
  shared cache. Why: an `npm ci` in a manual clone whose `node_modules` was a link into the cache emptied the shared
  cache through that link, its `.ok` stayed, and the next full run started on an empty cache with nine reds.
- **No full guard run in the main working copy.** `guards-all.sh` and the preconditions of the chain
  (`scripts/env-check.js --worktree`) refuse with 78 a directory that is the main working copy of its repository
  (`git rev-parse --git-dir` equals `--git-common-dir`, `scripts/main-checkout.js`) and name `wt-setup.sh`; a project
  that has no worktrees passes `--main-checkout` on the command line (a flag, never an environment variable, so that it
  is not inherited silently). git's own variables (`GIT_DIR`, `GIT_WORK_TREE`, set by git hooks) are ignored, and a
  git error inside a tree with `.git` above it (a repository of another owner in a container) is a refusal, not a pass.
  Why: a full run started with the main working copy as its worktree let a guard of the
  project wipe the measurement corpus there, the only original; the worktrees held clones.
- **Before removing a worktree or a data directory, the coordinator shows the owner what goes with it and removes only
  after a "yes" to that list:** (a) ignored data inside, with sizes (`git status --ignored --porcelain`, `du`);
  (b) references to the path: the path named in the project's code, and symbolic links outside it that lead into it
  (`find -type l` + `readlink`). `scripts/wt-remove-check.js <path> [--search <dir>]...` prints both and removes nothing.
  A clean `git status --porcelain` is not enough: it does not show ignored files. Why: a merged worktree removed after
  a clean `git status` held the only copy of a measurement corpus in ignored files (~288 MB, an hour of the owner's
  manual capture to restore), and the project's guards named its path as a fallback; an old copy of the repository
  removed the same way was the target of 1809 `node_modules` symlinks elsewhere.

## Git

- Stage files by path; never `git add -A` or `git add .` (cloud-synced folders spawn conflict copies named "name 2.ext", and a blanket add sweeps in other agents' scratch files). <!-- role:gitadd -->
- Never push, merge into a protected branch, or create or push tags (a release tag may deploy to production) on your own initiative. Pushing and merging are the owner's call; one explicit request authorizes exactly one push, merge or tag. <!-- role:push -->
- A project may grant standing permission to push process-rule changes to the plugin repository (rules, skills,
  workflows, agents, scripts, tests, README) without a separate "yes" for each. The coordinator still checks the diff
  for secrets and personal paths before the push and commits as a noreply author. The permission does not extend to
  the product repository: its protected branches, merges into them and tags still need an explicit request.
  The hooks let it through only from the plugin repository's own committed `standingPush` (its HEAD, no force, tags never, its hygiene test green).
- **A long branch does not stay local: CI sees it from the start.**
  - An arc's branch gets a draft pull request into the protected branch when the arc starts, and the coordinator pushes
    it after every merged task. A project may grant standing permission to push working branches (never protected
    ones, never tags, never force); without it the coordinator asks the owner for the push at each merge.
  - Each push runs only the cheap CI (type checks, the image build: minutes). The full guard suite runs in CI only on a
    ready (not draft) pull request into the protected branch, on a push to it and on a manual run; no schedule. The
    seam and regressions of every step are covered by the one full guard run of each task on the machine.
  - Before a rule "run X on every step", count its CI minutes and money per day against the CI quota.
  - A red CI on the branch counts like a new red in the full guard run: the task and the seam are not accepted until it
    is green or its red is explained in the backlog.
  - An arc is merged into the protected branch when it closes, not carried into the next arc.
  - Why: an arc branch of 1038 commits (one architecture change, a polishing arc and the start of the next one) never
    went through CI; at the merge CI showed 40 new reds that the local runs never could: a browser engine CI did not
    install, and differences of the Linux runner.
  - Why (2026-10-24): the draft pull request of an arc ran the full guard suite (about 68 min) on every push, about ten
    pushes a day; the 2 000 free GitHub Actions minutes were gone in three days, and CI and the release stopped until
    the quota reset. The owner (translated): "yes, save CI; keep the full CI for the PR into main and the release. Why
    run 800 guards once a day?"
- Every fix gets a guard, and the guard is mutation-tested **after** committing: break the code, see red,
  `git checkout` the file, see green. Mutating before the commit loses the fix silently.
