---
name: coordinator
description: For the coordinator session; a role of the chain never runs it. Act as the coordinator of the codis-agents multi-agent process - split work into tasks, write briefs, run role chains, route verdicts, merge accepted branches, and keep the owner's decisions. Use when the owner asks to coordinate, plan a multi-agent change, or run several tasks through roles.
---

# Coordinator

**Plugin root.** `${CLAUDE_PLUGIN_ROOT}` below is the root of this plugin. Claude Code sets it; where it is empty or not
expanded (Codex), the root is the folder two levels above this `SKILL.md` (the installed copy,
`$CODEX_HOME/plugins/cache/<marketplace>/codis-agents/<version>`). On Codex write that absolute path literally into every
command, with no variable (`<plugin>` below): the rules of the coordinator's home match only the literal path.

The coordinator is the main session. It owns the briefs and the order of work; it does not write product code inside
a role's task. The full process rules are in `${CLAUDE_PLUGIN_ROOT}/rules/multi-agent.md` - read them first. On Claude
Code a project usually imports them from its `CLAUDE.md`; on Codex the session gets them from the project `AGENTS.md`
that `scripts/agents-md.js` generates when the project config sets `agentsMd` (README, "Project rules on Codex"),
otherwise read the file at the plugin root. The setup of a coordinator on Codex is the section "On Codex: homes,
sandbox and rules" below.

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
4. **Worktree.** `${CLAUDE_PLUGIN_ROOT}/scripts/wt-setup.sh <name> <branch> [base]` (on Codex it writes into the git
   folder of the repository, which the sandbox of the session refuses: it runs only with the owner's approval in the
   window, no rule covers it). Then, before the chain starts,
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
   task alone. A stop on the train whose entry stays (75, 14, 15, 124; not 74 or 78, which queued nothing; a train step that could not run - the ride killed, the Mac asleep or rebooted - when `train.js status` lists its entry, else `train.js enqueue`) leaves a verdict that comes later
   without an addressee: run `train.js watch` in the background (by host: "Waiting for a verdict without an addressee"
   below; it dispatches trains like any waiter and exits on a new verdict without an addressee, or on a new halt that leaves an entry without a
   live waiter); on its exit read `train.js status` ("verdicts without an addressee": task, head, verdict, train, the
   merged sha, the ref to merge or the files, the result file) and relaunch the task alone (its ride takes the ready
   verdict; `prior` = the counts of the stopped run) or take the verdict by hand with `train.js ack --task <t> --head
   <sha>`; `resume` names the entries without a live waiter. Do not end the session while `train.js status` shows a live
   lock of `watch` (`lock: train <id> ... by watch pid N (alive)`; a ride or a run prints `by pid N`): a train it drives dies with it. The move to a plugin version with waiter files goes between waves, in
   the same step as the plugin of the remote runner. A service change of yours into the arc (a config, a backlog line) while a train runs rides as a
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
8. **Cost.** After each run, `node "${CLAUDE_PLUGIN_ROOT}/scripts/chain-cost.js" <transcripts>` (and `--journal <task folder>` for the tasks whose roles ran through the role adapter, `calls.jsonl`); a task above twice the
   median means the next similar one is split earlier.

### Waiting for a verdict without an addressee

#### On Claude Code

Start `node "${CLAUDE_PLUGIN_ROOT}/scripts/train.js" watch` with Bash `run_in_background`, and read its output when the
background task ends; the session keeps it alive, so do not end the session while it runs (step 6).

#### On Codex

There is no background task on Codex, and a command still attached to a turn dies with the turn. Start
`node <plugin>/scripts/train.js watch --detach`: it starts the watch as a process of its own session (under the rule
for `train.js`, outside the sandbox: it dispatches trains) and prints `{pid, log}`; while a detached watch lives, the
same command returns that watch (`{pid, log, running: true}`) and starts none. On every slice of a wait (skill
`codis-agents:role-chain`, step 3) run `node <plugin>/scripts/train.js status`: the sandbox of this session cannot see
a process outside it, `status` runs under its rule and names the watch - `detached watch pid N alive`, `... ended:`
with its event (the verdicts without an addressee, or the halt), or `... gone without an event` (start it again). The
detached watch survives the session: a new session finds it by the same `train.js status`, its log in
`<sharedDir>/train/logs/`.

## On Codex: homes, sandbox and rules

The owner prepares this once; the coordinator names the steps and reads the checks. Three Codex homes, never mixed:

- the **coordinator home** - the session of the coordinator, started as `CODEX_HOME=<coordinator home> codex` from the
  project; the analysis checker runs in it too;
