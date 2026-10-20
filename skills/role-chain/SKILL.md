---
name: role-chain
description: Run the codis-agents role chain (preconditions, analyst, programmer, tester, reviewer, security reviewer) on one or more tasks that already have a BRIEF.md and a worktree. Use when the owner asks to start, run or restart the role chain, the agents, or a task through programmer/tester/reviewer.
---

# Run the role chain

The chain itself is the workflow `codis-agents:role-chain` (`${CLAUDE_PLUGIN_ROOT}/workflows/role-chain.js`). The
workflow reads no files, so this skill collects everything it needs and passes it in `args`.

## 1. Read the project config

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" json`. It finds `.claude/codis-agents.json` (environment
`CODIS_AGENTS_CONFIG`, the project directory, the nearest parent, or the main checkout of a linked worktree), checks it
and prints the resolved config with `scriptsDir` added. If it fails, show its errors to the owner and stop; the
example is `${CLAUDE_PLUGIN_ROOT}/examples/codis-agents.example.json` and the schema
`${CLAUDE_PLUGIN_ROOT}/schemas/codis-agents.schema.json`.

## 2. Collect the tasks

Only tasks the owner asked for in this conversation. For each task:

| field | meaning |
|---|---|
| `key` | short id; the task folder is `<sharedDir>/<key>/` unless `dir` is given |
| `title` | human name of the task |
| `wt` | worktree path, or a name under `worktreeRoot` (create one with `${CLAUDE_PLUGIN_ROOT}/scripts/wt-setup.sh <name> <branch> [base]`) |
| `branch` | the task branch checked out in the worktree |
| `accept` | the acceptance scenario in the real environment, copied from the brief |
| `gdir` | optional: argument of `guards-all.sh` (default `wt`) |
| `start` | optional: what is new for the first programmer (e.g. "continue from prog.md") |
| `analystFirst` | `true`: the brief needs a matrix or a diagnosis before code (default for defects) - the analyst runs first |
| `analysis` | absolute path of an existing analyst or diagnosis report of this task (an earlier analyst that proposed the split, a diagnoser run outside the chain - put its report into the task folder); it must lie in the task folder or in the folder of its `feature`, never be the arc specification; the preconditions check it exists, is non-empty and is a matrix or diagnosis of this task; the programmer gets it by name |
| `noAnalysis` | a short reason why no analysis is needed: a tail, a one-line fix; for a defect, why the diagnosis is skipped. "The arc specification covers it" is not a reason. It is logged and given to the programmer |
| `feature` | optional: key of the feature this task is a part of (the task was split from it); its folder `<sharedDir>/<feature>/` may hold the analysis, and `chain-cost.js` sums the parts by it |
| `spec` | optional: path or list of paths of the arc specification (and its `PRINCIPLES.md`); every role gets it as context; it is not the task's analysis |
| `useCases` | optional: absolute path of the feature's `use-cases.md` (in the task folder or the folder of its `feature`, never the arc specification); every role gets it as context, the preconditions check it has no open questions left, the analyst's matrix cites it, the tester builds acceptance along its flows, the reviewer checks its alternative flows and errors |
| `useCasesFirst` | optional: `true` together with `analystFirst` for a feature whose use cases are not written yet - the analyst writes only `<dir>/use-cases.md` with its open questions and the task stops with status `use-cases-review`; review them with the owner, then relaunch with `useCases` and `analystFirst` |
| `stack` | optional: docker compose project the tester may start and tear down |
| `security` | optional: the brief marks the task as security work - a security reviewer joins |

Every task carries exactly one of `analystFirst`, `analysis`, `noAnalysis`; with none or several the workflow stops
that task before any agent. A reused analysis is passed as `analysis`, not in free text inside `start`: the Analyst
phase then logs `<title>: analyst reused - <path>` instead of looking skipped. A feature gets its own analysis: the arc
specification goes into `spec`, not into `analysis` (an `analysis` equal to a `spec` path or outside the task's or the
feature's folder stops the task).

Check before starting: `BRIEF.md` exists in the task folder, the worktree is on the branch, the task has its analysis
marker (and the `analysis` file exists), and the brief has no unanswered question on which acceptance depends. If something is missing, write it into the brief as a question for
the owner and ask, instead of starting.

## 3. Start the workflow

```
Workflow({ name: "codis-agents:role-chain", args: {
  owner: "<the owner's request in this conversation, verbatim>",
  config: <the JSON printed in step 1>,
  tasks: [ { key, title, wt, branch, accept, ... } ]
} })
```

`args.agentTypePrefix: ""` runs every role as `general-purpose` instead of the plugin's role agents (a fallback if the
role agents are unavailable).

## 4. After the run

- Each task returns `done` or `stopped` with the reason, questions, proposed split or review findings. A stop with
  `environment` is a red the product did not cause (a cut-off full run, no slot, disk or swap, Docker): free the
  machine and relaunch the task with `start` pointing to its report, without a programmer round. Relay them to the
  owner; write the owner's answers into the brief yourself (verbatim, dated) before the next run.
- Cost: `node "${CLAUDE_PLUGIN_ROOT}/scripts/chain-cost.js" <directory with the run's agent transcripts>...` prints the
  input-equivalent cost per task and flags tasks above twice `medianTaskIE`; give it the transcript directories of all
  runs of a split feature, and it sums the parts that carry the same `feature` and flags the feature above
  `featureIELimit` (default 3 x `medianTaskIE`). Put the lines into the report to the owner.
- An interrupted run with several tasks is never resumed with `resumeFromRunId`: cached agent results replay by call
  order, which differs between parallel tasks, so results land in the wrong task. Relaunch each unfinished task alone,
  with `start` pointing to its report and the step it stopped at.
- Accepted branches are merged by the coordinator; pushing, merging into a protected branch and tagging stay the
  owner's call.
