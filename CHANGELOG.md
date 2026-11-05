# Changelog

Every version of the codis-agents plugin, newest first. What the plugin does now is described in
[README.md](README.md); its [Technical reference](README.md#technical-reference) is the current state of every rule,
key and script, and this file says when and why each one changed. Versions before 0.4.14 are in the git history.

## 0.4.30 - 2026-11-05

- **Install under Codex CLI and a read-only check of the hook's trust** (p-codex-D1b; owner 2026-11-05 answers 1, 2
  and 5: "all as recommended"). Codex runs a plugin hook only after the user trusts it in `/hooks`, and resets that
  trust at every change of any file of the installed plugin, an update included, so the git protection of the hook
  went silent after each update without a sign. New `scripts/codex-hooks-check.js --codex-home <dir> [--cwd <dir>]`
  asks Codex itself: it starts `codex app-server` with `CODEX_HOME` = the realpath of `--codex-home` (never the
  parent's) and `hooks/list` over stdio JSON-RPC, matches answers by `id` and skips notifications, checks that
  `initialize` names the same `codexHome`, and exits 0 only when every hook of this plugin (`pluginId` before `@` =
  the `name` of `.claude-plugin/plugin.json`) is `trusted` and `enabled` and the answer has no errors; 1 names what
  to do (`/hooks`), 3 is "not checked" (no `codex`, no answer in `--timeout-ms`, 30000 by default, an answer off the
  schema), 2 refuses the personal `~/.codex` before any start (the same directory by device and inode, so a link, a case
  variant on a case-insensitive disk and the `/System/Volumes/Data` firmlink are refused too). It never writes trust. Tested on a fake app-server
  (`tests/codex-hooks-check.test.js`). No second Codex manifest: `tests/codex-manifests.test.js` forbids
  `.codex-plugin/`, a root `plugin.json`, `.agents/plugins/marketplace.json` and `api_marketplace.json`, each of
  which Codex would read over `.claude-plugin/`. README "Install" has a Codex CLI part (install, `/hooks`, the check,
  update = `marketplace upgrade` + `plugin add` + `/hooks` again); "What's inside" counts recounted.

## 0.4.29 - 2026-11-05

- **The session hook under Codex CLI** (p-codex-D1a; owner 2026-11-05 "p-codex: 1-5 as recommended", "all as
  recommended, start wave 8"). Codex CLI 0.166.0 installs this repository as a plugin as it is and runs the same
  PreToolUse hook `scripts/hooks/guard-bash.js` from `hooks/hooks.json`; measured (experiment X-D), the model's shell
  `exec_command` reaches it as `tool_name: "Bash"`, `tool_input: {"command": "<string>"}` with the tool's working
  directory as the input's absolute `cwd`, and no `CLAUDE_PROJECT_DIR` in its environment. No change of the hook's
  code: new `tests/hooks-codex.test.js` pins its verdicts on that input (a blanket `git add`, pushes to protected
  branches and tags, a commit of the arc under a live train, the real process started by the line of
  `hooks/hooks.json`, the input's `cwd` judged rather than the process's directory, the raw inputs of X-D, silence for
  `apply_patch` and MCP tools) and that `hooks/hooks.json` and `.claude-plugin/marketplace.json` stay as they were for
  Claude Code. README "Known gaps": what the hook does not see under Codex (`write_stdin`, the user's own `!`
  commands), the trust Codex resets at every change of the plugin, fail-open, the chain not yet on Codex.

## 0.4.28 - 2026-11-05

- **Chain cost for both hosts: `chain-cost.js --journal`** (p-codex-C; owner 2026-11-05 "C 1-2 as recommended").
  Calls of the role adapter leave no transcript (`codex exec --ephemeral`, `claude -p --no-session-persistence`); the
  adapter already writes one line per call to `<task dir>/calls.jsonl`, and `--journal <task folder | calls.jsonl>`
  (repeatable) now reads it: one IE formula, fresh + 1.25 x cache write + 0.1 x cache read + 5 x output, where codex
  fresh is `input - cachedInput - cacheWrite` (its input holds the cache) by the price table of `gpt-6-astra` (cache
  writes $12.5 = 1.25 x input, so they are not zero on an API key) and claude fresh is `input`; output is the real
  output tokens, codex reasoning not added. Every call counts once: a journal named twice is read once (device and
  inode), the same `callDir` in two journals once, records without `callDir` never merged, `refused` calls are no
  agents, the call folders are never read. Transcripts and journals add up per task key, the line names its sources
  (`[workflow 4.2M, claude 0.5M, codex 0.6M]`) and the 2 x median flag uses the one `medianTaskIE`; the feature of a
  journal key comes from the run record or the records' `feature`. Without `--journal` the output is unchanged. New
  guard `tests/chain-cost-journal.test.js` on the real usage of experiments X0 and G6 (E1 343 913, G6 202 019.75,
  E1c 529 714.2 IE).

## 0.4.27 - 2026-11-05

- **The role adapter, part A1b: the process of a role** (p-codex-A1b; owner 2026-11-05 "p-codex: 1-5 as recommended",
  "9 questions on p-codex-A1 as recommended", wave 8). `scripts/role-exec.js` now starts the host CLI itself when
  `cfg.launch` is not given (`spawnRole`): no shell, a process group of its own, the prompt on stdin, the JSONL stream
  saved and parsed line by line, the outcome by the fields of the terminal event, the exit code and the signal
  (`ok`, `schema-refused`, `rate-limited`, `auth`, `crashed`, `killed`, `ceiling`, `signalled`, `no-result`,
  `invalid-result`; no retries). The ceiling is 3 h on the monotonic clock with SIGTERM, 30 s, SIGKILL to the group
  (owner answers 2 and 9; no silence timer); SIGTERM/SIGINT/SIGHUP to the adapter stop every live group the same way,
  then `process.exitCode = 128+n` and no new call starts. The record of a call carries the host's raw usage numbers
  (codex: the sum of every `turn.completed`, the number of them in `notes`), `costUSD` of claude, notes (error events,
  rate limit events, permission denials, `modelUsage` against `result.usage`, the codis-agents plugin and the tools of
  the claude `init` event) and the reason of every non-ok outcome in `cfg.log`. `claude -p` runs with cwd the task
  folder, `--strict-mcp-config` and `--disallowedTools` (subagents, schedules, notifications). Every call gets a folder
  of its own (`mkdtemp`); the personal `~/.codex` as the run home is refused (owner decision 6). `env-check.js`: a swap
  that cannot be measured is a problem when the floor is on the command line (a codex sandbox refuses `sysctl`).
  Claude: a `rate_limit_event` whose status is not `allowed`, followed by an error, is `rate-limited` (UC-2 Errors 5).
  Codex: the plain-text plan limit of a ChatGPT subscription is `crashed` for now (README, Known gaps): the
  `exec --json` stream of codex 0.166.0 has no structured field for it.

## 0.4.26 - 2026-11-05

- **Code comments describe the current code** (owner 2026-11-05 "yes", after an outside review of the product project
  by GPT found that the comments of its AI edit loop retell the history of decisions and hide the current behaviour).
  New marked rule `comments` in `rules/multi-agent.md` (Roles, under Programmer), in `RULE_LIST` of
  `workflows/role-chain.js` and so in every role prompt, and in `agents/programmer.md` and `agents/reviewer.md`: a
  comment says what the code does now and why (the invariant, a non-obvious constraint, the source of a rule); the
  history of decisions goes into the commit message, the brief and the reports; a change of behaviour rewrites the
  comments next to it instead of appending a paragraph; the reviewer rejects a comment the code contradicts (docs the
  code contradicts) and lists a history-only comment under "Tails".

## 0.4.25 - 2026-11-05

- **The role adapter, part A1a: its contract and data** (p-codex-A1a; owner 2026-11-05 "p-codex: 1-5 as recommended"
  and "9 questions on p-codex-A1 as recommended"). New `scripts/role-exec.js`: `createAgent(cfg)` returns
  `agent(prompt, opts)` with the contract of the Workflow `agent()` (an object of the schema or `null`, never an
  exception) for the hosts `codex` and `claude`. The task comes from the label and the role from its kind (`agentType`
  only picks the body and must match it); `strict()` and `unstrict()` are pure functions that turn the twelve schemas
  of `role-chain.js` into the strict form the OpenAI API requires (`additionalProperties: false`, every key required,
  optional fields nullable; the live check accepted all twelve) and back (a `null` is removed only from a field that was
  optional and not nullable, so `RUN.rc: null` stays); the answer is checked against the original schema; refusals
  before any process (unknown task or kind, a foreign or mismatched `agentType`, a missing role file, an unknown schema
  keyword, a model outside the table or the catalog, an effort the model lacks, `pre`, service steps and
  programmer/tester on codex); the codex model table `opus -> gpt-6-astra`, effort `high` (owner, question 8); the codex
  prompt `body.trim() + "\n\n" + prompt` saved as `prompt.txt`; one line of `calls.jsonl` per call; `role-exec.js check`
  for both hosts without a model. The process of the role (A1b) and the chain on the adapter (B) come later;
  `role-chain.js` is unchanged. `createAgent` on codex refuses a config without an absolute `codex.home` (the run home
  with its own login, owner decision 6): the child never runs in the parent's `CODEX_HOME` or the personal `~/.codex`,
  also when the catalog comes from `codex.catalog` (review 1).

## 0.4.24 - 2026-11-05

- **The reviewer's rejection bar** (p-codex experiment X0: a GPT reviewer through Codex rejected a task whose truth was
  "done" over minor points; owner 2026-11-05 "1 yes"). `agents/reviewer.md`, `rules/multi-agent.md` and the README now say
  what a rejection is for - a broken cell of the acceptance or the matrix, a changed path without a guard or mutation, a
  regression, a security hole, docs the code contradicts - and that a minor point or a risk outside the task's cells goes
  under "Tails" in `review.md` instead.

## 0.4.23 - 2026-11-04

- **A role does not end its turn to wait** (p-tester-drop; diagnosis of two cut-off testers in wave 5, owner
  2026-11-04 "everything as recommended"). In a workflow agent a turn without a tool call is the end of the role: the
  harness then forces the final output (`[structured-output-enforce]`), the verdict is given with the role's own work
  (a held stand ticket, an acceptance, a full run) killed, and Monitor never wakes it - its events arrive only as an
  attachment to a next request, and a turn of text makes none. The seven waiting places now say how to wait: start the
  heavy command with Bash `run_in_background`, then wait for it with a *separate* blocking Bash loop
  (`until <its final log line, or the process has died>; do sleep 3; done`, timeout 270000) repeated while the process
  is alive, not with Monitor. Rules `pauses` and `slots` of `role-chain.js` and `rules/multi-agent.md`, the
  `standSteps` and the tester's environment line, `agents/tester.md` and `agents/programmer.md`, and the README carry
  the new wording; the H1 guard no longer keeps "never a blocking Bash call" next to "wait with a blocking loop" (G3),
  so the rule stops contradicting itself (the heavy command itself is never a blocking call; its wait is one).
- **`wait-step.js watch`**: a deterministic wait for a command a role started with `run_in_background` whose pid it does
  not own (a stand `take` that holds the ticket and never ends). `watch --log <file> --until <regex> [--pid-file <file>]
  [--max <s>]` prints `{matched, alive, max, log, tail}` and returns on the matched line, not on the process's end; with
  `--pid-file` a process that dies before the line ends the wait with `matched:false, alive:false`. `--max` is clipped
  to 270; no `--deadline` and no kill (a stand queue in the hour is normal).
- **Role agents disallow Monitor** (`disallowedTools: ... Monitor` in the frontmatter of `tester`, `programmer`,
  `reviewer`, `security-reviewer`, `analyst`): the harness suggests Monitor at every blocked `sleep`, and one rule
  text alone could not always win against it. The coordinator's own session keeps Monitor (it has a user turn).
- **`chain-cost.js` counts "waiting drops"**: an `end_turn` followed by `[structured-output-enforce]` while a
  background job the agent started is still alive. Live jobs are tracked by id: a start is a tool_result that begins
  with the harness echo `Command running in background with ID: X` or `Monitor started (task X`, or whose last
  paragraph is the echo `Command did not complete within its Ns timeout and was moved to the background (ID: X).
  Output is being written to: .../tasks/X.output. ...` - a blocking-loop wait that overran its timeout keeps running,
  is notified by its own id and is killed at the final response, as the echo itself says (analyst of the second
  rejection: 360 such echoes in a real session, 322 notified by their id, 16 after partial stdout; the earlier reading
  "the timeout line is the correct wait, no start" missed the main remaining drop under the new rule - a moved loop,
  then "Waiting."). The job ends with a notification `<task-id>X</task-id> ... <status>completed|failed|killed</status>`
  (repeats of one notification remove the same id) or with a TaskStop result `Successfully stopped task: X` /
  `Task X is not running` (150 stops, none followed by a notification). Only lines with a message mark or clear the
  turn boundary, so an attachment line between the `end_turn` and the enforce hides no drop; `api-request-blob` lines
  are a copy of the request, not events, and are not read. Patterns on the raw transcript line are not used: they
  matched the instruction text in every agent's first lines and counted one notification several times (tester round
  2: 44 of 56 drops of a real session were false `run:` steps, and a hidden green was lost). Deterministic, no
  threshold; printed next to the IE with a WARNING, so the green/ready verdicts whose own checks were cut off mid-wait
  (which leave no other signal) are seen by the coordinator. On that session it gives 13 drops (the diagnosis's 17
  are these 13 plus 4 turns cut off mid-stream with no enforce, which are not drops).