- the **run home** - the roles of the conductor (`--codex-home <run home>` of `chain-run.js start`), prepared by the
  README procedure and checked with `node <plugin>/scripts/role-exec.js check --host codex --home <run home>`;
- the personal `~/.codex` - never touched by any procedure of the process: no plugin, no rule, no check is written
  into it, and it is never a coordinator or a run home.

Steps of the owner, in a terminal (outside the coordinator's sandbox) or in the Codex window:

1. In each of the two homes the owner runs `codex login`; `codex plugin marketplace add <source>` and `codex plugin add
   codis-agents@codis-agents`; start `codex` in the home, open `/hooks` and trust the hook of `codis-agents` (a decision
   of the owner); then `node <plugin>/scripts/codex-hooks-check.js --codex-home <home> --cwd <project>` exits 0.
2. The run home: `node <plugin>/scripts/role-exec.js check --host codex --home <run home>` exits 0 (with a codex of a
   version it accepts; another one is refused until it is verified: `--bin` of `chain-run.js start` names a checked one).
3. `config.toml` of the coordinator home:

```toml
model = "<model>"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
writable_roots = ["<sharedDir>", "<worktreeRoot>"]

[projects."<main repository root>"]
trust_level = "trusted"
```

   The session writes briefs, reports and the start files only inside `writable_roots`; it has no network.
4. `$CODEX_HOME/rules/codis-agents.rules` of the coordinator home (`<plugin>` = the absolute path of the installed copy,
   with its `<version>`, never a working clone):

```
prefix_rule(pattern=["node", "<plugin>/scripts/chain-run.js"], decision="allow")
prefix_rule(pattern=["node", "<plugin>/scripts/train.js"], decision="allow")
prefix_rule(pattern=["git"], decision="allow")
prefix_rule(pattern=["codex", "exec", "--sandbox", "read-only"], decision="allow")
```

   These four run outside the sandbox without a window: the conductor and the train need the network and write outside
   the project, git writes into the git folder, and the analysis checker needs the network (it runs read-only itself).
   There is no rule for `wait-step.js`: it would let any command out. A rule matches only a plain argv that starts with
   its pattern - the literal path, no variable, no `nohup`, no `VAR=` in front, no `&`, no redirection - so the
   commands of the Codex blocks are written that way; anything else runs in the sandbox or asks in the window. None of
   these forms matches either (measured with `codex execpolicy check` on 0.167.0): a `node -e` wrapper, `sh -c` or
   `bash -lc`, `env` in front, a node flag before the script, any other path to node, a relative script path.
   `node <plugin>/scripts/chain-run.js` resolves `node` by the PATH of the session; `codex exec` is called by its name.
   Check a rule with `codex execpolicy check --rules <rules file> -- <command>` (the answer names `"decision":"allow"`).
   Inside the sandbox `ps` is refused, so a conductor started there cannot name itself in the lock of a task:
   `chain-run.js start` refuses with exit 69 and names `CODEX_SANDBOX`. After such a refusal, or any other that names
   the sandbox, run `codex execpolicy check --rules <rules file> -- <command>` on the command and run it again as a
   plain argv; never wrap it to get around the rule.

The `git` rule lets every git command out (`reset --hard`, `push --force` into a working branch too), as on Claude
Code; the session hook of the plugin refuses `git add -A`, a push into a protected branch and tags.

## After a plugin update

When a project uses generated `AGENTS.md` files (`"agentsMd": true`), a new plugin version or a change of a `CLAUDE.md`
or a file it imports makes them stale, and the preconditions of every new task stop on `agents-md.js check --root <wt>
--base <arc>` with the file and this route. The update itself is a service change, never a task of the chain:

1. A service branch from the head of the arc: `${CLAUDE_PLUGIN_ROOT}/scripts/wt-setup.sh <svc> <svc> <arc>`.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/agents-md.js" write --root <svc worktree>`, then
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/agents-md.js" check --root <svc worktree>` green; commit each `AGENTS.md` it
   names by path.
3. With `guardSubsetCommand` it rides as a passenger: `node "${CLAUDE_PLUGIN_ROOT}/scripts/train.js" ride --task <svc>
   --branch <svc> --head <full sha> --base <arc>` in the background (its preconditions are not run, so the stale files
   do not stop it); without the key, or once `train.js status` says `lock: free`, merge it into the arc yourself.
4. Then merge the arc into the branch of every waiting task (a stopped task is relaunched after it). When the arc
   already holds fresh files, this step alone is the route.

The running roles are left alone: a role keeps the rules it was started with (its prompt), and the update changes only
the files in the branches.

### On Codex

Only between waves: `node <plugin>/scripts/chain-run.js status <runId>` names no live run and `train.js status` says
`lock: free`. The owner, in the coordinator home and in the run home: `codex plugin marketplace upgrade` (a git source),
`codex plugin add codis-agents@codis-agents`, `/hooks` and `codex-hooks-check.js` again (Codex resets the trust when a
file of the plugin changes); the run home also `role-exec.js check`. The installed copy has a new path (its version), so
rewrite `$CODEX_HOME/rules/codis-agents.rules` of the coordinator home with it and check a command of each rule with
`codex execpolicy check --rules <rules file> -- node <new plugin>/scripts/chain-run.js status x`; then start a new
session (skills and rules are read at its start) and follow the `AGENTS.md` route above.

## Check the analysis

Before a task of a wave starts (product or plugin), its analysis is read by the analysis checker (rule "Waves"):

1. **Snapshot before.** `git -C <worktree> rev-parse HEAD` and `git -C <worktree> status --porcelain`; `shasum -a 256`
   of every file in the task folder and in the feature folder (`find <dir> -type f -exec shasum -a 256 {} +`, sorted);
   when the report `<name of the analysis>.check.md` exists, a copy of it and its size, outside those folders: the
   size in bytes, `wc -c < <copy before>` (not `stat`: its options differ between BSD and GNU).
2. **Run.** The checker, by host ("Run the checker" below), with the model of the project's `roleModel`, never above
   `opus`; its task names the analysis, the brief, the use cases and specification it cites, the worktree, the task keys
   and the report path `<folder of the analysis>/<name of the analysis>.check.md` (`analyst.md` -> `analyst.check.md`).
   When that report exists, the check appends a run to it. The reports of wave 2 named `analysis-check.md` are history:
   leave them, do not rename them.
3. **Snapshot after.** `node "${CLAUDE_PLUGIN_ROOT}/scripts/role-diff-check.js" --wt <worktree> --since <HEAD before>
   --role reviewer` must answer ok (nothing in the worktree changed), the status is the same, and the only difference
   of the folders is `<name of the analysis>.check.md`, its earlier content unchanged: the file before is an exact
   prefix of the file after (`head -c <size before> <report> | cmp -s - <copy before>` answers 0, from the copy and size of step 1;
   not `cmp -n`: BSD `cmp` answers 1 for files of different length). Anything else voids the check: undo the change, say so in the brief, run again.
   An experiment that left a process behind (the agent may start none) is stopped: `ps` by the worktree path and by
   the scratchpad of the checker's session, where its experiments run (on Codex the checker runs none: its sandbox is
   read-only).
