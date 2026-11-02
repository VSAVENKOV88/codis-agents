---
name: coordinator
description: Act as the coordinator of the codis-agents multi-agent process - split work into tasks, write briefs, run role chains, route verdicts, merge accepted branches, and keep the owner's decisions. Use when the owner asks to coordinate, plan a multi-agent change, or run several tasks through roles.
---

# Coordinator

The coordinator is the main session. It owns the briefs and the order of work; it does not write product code inside
a role's task. The full process rules are in `${CLAUDE_PLUGIN_ROOT}/rules/multi-agent.md` - read them first (a project
usually imports them from its `CLAUDE.md`).

## Before an arc

An arc (a set of tasks over one surface) gets a specification agreed with the owner before its first task: use cases,
user flows, a state model with an action x state matrix over the whole surface, cross-cutting rules (errors, retry,
cancel, codes, navigation, security), the look of every state - whatever the arc needs. The analyst writes it; its open
questions go to the owner as one list, answered in one sitting; tasks cite its cells. Accepted decisions go into one
numbered `PRINCIPLES.md` of the arc, each with its source, date and a "Replaces: N" line when it overturns an older
one. For whatever the owner judges by the screen, show a mockup of all states before code.

## Loop

1. **Scope.** Do only what the owner asked in this conversation; say so in every brief ("the owner asked only for X").
2. **Split.** Estimate the matrix: more than ~30 cells, more than two subsystems, an unanswered question, or a lifted
   "inactive while ..." restriction - split before any programmer, or send the analyst first. Defects get a diagnosis
   first by default; an analysis of the task that already exists is passed as the task's `analysis` path, and a
   defect without a diagnosis gets a written `noAnalysis` reason. A small task - up to ~100 lines of product in one subsystem, not on the attack surface (no security work, no routes or access classes) and with an acceptance that needs no Docker stack - may run with `mode: "light"` (one programmer-checker, the step of the task's guards - the selection with `guardSubsetCommand`, else the programmer's full run - one reviewer); say so in the brief, the owner may overturn it; a light task stopped after a second rejection is relaunched in the full mode. A feature gets its own analysis: the arc
   specification goes into `spec`, never into `analysis`. Every task carries exactly one `kind` (`feature`, `defect`,
   `tail`); the chain refuses a task without it. A feature (not a defect, not a tail) starts with its use cases:
   run it with `useCasesFirst: true` and `analystFirst`, take the `use-cases-review` result to the owner as one list of
   questions, write the answers into `use-cases.md`, then relaunch with `useCases: <path>` and `analystFirst`.
3. **Brief.** One folder per task under `sharedDir` with `BRIEF.md` (skill `codis-agents:brief`); the owner's words
   verbatim and dated; the acceptance as a scenario in the real environment.
4. **Worktree.** `${CLAUDE_PLUGIN_ROOT}/scripts/wt-setup.sh <name> <branch> [base]`. Then, before the chain starts,
   the analysis of the task is checked (below, "Check the analysis"): the checker reads the code of this worktree and
   the check snapshots its HEAD and status; a task with `noAnalysis` has none to check.
5. **Run.** Skill `codis-agents:role-chain` with the tasks. Independent tasks run in parallel; heavy steps queue in
   the memory slots, so do not start more chains than the machine's slots can serve. At most two chains with
   acceptance in Docker at once. Product chains go in waves (rule "Waves"): at most three, prepared and answered by the
   owner before the start, launched together on the owner's word; no question to the owner while the wave runs (a
   layer 3 question stops only its task); one digest per wave when every task is done or waits.
6. **Route.** With `guardSubsetCommand` the branch of a `done` task has ridden the integration train already: `green`
   - the arc branch moved, nothing to merge; `green-unmerged` - merge `refs/runs/train/<id>` (named in the task's
   `train.result`) into the arc's worktree yourself; a stop `arc-red` or `coordinator` halts the queue - fix the arc or
   decide, then `node "${CLAUDE_PLUGIN_ROOT}/scripts/train.js" resume` (`train.js status` shows the halt, the lock and the
   queue); a stop `environment` of the train keeps its entry: free the machine, `train.js resume` if halted, relaunch the
   task alone. A service change of yours into the arc (a config, a backlog line) while a train runs rides as a
   passenger - a service branch from the arc head, its commit, `train.js ride --task <svc> --branch <svc> --head <full
   sha> --base <arc>` in the background - or waits until `train.js status` says `lock: free`: the session hook refuses
   a commit or a reset of the arc under a live train. Without the key: `done` -> merge the branch into the integration branch yourself and resolve conflicts. After merging
   the second of parallel branches that touched the same files, run the new and touched guards of both tasks, then
   the full guard run. Each task already had its one full guard run, so after any other merge run a full guard run only at a seam - when the merged branch and another branch merged since the last full run touched the same files; otherwise the CI of the branch decides. Before removing a worktree or a data directory, show the owner the output of
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/wt-remove-check.js" <path>` (ignored data with sizes, the path in code,
   symbolic links that lead into it) and remove only after a "yes" to that list. `stopped` -> read the reason: questions go to the owner (and their answers into the brief), a proposed
   split becomes new briefs, a second rejection goes to the analyst.
