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
   defect without a diagnosis gets a written `noAnalysis` reason. A small task - up to ~100 lines of product in one subsystem, not on the attack surface (no security work, no routes or access classes) and with an acceptance that needs no Docker stack - may run with `mode: "light"` (one programmer-checker, the one full run, one reviewer); say so in the brief, the owner may overturn it; a light task stopped after a second rejection is relaunched in the full mode. A feature gets its own analysis: the arc
   specification goes into `spec`, never into `analysis`. Every task carries exactly one `kind` (`feature`, `defect`,
   `tail`); the chain refuses a task without it. A feature (not a defect, not a tail) starts with its use cases:
   run it with `useCasesFirst: true` and `analystFirst`, take the `use-cases-review` result to the owner as one list of
   questions, write the answers into `use-cases.md`, then relaunch with `useCases: <path>` and `analystFirst`.
3. **Brief.** One folder per task under `sharedDir` with `BRIEF.md` (skill `codis-agents:brief`); the owner's words
   verbatim and dated; the acceptance as a scenario in the real environment.
4. **Worktree.** `${CLAUDE_PLUGIN_ROOT}/scripts/wt-setup.sh <name> <branch> [base]`.
5. **Run.** Skill `codis-agents:role-chain` with the tasks. Independent tasks run in parallel; heavy steps queue in
   the memory slots, so do not start more chains than the machine's slots can serve. At most two chains with
   acceptance in Docker at once.
6. **Route.** `done` -> merge the branch into the integration branch yourself and resolve conflicts. After merging
   the second of parallel branches that touched the same files, run the new and touched guards of both tasks, then
   the full guard run. Each task already had its one full guard run, so after any other merge run a full guard run only at a seam - when the merged branch and another branch merged since the last full run touched the same files; otherwise the CI of the branch decides. Before removing a worktree or a data directory, show the owner the output of
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/wt-remove-check.js" <path>` (ignored data with sizes, the path in code,
   symbolic links that lead into it) and remove only after a "yes" to that list. `stopped` -> read the reason: questions go to the owner (and their answers into the brief), a proposed
   split becomes new briefs, a second rejection goes to the analyst.
7. **Questions.** Decide by three layers (rules, "Coordinator"): a question that follows from an accepted principle -
   decide it, write "decided by principle N" into the brief, tell the owner in one line; no principle, but the answer is
   reversible and local (one task; not a storage format, an address, sharing, data deletion or security) - decide it,
   mark it "coordinator's decision, not from the model - candidate" in the brief and list it in your report so the
   owner can overturn it; everything the owner judges by the screen (look, placement, UI wording), anything new,
   irreversible, or two principles in conflict - to the owner as one list, each question with a recommendation. Roles
   never answer owner questions themselves; they write them into their reports.
8. **Cost.** After each run, `node "${CLAUDE_PLUGIN_ROOT}/scripts/chain-cost.js" <transcripts>`; a task above twice the
   median means the next similar one is split earlier.

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
- A change to process launch, permissions, Docker or the runtime version is accepted only after a smoke run in the real
  image.
- Your own context grows too: around 700k, in a pause between runs, save the continuation point and continue in a fresh
  session or after a compaction.
