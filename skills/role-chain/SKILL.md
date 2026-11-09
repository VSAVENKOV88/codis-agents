---
name: role-chain
description: For the coordinator session; a role of the chain never runs it. Run the codis-agents role chain (preconditions, analyst, programmer, tester, reviewer, security reviewer) on one or more tasks that already have a BRIEF.md and a worktree. Use when the owner asks to start, run or restart the role chain, the agents, or a task through programmer/tester/reviewer.
---

# Run the role chain

**Plugin root.** `${CLAUDE_PLUGIN_ROOT}` below is the root of this plugin. Claude Code sets it; where it is empty or not
expanded (Codex), the root is the folder two levels above this `SKILL.md` (the installed copy,
`$CODEX_HOME/plugins/cache/<marketplace>/codis-agents/<version>`). On Codex write that absolute path literally into every
command, with no variable (`<plugin>` below): the rules of the coordinator's home match only the literal path.

The chain itself is `workflows/role-chain.js`. On Claude Code it runs as the workflow `codis-agents:role-chain`; on
Codex, or with roles on another host, the conductor `scripts/chain-run.js` runs the same script as a detached process
(step 3). The script reads no files, so this skill collects everything it needs and passes it in.

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
| `start` | optional: what is new for the first programmer (e.g. "continue from prog.md"); text for the programmer only - the workflow counts nothing from it (the counts of earlier runs go into `prior`) |
| `prior` | optional, for a relaunch: what earlier runs of this task did, so the counters of the task go on from there - `{testerReds?: integer >= 0` (red tester verdicts for the product, not `environment`), `trainReds?: integer >= 0` (red trains, `red` only), `rejections?: integer >= 0` (review rejections since the last analyst of the task), `analyst?: "tester-red" \| "rejection" \| "train-red"` (the analyst of a second red tester round, rejection or red train already ran), `mechanism?: true` (the analyst pass after a status `mechanism` was made)`}`; copy the field `counts` of the last run's result as it is (every task result carries it, the seed included), never recount from `test.md`. A wrong value or key stops the task before any agent; `testerReds` above 0 is refused with `mode: "light"` |
| `resumeAt`, `head` | only under the conductor (`scripts/chain-run.js`), from a decision of `chain-run.js resolve`: `resumeAt` `tester`, `review` or `train` and `head` the full sha the chain resumes on; refused under the Workflow runtime, with `analystFirst` or `useCasesFirst`, in the light mode other than `review`, and `train` without `guardSubsetCommand` |
| `priorReason` | optional, under the conductor: why a `prior` that differs from the counts of the newest run of the task (or follows an `abort` of `resolve`) holds - e.g. a Workflow run in between; kept with both sets in the record of the task and the log |
| `kind` | exactly one of `"feature"` (new behaviour: it needs `useCases` or `useCasesFirst`), `"defect"` (a bug), `"tail"` (a small leftover); without it or with another value the task stops before any agent |
| `analystFirst` | `true`: the brief needs a matrix or a diagnosis before code (default for defects) - the analyst runs first |
| `analysis` | absolute path of an existing analyst or diagnosis report of this task (an earlier analyst that proposed the split, a diagnoser run outside the chain - put its report into the task folder); it must lie in the task folder or in the folder of its `feature`, never be the arc specification; the preconditions check it exists, is non-empty and is a matrix or diagnosis of this task; the programmer gets it by name |
| `noAnalysis` | a short reason why no analysis is needed: a tail, a one-line fix; for a defect, why the diagnosis is skipped. "The arc specification covers it" is not a reason. It is logged and given to the programmer |
| `feature` | optional: key of the feature this task is a part of (the task was split from it); its folder `<sharedDir>/<feature>/` may hold the analysis, and `chain-cost.js` sums the parts by it |
| `spec` | optional: path or list of paths of the arc specification (and its `PRINCIPLES.md`); every role gets it as context; it is not the task's analysis |
| `useCases` | optional: absolute path of the feature's `use-cases.md` (in the task folder or the folder of its `feature`, never the arc specification); every role gets it as context, the preconditions check it has no open questions left, the analyst's matrix cites it, the tester builds acceptance along its flows, the reviewer checks its alternative flows and errors |
| `useCasesFirst` | optional: `true` together with `analystFirst` for a feature whose use cases are not written yet - the analyst writes only `<dir>/use-cases.md` with its open questions and the task stops with status `use-cases-review`; review them with the owner, then relaunch with `useCases` and `analystFirst` |
| `stack` | optional: docker compose project the tester may start and tear down; with a shared stand in the config (`stand`) only for a task whose commits change the stand's image files |
| `security` | optional: the brief marks the task as security work - a security reviewer joins |
| `base` | the branch or commit the task started from; `scripts/guards-select.js` takes the changed files since its merge-base (without it the role names the base itself); with `guardSubsetCommand` required: the branch of the arc (a branch of the repository, not a commit and not a protected branch), which the integration train moves |
| `mode` | optional: `mode: "light"` for a small task chosen by the coordinator (rules: up to ~100 lines of product, one subsystem, no attack surface, no Docker acceptance) - one programmer-checker, the step of the task's guards (the selection with `guardSubsetCommand` and `innerSelect` not `false`; none with `innerSelect: false`, where the train is the first run; else the programmer's full run), one reviewer, no tester - after a red train too: the programmer-checker runs the acceptance of the cells its fix touches itself; refused with `security` or `stack`. Default `"full"` |