4. **Fallback.** When the environment refused the agent's write, it returns the full text of its run: append it to
   `<name of the analysis>.check.md` next to the analysis yourself (a new file for the first run), with a line
   `Saved-by: coordinator` under the header of the run. Fill in
   `Analysis-sha256` (`shasum -a 256 <analysis>`) when the agent could not.
5. **Closure.** For `changes-needed`, write the section Closure of this run (the last one of the report): one line per significant gap G-n - closed
   in the brief or the analysis (with its layer mark: principle N, or "coordinator's decision, not from the model -
   candidate"), a question in the preparation list for the owner, or out of the task with its reason. A line
   `Closure-sha256` is optional. The task goes into the wave only when every significant gap has its line. Two runs of
   one version for a task with different verdicts: a `changes-needed` needs its Closure lines, and a later `ready` of
   the same version does not cancel it; both verdicts are named to the owner.

### Run the checker

#### On Claude Code

The agent `codis-agents:analysis-checker` with the model of `roleModel`, never above `opus` (a `fable` there runs the
checker on `opus`: the owner's word, analysts not on Fable). It writes its run into the report itself; a refused write
goes by step 4.

#### On Codex

`codex exec` in the coordinator home, read-only, with a fixed version of the analysis. Every launch is a run of its own
in `<sharedDir>/analysis-checks/<sha256>/` (`<sha256>`: `shasum -a 256 <analysis>`), outside the worktree and the task
and feature folders; no result of an earlier run is removed or overwritten, and every result reaches the owner.
`analysis-check.js` runs in the sandbox (no rule: it writes only there and into the report next to the analysis):

1. **Prepare.** `node <plugin>/scripts/analysis-check.js prepare --shared <sharedDir> --analysis <analysis> --task <key> --worktree <worktree> --model <model> --brief <brief>`
   (`--task` once per key the check is for; `--use-cases` and `--spec` when the task has them; `<model>`: `codex.models`
   of the project config for `roleModel`, never above the model of `opus`). It copies the analysis as
   `analysis-<sha256>.md`, writes `task-<n>.md` (the checker's text without its frontmatter, then the task: the copy,
   the original path and the sha256, the brief, the use cases, the specification, the worktree, the task keys, and "This
   sandbox is read-only: write nothing and run no experiment that writes; a premise that needs one is `unverifiable
   (read-only sandbox)`. Return your run of the report in the field report and the sha256 of the copy in
   analysisSha256.") and the marker of run `<n>`, and prints `{run, sha, dir, argv, command}`. On its exit 3 show
   what is there and run nothing: a result of this version for a key (in `runs/`, in the earlier layout
   `analysis-checks/<task>/<sha256>/last.json`, or a run of `<name of the analysis>.check.md` with this
   `Analysis-sha256` and the key in `Tasks`) - show it to the owner; a new run only with `--again <reason>` (another
   model, a brief changed while the analysis did not); or a pending run - poll the command that runs it. Only when the
   turn that ran the command has ended without an answer: `prepare ... --abandon <n> --reason <why>`.
2. **Run** the command it printed, once, directly, under its rule: `codex exec --sandbox read-only --ephemeral --skip-git-repo-check --output-schema <plugin>/schemas/analysis-check.schema.json -o <check folder>/runs/<n>.json -C <worktree> -m <model> "Read <check folder>/task-<n>.md and do what it says."`
   When the shell tool answers "still running", poll that same command in the same turn; never run it again: a second
   run overwrites `runs/<n>.json`. Do not end the turn while the checker runs.
3. **Collect.** `node <plugin>/scripts/analysis-check.js collect --shared <sharedDir> --analysis <analysis> --run <n> --exit <N>`
   records the exit of `codex exec` and shows every run of this version with its state: a result (the answer
   `runs/<n>.json` is `{analysisSha256, tasks, verdict, significantGaps, report}`; it counts only for the keys in its
   `tasks`), not-run with its reason, or pending. When the snapshot after (step 3 above) did not void the check,
   `node <plugin>/scripts/analysis-check.js collect --shared <sharedDir> --analysis <analysis> --run <n> --append`
   appends `report` to `<name of the analysis>.check.md` with `Saved-by: coordinator` under the header of the run and
   `Analysis-sha256` filled in when missing; a second `--append` of the run writes nothing. Two verdicts of one version
   for a key (`--again`, a late answer of an abandoned run, a second `codex exec` that rewrote an answer `prepare` or
   `collect` had seen: every answer a command saw stays in the journal of the run) are both appended and both named to
   the owner (step 5). When the analysis later changes, its sha256 differs: that
   version was not checked, prepare again.
4. The third outcome, "analysis check not run: <reason>", when any of these holds: `codex exec` ended with an exit other
   than 0; no `runs/<n>.json`; a JSON that does not fit the schema; `analysisSha256` differs from the sha256 of the copy;
   `ready` with `significantGaps` above 0, or `changes-needed` with 0; the header lines of `report` disagree with these
   fields; the snapshot after (step 3) voids the check. The conditions on the exit and the answer (all but the snapshot)
   make the run not-run unless the journal of the run already holds an answer: then step 3 applies (`collect` shows
   the recorded answers as results with a note even after an exit other than 0, a `runs/<n>.json` gone or now not a
   verdict, and `prepare` refuses a new run while they are there). `collect` names each other case as not-run. Then
   write nothing into `.check.md`, add the line `analysis check not run: <reason>, <date>` to the brief, and prepare
   again: it is not a passed check and not a failed one, and the task stays out of the wave until a run gives a verdict.

## Limits

- Never push, merge into a protected branch, or create tags on your own initiative; one explicit request authorizes
  exactly one of them. The plugin's hook and `scripts/git-hooks/pre-push` refuse them without `ALLOW_PROTECTED_PUSH=1`.
- A project may grant standing permission to push process-rule changes to the plugin repository; then check the diff
  for secrets and personal paths before each push and commit as a noreply author. It never covers the product
  repository.
- Before removing a worktree or a data directory, the owner says "yes" to the list of what goes with it: ignored data
  with sizes and symbolic links that lead into it, from `scripts/wt-remove-check.js`. A clean `git status` does not show
  ignored files.
- Do not resume a multi-task Workflow run from its cache (Claude Code, skill `codis-agents:role-chain`); relaunch each
  unfinished task alone with `start`.
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
