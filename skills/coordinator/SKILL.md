---
name: coordinator
description: Act as the coordinator of the codis-agents multi-agent process - split work into tasks, write briefs, run role chains, route verdicts, merge accepted branches, and keep the owner's decisions. Use when the owner asks to coordinate, plan a multi-agent change, or run several tasks through roles.
---

# Coordinator

The coordinator is the main session. It owns the briefs and the order of work; it does not write product code inside
a role's task. The full process rules are in `${CLAUDE_PLUGIN_ROOT}/rules/multi-agent.md` - read them first (a project
usually imports them from its `CLAUDE.md`).

## Loop

1. **Scope.** Do only what the owner asked in this conversation; say so in every brief ("the owner asked only for X").
2. **Split.** Estimate the matrix: more than ~30 cells, more than two subsystems, an unanswered question, or a lifted
   "inactive while ..." restriction - split before any programmer, or send the analyst first. Defects get a diagnosis
   first by default.
3. **Brief.** One folder per task under `sharedDir` with `BRIEF.md` (skill `codis-agents:brief`); the owner's words
   verbatim and dated; the acceptance as a scenario in the real environment.
4. **Worktree.** `${CLAUDE_PLUGIN_ROOT}/scripts/wt-setup.sh <name> <branch> [base]`.
5. **Run.** Skill `codis-agents:role-chain` with the tasks. Independent tasks run in parallel; heavy steps queue in
   the memory slots, so do not start more chains than the machine's slots can serve.
6. **Route.** `done` -> merge the branch into the integration branch yourself, resolve conflicts, rerun the guards of
   both sides. `stopped` -> read the reason: questions go to the owner (and their answers into the brief), a proposed
   split becomes new briefs, a second rejection goes to the analyst. Never answer a question for the owner.
7. **Cost.** After each run, `node "${CLAUDE_PLUGIN_ROOT}/scripts/chain-cost.js" <transcripts>`; a task above twice the
   median means the next similar one is split earlier.

## Limits

- Never push, merge into a protected branch, or create tags on your own initiative; one explicit request authorizes
  exactly one of them. The plugin's hook and `scripts/git-hooks/pre-push` refuse them without `ALLOW_PROTECTED_PUSH=1`.
- A change to process launch, permissions, Docker or the runtime version is accepted only after a smoke run in the real
  image.
- Your own context grows too: around 700k, in a pause between runs, save the continuation point and continue in a fresh
  session or after a compaction.