Every task carries exactly one of `analystFirst`, `analysis`, `noAnalysis`; with none or several the workflow stops
that task before any agent. A reused analysis is passed as `analysis`, not in free text inside `start`: the Analyst
phase then logs `<title>: analyst reused - <path>` instead of looking skipped. A feature gets its own analysis: the arc
specification goes into `spec`, not into `analysis` (an `analysis` equal to a `spec` path or outside the task's or the
feature's folder stops the task).

Every task also carries exactly one `kind`: `feature`, `defect` or `tail`; without it, or with any other value, the
workflow stops that task before any agent and does not guess it from the other fields. A `feature` without `useCases`
and without `useCasesFirst` stops before any agent too, with "feature without use cases: add useCasesFirst (the analyst
writes them) or useCases (a path)". A defect or a tail needs no use cases (it may carry them).

Check before starting: `BRIEF.md` exists in the task folder, the worktree is on the branch, the task has its analysis
marker (and the `analysis` file exists), and the brief has no unanswered question on which acceptance depends. If something is missing, write it into the brief as a question for
the owner and ask, instead of starting.

## 3. Start the chain

### On Claude Code: the Workflow

```
Workflow({ name: "codis-agents:role-chain", args: {
  owner: "<the owner's request in this conversation, verbatim>",
  config: <the JSON printed in step 1>,
  tasks: [ { key, title, wt, branch, accept, kind, ... } ]
} })
```

`args.agentTypePrefix: ""` runs every role as `general-purpose` instead of the plugin's role agents (a fallback if the
role agents are unavailable).

Roles on Codex from a Claude Code session: start the conductor as in the block below (`--host codex`) and wait in
blocking Bash slices of `node "${CLAUDE_PLUGIN_ROOT}/scripts/chain-run.js" status <runId> --wait 270` (rule "Pauses").
Before a Workflow start of a task that ran under the conductor, `node "${CLAUDE_PLUGIN_ROOT}/scripts/chain-run.js"
resolve --list --task <k>` must show no live conductor run of it (its lock `<sharedDir>/runs/.locks/<k>.lock`); a task
that moves between the Workflow and the conductor carries `prior` (and `priorReason` under the conductor).

### On Codex, or roles on another host: the conductor

There is no Workflow and no Monitor on Codex. The conductor runs the same chain as a detached process; this session
only starts it and watches it.

1. Write the tasks (a JSON array of the objects of step 2) and the owner's words, verbatim, into two files inside
   `sharedDir`, not inside a worktree (e.g. `<sharedDir>/<key>/chain-tasks.json` and `<sharedDir>/<key>/chain-owner.txt`).