## 0.4.22 - 2026-11-04

- **A train verdict for a stopped chain is not lost** (p-verdict-orphan-a; the owner 2026-11-03, translated: "take the
  verdict without an addressee into wave 5"; "1-13 as recommended": the waiter registry - yes, a ride that does not
  leave under a halt - no, the dispatcher that drives a foreign train - a separate task). A `ride` or an `await` of its
  own entry writes `<sharedDir>/train/waiters/<task>-<head>-<pid>.json` `{pid, procStart, state, at}` and marks it
  `claimed` or `left` on its exit (procStart from `LC_ALL=C ps -o etime=`, so neither a reused pid nor the locale fools
  it); the result it returns as its own is taken (`claimedAt`, written before the mark); `finish` copies the entry's
  `enqueuedAt` into the result. A result not taken, with waiter files and no live waiting process among them, not
  superseded by a later head of the task, is a verdict without an addressee: `train.js status` names it after its
  unchanged `halt:`/`lock:`/`queue:` lines and marks the queue entries `waiter pid N alive` or `no live waiter`;
  `train.js resume` names the entries without a live waiter; new `train.js ack --task <t> --head <sha>` takes a verdict
  by hand; new `train.js watch` is the coordinator's background wait - it dispatches like any waiter and exits on a new
  verdict without an addressee, or on a new halt that leaves an entry whose waiters are gone without reporting it.
  Results and entries of older versions have no waiter files and are never orphans. The stops 75, 14, 15 and 124 of
  the chain name `train.js status`, `train.js watch` and `train.js ack` instead of "a relaunch attaches", and so does a train step that could not run (the ride killed from outside, the Mac
  asleep or rebooted) when `train.js status` lists its entry; 78 (no project config) says, like 74, that nothing was
  queued. `status` prints the lock of `watch` as `by watch pid N` (owner file field `by`), the line of a ride or a run
  as before; the train
  rule, the coordinator skill (6. Route: `watch` in the background; the session is not ended while a live lock of
  `watch` shows; the version moves between waves with the plugin of the remote runner), the role-chain skill and README
  say the same. Exit codes do not change. Why: cvy-text-reader-1 2026-11-03 - its ride left with 75 under a halt 8 s
  before `resume`, the verdict red came at 15:17 with nobody waiting, the relaunch came at 15:41.

