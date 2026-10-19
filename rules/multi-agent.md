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
- On rejection: a fix round, then a second review. A second rejection for a code defect sends the task to the analyst
  (cases, cause) inside the same run, then one more full round; a third rejection goes to the coordinator. A question
  of scope goes to the owner.
- A rejection only for docs or guard wording is fixed by the programmer and re-reviewed on that diff only, without a
  tester round. The workflow checks the claim against the changed paths.
- The tester does not repeat the programmer's full guard run: it reuses the programmer's log, runs the new and touched
  guards plus mutations, and runs the full suite only after its own commits.
- After the tester and after each reviewer, a git post-check (`scripts/role-diff-check.js`) compares the worktree with
  the HEAD of the previous committing role: the tester may change only guards and their fixtures, a reviewer nothing.
  A violation stops the chain. A post-check that fails (or returns nothing) is repeated once by the default model and
  the second answer decides: a cheap agent sometimes reports a failure without running the script, while the script
  itself gives the same answer twice.
- **Do not resume a multi-task workflow run with `resumeFromRunId`.** Cached agent results replay by call order; with
  tasks in parallel the order differs, so results land in the wrong task (after a pause one task's programmer HEAD
  became another task's base, and the post-check stopped both chains on files their testers never touched). Relaunch
  each unfinished task alone, with `start` pointing to its report and the step it stopped at.
- **Check the seam of parallel branches.** After merging the second of parallel branches that touched the same files,
  the coordinator runs the new and touched guards of both tasks, then the full guard run. Each branch was green alone;
  after such a merge one guard gave six red from the seam alone.

## Task folder and reports

- **One shared directory per task**: `<sharedDir>/<task>/` holds `BRIEF.md` and one report per role (`analyst.md`,
  `prog.md`, `test.md`, `review.md`, `review-sec.md`).
- Agents write their report as they go. A restarted agent resumes from its report plus `git log`, not from scratch. The report always ends with an up-to-date line "Next step: ...". <!-- role:report -->
- The brief states the owner's acceptance as a scenario in the real environment ("Add -> the item builds with no tab
  open"), not just a feature name. The review checks the scenario, not the wording.
- A workflow gives agents only tasks the owner asked for, and says so explicitly; an agent that sees "the owner asked only for H" next to task F refuses F. <!-- role:scope -->

## Waiting, context and cost

- **Never sit idle longer than 270 s at a time.** Prompt caches of workflow agents expire after about 5 minutes; after a longer pause the whole context is written again (such pauses were 21 % of all token spend before this rule, 7.4 % after it). Run anything long through Bash `run_in_background` and wait with Monitor in slices of at most 270 s. An agent with no output for 10 minutes is killed. A wake-up costs about 0.1 of the context and a cache miss about 1.25, so keeping a cache warm pays off only up to about 45 minutes: for a longer wait, write the report with its next step and finish. <!-- role:pauses -->
- **Context about 200k is a cost signpost, not a limit.** Every call re-reads the whole context, so a step at 400k costs twice a step at 200k. Past ~200k an agent finishes its current stage instead of starting a new large one; if much work remains, it writes the report with its next step and hands over to a fresh agent; if the task is nearly done, it finishes itself. <!-- role:context -->
- Size the task so one programmer can finish it (see "Split the task") rather than relying on the handover.
- After a run, `scripts/chain-cost.js` computes the cost of each task from the transcripts and flags tasks above twice
  the median (`medianTaskIE`); the next similar task is split.

## Machine and environment

- **Heavy work goes through memory slots, not one shared lock.** Light (read-only agents, guards without a bundler, browser or tsc): no slot. Medium (<= 0.85 GB: tsc, a plugin build, one bundler build without a browser): `scripts/medium.sh <cmd>`. Heavy (~1 GB+: browser and bundler guards, full guard runs, measurements, docker image builds and test stacks): `scripts/heavy.sh <cmd>` and `scripts/guards-all.sh <worktree>`. <!-- role:slots -->
- **Every slot hold is journaled**, so the queue for a slot can be told from the job itself: one line per hold in
  `<lockDir>/journal.tsv` (request, acquire, release, class, slot, pid, worktree, short command, exit code; a failed
  write never stops the slot). `scripts/slot-journal.js --since <2d>` gives queue wait and hold, total and median, per
  class and per worktree.
- A full guard run picks its worker count from what else holds heavy slots: all full runs together never exceed the
  budget (`slots.jobsAlone`).
- Guards that share a resource (a fixed port, a shared temp dir or corpus file, a docker project) carry
  `// guards:exclusive — <reason>` and run one at a time under their own lock.
- **Docker.** The owner's stack is read-only for roles (`docker cp` out is fine); writing into its containers needs explicit consent. Only a tester runs its own stack, and only when the brief asks for one; afterwards it removes that stack with its images and volumes: `docker compose -p <stack> down -v --rmi all`. The owner's stack and its images are never removed; other images and the shared build cache are not cleaned by roles (that is the coordinator's or the owner's call). A post-check, `scripts/role-leftovers-check.js`, runs after the tester and at the end of the task: what the task left (containers, networks, volumes and images labelled with its compose project, processes whose cwd or argv lies in its worktree, slots they hold) it removes and writes into the task's `leftovers.md`; what it cannot remove stops the task. <!-- role:docker -->
- **At most two chains with acceptance in Docker at once.** An acceptance stack (several services, its image build, a
  browser driving it) is the heaviest job on a 16 GB machine; the coordinator starts a third such chain only after one
  of the two is done.
- A step that changes process launch, permissions, Docker or the runtime version is accepted only after a smoke run in
  the real image (an own compose project, torn down after).
- **Worktrees get their own copy of ignored data** (an APFS clone, `scripts/wt-setup.sh`), never a symlink to the main
  checkout: with a symlink, guards in the worktree write into the main data.
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
    it after every merged task, so CI runs on each step. A project may grant standing permission to push working
    branches (never protected ones, never tags, never force); without it the coordinator asks the owner for the push at
    each merge.
  - A red CI on the branch counts like a new red in the full guard run: the task and the seam are not accepted until it
    is green or its red is explained in the backlog.
  - An arc is merged into the protected branch when it closes, not carried into the next arc.
  - Why: an arc branch of 1038 commits (one architecture change, a polishing arc and the start of the next one) never
    went through CI; at the merge CI showed 40 new reds that the local runs never could: a browser engine CI did not
    install, and differences of the Linux runner.
- Every fix gets a guard, and the guard is mutation-tested **after** committing: break the code, see red,
  `git checkout` the file, see green. Mutating before the commit loses the fix silently.