2. Start: `node <plugin>/scripts/chain-run.js start --host codex --tasks <tasks file> --owner <owner file> --codex-home <run home>`
   (add `--config <codis-agents.json>` when the config is not found from the working directory, and `--bin <codex>`
   for a codex of a version the run home was checked with). The roles run `gpt-6-astra` with effort `high`; for
   another model and effort of the whole run add `--codex-model <slug> --codex-effort <level>` (e.g. `gpt-6-luna` `low`
   for a cheap acceptance run; only with `--host codex`). A slug outside the catalog of the run home or an effort the
   model does not support stops every task before any role; `status` shows `codexModel` and `codexEffort`. Keep the
   command a plain argv with the literal plugin path, so the coordinator's rule matches it. The run home is the Codex home of the roles, prepared by
   the owner (skill `codis-agents:coordinator`, "On Codex: homes, sandbox and rules"); it is never the `$CODEX_HOME` of
   this session. Roles on Claude Code from a Codex session: `--host claude [--bin claude]`. The answer is one JSON line
   `{runId, runDir, pid, tasks}`; exit 0 started, 64 arguments, the tasks or owner file or a refusal of the adapter,
   65 the config, 70 the conductor died before it was ready (its tail on stderr).
3. Right away, before the first slice, write into the brief of every task of the run the line
   `run: <runId> <runDir> pid <pid> host codex <date>`.
4. Wait in slices: `node <plugin>/scripts/chain-run.js status <runId> --wait 25`, again while it exits 3. 25 s is the
   slice (measured 2026-11-09 on codex 0.167.0, `codex exec`: the shell tool answers "still running" after about
   30 s). A slice that answers "still running", is cut or returns early is not the end and not the death of the run:
   run the next slice; only exit 0 or 4 ends the wait - 0 finished (its `results.json` holds the verdicts), 4 dead (the
   basis in `status`, then `chain-run.js resolve`). Do not end your turn while the run lives: a turn that ends takes its own
   unfinished commands with it (the detached run survives, the watch does not).
5. Esc, or closing Codex, cancel only the wait, never the run; a run stops only with
   `node <plugin>/scripts/chain-run.js stop <runId>`. A new session takes the `runId` from the last `run:` line of the brief
   (or from `<sharedDir>/runs/.locks/<key>.lock` while the run lives) and goes on with `status`; a `status` that exits
   64 (unknown run) means the line is wrong: look in the lock, and never start a second run of the task for it (a
   live lock refuses it anyway).
6. The results go by the common section "After the run" below. The cost of a conductor run is
   `node <plugin>/scripts/chain-cost.js --journal <task folder>`.

## 4. After the run

- Each task returns `done` or `stopped` with the reason, questions, proposed split or review findings. A stop with
  `environment` is a red the product did not cause (a cut-off full run, a refused slot queue, disk or swap, Docker): free the
  machine and relaunch the task with `start` pointing to its report, without a programmer round. Every relaunch carries
  `prior` = the `counts` of the last run's result, copied (red tester rounds and red trains for the product, review
  rejections, an analyst that ran, a pass "Mechanism"), so the counts of the task go on. Under the conductor a refused
  start (an open step of a dead run, a verdict whose use is not proven, damage) is lifted with `chain-run.js resolve`
  on the basis `chain-run.js status` prints, and the relaunch carries the `resumeAt`, `head` and `prior` of the
  decision; `chain-run.js resolve --list` gives the decisions as lines for the digest. A conductor run is stopped with
  `chain-run.js stop <run>` (never Ctrl+C: it does not reach the conductor); its tasks end `stopped` with `signal`,
  and the relaunch follows the table "Stopping a run" of the README. Relay them to the
  owner; write the owner's answers into the brief yourself (verbatim, dated) before the next run.
- A light task (`mode: "light"`) stopped after a second rejection goes to the coordinator with the proposal of the
  full mode: relaunch it without `mode` (tester, analyst after a second rejection), `start` pointing to its reports.