## 0.4.21 - 2026-11-03

- **README for the next user** (p-readme-3; the owner 2026-11-03, translated: "take 1, measuring the benefit of the
  roles, and 3, separating the process from the runtime. Everything is done for the convenience of the next user.
  And let us throw everything about our Mac and stack out of the README. The structure and logic itself we do not
  touch - it works. Also 5, the entry threshold by terms"; on the approved page: "yes, move it into the plugin 0.4.21,
  now it looks great!"). "Do the roles pay off?" with a funnel and a cost chart from a measurement of 249 runs
  (2026-10-24..11-03); the process apart from the optional local runtime; glossary; an end-to-end example; no owner's
  machine or stack; the analysis-check row corrected to IE (1.9M, was raw tokens 0.46M). The charts come in a light
  and a dark variant (`assets/roles-*-light.svg`, `assets/roles-*-dark.svg`). No behaviour change.

## 0.4.20 - 2026-11-03

- **README: banner, badges, role cycle line, "Why codis-agents?" table with measured before/after and sources, Quick
  start table, What's inside tree, GitHub callouts** (p-readme-2; the owner 2026-11-03, translated: "yes, let's try it
  loud. it matters that others notice it, and that it helps them"). The banner comes in a light and a dark variant
  (`assets/banner-light.svg`, `assets/banner-dark.svg`); "Start here - no plugin needed" is now a tip callout in the
  plain part. No behaviour change.

## 0.4.19 - 2026-11-02

- **README for a first-time reader; the history moves here** (p-readme; the owner 2026-11-02, translated: "make the
  plugin's README readable and interesting for a simple user, and move the technical part for professionals into a
  separate block"; on "the version history into CHANGELOG.md?": "yes, into CHANGELOG.md"). The top of README now
  says in plain words what the plugin is, why a team of role agents instead of one, what a working day looks like
  (waves, the digest, the train), a quick start, what the owner gets and a short example. Everything technical stays,
  unchanged, in one block below the heading "Technical reference": every earlier section and every key of both
  config files. The sections "Changes in 0.4.x" moved from README into this file, newest first. A change of the
  plugin now updates the Technical reference (behaviour) and adds its entry here (the version); the tests that read
  the version entries read this file.

## 0.4.18 - 2026-11-02

- **The analysis is checked before the start** (p-analysis-check-a; the owner 2026-11-02, translated: "our approach of
  checking the analysis of cases beforehand seems to have paid off? let us formalize it in the plugin, so that wave 3
  starts on the new plugin"). A new agent `analysis-checker` (frontmatter like the reviewer's) reads an analysis before
  its task's chain starts and writes one report per analysis next to it, `<name of the analysis>.check.md` (a repeated
  check appends a run): a header (`Analysis`, `Analysis-sha256`, `Tasks`, `Verdict: ready | changes-needed`,
  `Significant gaps`), sections Premises, Missing sources and consumers, Guards: red without the fix?, Acceptance on the owner's real data, Coordinator's decisions, Gaps (G-n) and Closure,
  written by the coordinator. A refused write returns the text, saved by the coordinator with `Saved-by: coordinator`.
  The rule "Waves" gains the preparation step (product and plugin tasks; none for `noAnalysis`; every significant gap
  closed in the brief or sent into the owner's questions of the preparation), the coordinator skill the step itself
  (model never above `opus`, a snapshot before and after, `role-diff-check.js --role reviewer`, Closure). A coordinator
  rule only: the workflow does not check for the report yet (a precondition, a project key and a task field are a later
  part).
- **A red train is attributed by every rerun section of its log** (p-train-attr; the owner 2026-11-02). A full run on
  the remote runner leaves two rerun sections in one log, the runner's and the part here's; `repeatedInLog` and
  `flakyInLog` (`scripts/guards-result.js`) read only the last, so a red repeated on the runner was lost when the part
  here had only flaky guards, and the train stopped for the coordinator instead of giving its passenger red (train
  20261102-133002999-28977). Both now take the names of every section (from its header to the first empty line, the
  next `==== ` line or the end; a guard's own output outside the sections never counts), once each: the train's red
  verdict and its attribution on the selection logs. The quarantine of a remote run is unchanged: it reads the
  runner's log alone, before the part here is appended (one section).

## 0.4.17 - 2026-11-01

- **The counters of a task survive a relaunch: the task field `prior`** (p-testerred-route; the owner's request
  2026-11-01: "fix the failure in the plugin"). The rules count red tester rounds, red trains, the one analyst of a
  second red or rejection and the one pass "Mechanism" per task, but the workflow kept them for one run: a relaunch
  with `start` began from zero. In cvm-wheel-c (run wf_68338028-44b) the first red tester round of the relaunch was the
  second of the task and went to the programmer; the analyst came one red later. Now a relaunch passes
  `prior: {testerReds?, trainReds?, rejections?, analyst?: "tester-red" | "rejection" | "train-red", mechanism?: true}`,
  a copy of the field `counts` of its earlier run's result; the workflow checks it before any agent (a wrong value or key, or
  `testerReds` above 0 in the light mode, stops the task on preconditions), starts its counters from it and logs it.
  With a seeded `analyst` a red tester round (or, for `train-red`, a red train) stops the task as after the analyst of
  the same run, and a second rejection for code stops it without a second analyst; with `mechanism: true` a status
  `mechanism` goes to the coordinator. The analyst of the second red names the reds of earlier runs. `start` stays text
  for the programmer; the line "say in `start` that a pass was made" of 0.4.16 is replaced by `prior.mechanism`.
  Every task result carries `counts` in the shape of `prior`, the seed included (a refusal after a valid `prior` carries
  the seed, a refused `prior` none): the coordinator copies it into the next `prior` and recounts nothing from `test.md`
  (review 1: a hand count lost a red in cvm-wheel-c, and would count an environment round). `prior.rejections` carries
  the review rejections since the last analyst of the task: after a run stopped past rejection 1, the relaunch's first
  rejection is the second (analyst, or a stop after an analyst, or the coordinator in the light mode).
- **Waves** (owner 2026-11-01): at most three product chains at once, prepared (brief, use cases and matrix,
  "Mechanism", mockup, experiments) and answered by the owner before they start together; no question to the owner
  while a wave runs - a layer 3 question stops only its task; one digest per wave (results, what to check on the
  screen, questions with recommendations and the principle each may contradict, candidate decisions, tails) when every
  task is done or waits. A coordinator rule only: the workflow does not count chains.

## 0.4.16 - 2026-11-01

- **A mechanism is challenged before cells** (p-mechanism; owner 2026-11-01: "yes to the step 'challenge the
  mechanism'"; diagnosis mechanism-gap: four tasks of one window, about 75-85M above their price, no new role). The
  analyst's section "Mechanism" for a task with a new channel, protocol, timing or state, with a choice seen on the
  screen or resting on time as a question to the owner (an exception from layer 2); the programmer's status
  `mechanism` -> one analyst pass inside the run -> the programmer again, a second one to the coordinator; "mechanism
  or cells?" first for the analyst of a second red tester round, a second rejection or a second red train, with the
  right to replace the mechanism (`mechanismOrCells` in its answer); one line "Mechanism:" in the reviewer's report.
  The run records by whom the section "Mechanism" was written last (the pass or a later analyst that answered
  "mechanism"), and every later programmer, programmer-checker, tester and analyst prompt names that author; an answer "cells" keeps
  every section "Mechanism" (the matrix is added to the earlier sections), and the pass keeps the other sections. The
  rule is marked `role:mechanism` and reaches every role prompt.
- **The analyst before the first programmer can be the author of the mechanism** (review of p-mechanism). The
  analystFirst analyst says in its answer whether it wrote a section "Mechanism" (`mechanismSection`); when it did, the
  run records it as the section's author, so the pass after a later status `mechanism` names the section it replaces
  and every later round and analyst names that author. Before, the pass added a second section without naming the first.
- **A pass made in an earlier run is said in `start`** (review of p-mechanism). The limit of one pass is per run, so a
  relaunch with `start` begins a new count; the coordinator names a pass already made in `start`. The line is now in
  the rule `role:mechanism`, the coordinator skill and the role-chain skill (field `start`), not only in README.

## 0.4.15 - 2026-11-01

- **Only the train: no selection inside the task** (p-train-only; owner 2026-11-01, translated: "1. Only the train, plus a short
  tester round after a red train"). New project key `innerSelect` (default `true`: as before). With `false` the
  workflow runs no selection after a programmer round and the tester none of its own; both run only their new or
  changed guards and mutations, and the integration train is the first run of all guards. A red train fixed in the
  product gets a short tester round (the acceptance of the cells the fix touches, the tester's guards over them) before
  the second review; a fix of guards or docs only does not, and the light mode has no tester (its programmer-checker
  runs that acceptance). A short tester round still red after one fix round stops the task for the coordinator; the
  second red tester round of the task sends it to the analyst, whose round goes on in the same ride loop (the rides of
  a run are numbered once, at most four). The second red train still sends the task to the analyst,
  counting only `red` (the task's own finding). Measured (diagnosis train-only, 80 tasks): a selection found a real
  finding in 21 % of tasks while every task waited for it, a median of 32 min.
- **The attribution of a red train runs a guard only where it exists** (p-train-only). A red guard that is a file of
  the train's tree and is absent from the bare arc head (a new guard a passenger brought) is not run there and is not
  the arc's red; it runs on "arc + X" only for the passengers whose tree holds it, so the passenger who brought it gets
  `red`. Before, the bare arc head "accounted for 0 of N" (exit 69) and the queue halted as the environment (train
  20261101-132215552-80147). The guard names must be paths from the repository root (as `git cat-file -e <tree>:<name>`
  reads them); a name that is not such a file is run on every tree, as before.

## 0.4.14 - 2026-11-01

- **The tester selects only its own diff** (p-tester-select). With `guardSubsetCommand` the tester, after its own
  commits, runs `guards-all.sh --select <the programmer's HEAD of its round>`: its guards, the guards that import or
  name a fixture it changed, and `guardAlways`; no commit of the tester - no selection of its own. The workflow's
  selection from the task's `base` after every programmer round, the train and the light mode are unchanged
  (measured 2026-11-01: the tester's repeat of the whole selection took a median of 17.9 min of a task's path).
- **A docs-only merge after a train conflict skips the selection** (p-merge-docs). New project key `mergeOnlyFiles`
  (globs of docs files, default `[]`: off) and `scripts/merge-only.js`: a fix round after a train `conflict` that is
  one merge of the arc, with every conflicted or hand-edited file matching those globs, goes straight to the second
  review and the train. A file that also matches `guardFiles` is a guard, not docs, and keeps the selection
  (`merge-only.js --guards`, passed by the workflow; a tail of the review of p-merge-docs).
- **The train goes first in the worker budget and on the remote runner** (p-runner-share). A run with `--priority`
  never shares its workers with a full run without it: a selection that comes waits or takes what a fixed-worker train
  leaves, a running selection drops to one worker while its guards finish; the flag travels with a remote run
  (`guards-remote.js --priority`), so the runner's own run is first in the runner's queue and budget.