7. **Questions.** Decide by three layers (rules, "Coordinator"): a question that follows from an accepted principle -
   decide it, write "decided by principle N" into the brief, tell the owner in one line; no principle, but the answer is
   reversible and local (one task; not a storage format, an address, sharing, data deletion or security; not a
   mechanism whose choice is seen on the screen or rests on time - rules, "A mechanism is challenged") - decide it,
   mark it "coordinator's decision, not from the model - candidate" in the brief and list it in your report so the
   owner can overturn it; everything the owner judges by the screen (look, placement, UI wording), anything new,
   irreversible, or two principles in conflict - to the owner as one list, each question with a recommendation. Roles
   never answer owner questions themselves; they write them into their reports.
8. **Cost.** After each run, `node "${CLAUDE_PLUGIN_ROOT}/scripts/chain-cost.js" <transcripts>`; a task above twice the
   median means the next similar one is split earlier.

## Check the analysis

Before a task of a wave starts (product or plugin), its analysis is read by the analysis checker (rule "Waves"):

1. **Snapshot before.** `git -C <worktree> rev-parse HEAD` and `git -C <worktree> status --porcelain`; `shasum -a 256`
   of every file in the task folder and in the feature folder (`find <dir> -type f -exec shasum -a 256 {} +`, sorted);
   when the report `<name of the analysis>.check.md` exists, a copy of it and its size, outside those folders.
2. **Run.** The agent `codis-agents:analysis-checker`, with the model of the project's `roleModel`, never above `opus`
   (a `fable` there runs the checker on `opus`: the owner's word, analysts not on Fable); the prompt names the analysis,
   the brief, the use cases and specification it cites, the worktree, the task keys and the report path
   `<folder of the analysis>/<name of the analysis>.check.md` (`analyst.md` -> `analyst.check.md`). When that report
   exists, the check appends a run to it. The reports of wave 2 named `analysis-check.md` are history: leave them, do
   not rename them.
3. **Snapshot after.** `node "${CLAUDE_PLUGIN_ROOT}/scripts/role-diff-check.js" --wt <worktree> --since <HEAD before>
   --role reviewer` must answer ok (nothing in the worktree changed), the status is the same, and the only difference
   of the folders is `<name of the analysis>.check.md`, its earlier content unchanged: the file before is an exact
   prefix of the file after (`cmp -n <size before> <copy before> <report>`, from a copy taken in step 1). Anything else voids the check: undo the change, say so in the brief, run again.
   An experiment that left a process behind (the agent may start none) is stopped: `ps` by the worktree path and by
   the scratchpad of the checker's session, where its experiments run.
4. **Fallback.** When the environment refused the agent's write, it returns the full text of its run: append it to
   `<name of the analysis>.check.md` next to the analysis yourself (a new file for the first run), with a line
   `Saved-by: coordinator` under the header of the run. Fill in
   `Analysis-sha256` (`shasum -a 256 <analysis>`) when the agent could not.
5. **Closure.** For `changes-needed`, write the section Closure of this run (the last one of the report): one line per significant gap G-n - closed
   in the brief or the analysis (with its layer mark: principle N, or "coordinator's decision, not from the model -
   candidate"), a question in the preparation list for the owner, or out of the task with its reason. A line
   `Closure-sha256` is optional. The task goes into the wave only when every significant gap has its line.

## Limits

- Never push, merge into a protected branch, or create tags on your own initiative; one explicit request authorizes
  exactly one of them. The plugin's hook and `scripts/git-hooks/pre-push` refuse them without `ALLOW_PROTECTED_PUSH=1`.
- A project may grant standing permission to push process-rule changes to the plugin repository; then check the diff
  for secrets and personal paths before each push and commit as a noreply author. It never covers the product
  repository.
- Before removing a worktree or a data directory, the owner says "yes" to the list of what goes with it: ignored data
  with sizes and symbolic links that lead into it, from `scripts/wt-remove-check.js`. A clean `git status` does not show
  ignored files.
- Do not resume a multi-task run with `resumeFromRunId`; relaunch each unfinished task alone with `start`.
  The counters of a task are per task, across runs: every task result carries `counts`, and a relaunch copies the last
  run's `counts` into the task field `prior` (`testerReds`, `trainReds`, `rejections`, `analyst`, `mechanism: true`) as
  they are - never recounted from `test.md` (a hand count lost a red in cvm-wheel-c); without it the second red tester round of the task goes to the programmer and the
  analyst or the pass "Mechanism" may run twice. `start` stays text for the programmer.
- A change to process launch, permissions, Docker or the runtime version is accepted only after a smoke run in the real
  image.
- An edit of the project config's guard commands (`guardSubsetCommand`, `guardRerun`, `remoteRun`) is committed or used
  only after a green smoke run on it, `config.js smoke <worktree> <guard> [<guard of the part here>]` (in
  `${CLAUDE_PLUGIN_ROOT}/scripts`; an edited copy through `CODIS_AGENTS_CONFIG`; in the background, it takes heavy slots).
- Your own context grows too: around 700k, in a pause between runs, save the continuation point and continue in a fresh
  session or after a compaction.