- With `guardSubsetCommand` in the config there is no full guard run in the task: after every programmer round with a
  new HEAD the workflow runs the selection of its guards, `guards-all.sh --select <base>` (phase "Selection"); every
  task then needs `base`, the branch of the arc (not a protected branch). Its waiter keeps waiting while the run is
  alive. A stop with "could not run" means the run left no exit code (killed); exit 124 (the step's deadline), a refusal
  of the slot queue before the run (77, 78; 72, 73), 65 (unknown base) or 69 (the remote runner) stops the task with
  `environment`. Either way: free the machine and relaunch the task with `start`.
- With `guardSubsetCommand` and `innerSelect: false` there is no selection inside the task at all (no phase
  "Selection", no selection of the tester); the programmer and the tester run only their own guards and mutations, and
  the train is the first run of all guards. A red train fixed in the product (a file outside docs and `testerWritable`,
  or a commit that names no changed file; not a merge-only conflict round) gets a short tester round before the second
  review: the acceptance of the cells the fix touches and the tester's guards over them. Red there -> a programmer round
  with `test.md` -> the tester again; still red after that -> stopped for you ("the short tester round is still red
  after a fix round - the coordinator decides"); it counts with the task's red tester rounds, so the second sends the
  task to the analyst, whose round goes on in the same ride loop (rides numbered once, at most four per run);
  `environment` -> stopped with it. A fix of guards or docs only goes straight to the second review. The light mode has
  no tester: its programmer-checker runs that acceptance itself.
- With `guardSubsetCommand` a task whose review is done rides the integration train (phase "Train"): one wait step runs
  `scripts/train.js ride --task <key> --branch <branch> --head <head after the review> --base <base> --dir <folder>`,
  and its exit code is the verdict - 0 `green` -> `done` with `train.verdict` and the result file; 10 `green-unmerged`
  -> `done` with the note "the merge waits for the coordinator" (merge `refs/runs/train/<id>` yourself); 11 `red`,
  12 `seam`, 13 `conflict` -> a fix round on `<sharedDir>/train/result/<task>-<head>.json`, the selection (with
  `innerSelect: false` none: a short tester round when the fix touches the product), the second review of the diff,
  the train again (the second red train -> the analyst inside the run; at most four rides); 14
  `arc-red`, 15 `coordinator` -> stopped for you: fix the arc or decide, then `train.js resume`; 74 and 78 ->
  `environment`, nothing was queued (`train.js enqueue` or a relaunch); 75, 124 -> `environment`, the queue entry stays and its verdict comes later without an addressee (`train.js status` names it,
  `train.js watch` ends on it; a relaunch of the task alone takes it, `train.js ack` takes it by hand); the stops 14 and 15
  name the same, and so does a train step that could not run (the ride killed, the Mac asleep) when `train.js status`
  lists its entry; 65 -> refused (a protected base
  or not a branch). The base must be a branch of the repository, not a commit.
- Accepted branches are merged by the coordinator; pushing, merging into a protected branch and tagging stay the
  owner's call.

### On Claude Code: cost and resume

- Cost: `node "${CLAUDE_PLUGIN_ROOT}/scripts/chain-cost.js" <directory with the run's agent transcripts>...` prints the
  input-equivalent cost per task and flags tasks above twice `medianTaskIE`; give it the transcript directories of all
  runs of a split feature, and it sums the parts that carry the same `feature` and flags the feature above
  `featureIELimit` (default 3 x `medianTaskIE`). Add `--journal <task folder>` for the tasks whose roles ran through the role adapter (`scripts/role-exec.js`, its `calls.jsonl`): their calls are added to the same task key, and the line names its sources. Put the lines into the report to the owner.
- An interrupted Workflow run with several tasks is never resumed with `resumeFromRunId`: cached agent results replay
  by call order, which differs between parallel tasks, so results land in the wrong task. Relaunch each unfinished task
  alone, with `start` pointing to its report and the step it stopped at.

### On Codex: cost and resume

- Cost: `node <plugin>/scripts/chain-cost.js --journal <task folder>...` (a conductor run has no Workflow transcripts;
  the role adapter's `calls.jsonl` is its source). Put the lines into the report to the owner.
- The conductor has no resume of a run: a task is relaunched with `start` and `prior`, or with the `resumeAt`, `head`
  and `prior` of a decision of `chain-run.js resolve`.
