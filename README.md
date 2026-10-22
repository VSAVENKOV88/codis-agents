# codis-agents

**Agents are not what makes this work. What is written down around them is.**

A multi-agent delivery process for [Claude Code](https://claude.com/claude-code), packaged as a plugin: a coordinator
session, a chain of role agents that try to refute each other, and the written rules that keep them honest. It grew out
of a real product built with Claude Code on a single 16 GB laptop, several task chains a day, and every rule in it
exists because something broke without it.

## Start here - no plugin needed

Three habits carry most of the value, and they work for one person with one agent:

1. **A brief before work.** A file with the requester's words quoted verbatim and dated, and the acceptance written as a
   scenario in the real environment ("Add -> the item builds with no tab open"), not as a feature name.
2. **A red guard before code.** The agent first commits an executable check that fails on the current code, then the fix.
3. **Mutation after the commit.** Break the fix, see the guard go red, restore it, see it green. A check that does not
   turn red on a broken fix proves nothing.

Everything below is how those habits scale to a chain of roles and a dozen tasks a day.

## Terms

| term | meaning |
|---|---|
| guard | an executable check (`*-run.js`) judged by its exit code |
| brief | `BRIEF.md` of one task: the owner's words verbatim, scope, acceptance scenario |
| arc | a connected group of tasks over one surface, with one specification agreed up front |
| principles | the arc's numbered list of accepted decisions, each with its source and what it replaces |
| coordinator | the main session: writes briefs, starts chains, merges, decides what the principles answer, asks the owner the rest |

## The role chain

```mermaid
flowchart LR
  owner([Owner]) -->|decisions, verbatim| coord[Coordinator<br/>brief, merge]
  coord --> pre{Preconditions<br/>acceptance, scope}
  pre -->|incomplete brief| coord
  pre --> analyst[Analyst<br/>matrix, split]
  analyst -->|over ~30 cells: split| coord
  analyst --> prog[Programmer<br/>red guard, then code]
  prog --> tester[Tester<br/>own inventory, acceptance]
  tester -->|red| prog
  tester --> reviewer[Reviewer<br/>tries to refute]
  reviewer -->|rejected: fix round| prog
  reviewer --> merge((Merge<br/>full guard run))
```

Each role runs as its own agent in its own git worktree. A second rejection for code stops the fix rounds: the next round
starts with the analyst. Work on access, keys or cookies gets a security reviewer as well. A role that hits an open
question writes it into its report for the coordinator and never answers it itself.

## Decisions live in three layers

| layer | what it holds | size on the project it came from |
|---|---|---|
| brief | one task: the owner's words, scope, acceptance scenario | one file per task |
| principles | numbered decisions, each with its source and a "Replaces:" line | 121 decisions |
| short model | one-sentence rules, each linked to the principle it comes from | 31 rules, two pages |

When a role asks a question, the coordinator:

1. answers it itself when an accepted principle answers it, and writes "decided by principle N" into the brief;
2. answers it itself when no principle does but the answer is reversible and local (one task; not a storage format, an
   address, sharing, data deletion or security), marked "coordinator's decision, not from the model - candidate" and
   listed in its report so the owner can overturn it;
3. sends everything else - everything the owner judges by looking at the screen (look, placement, UI wording),
   anything new or irreversible, two principles in conflict - to the owner as one list, each question with a
   recommendation.

A role never answers an owner question itself: it writes the question into its report for the coordinator.

## What counts as evidence

- **Guards**, red first, and **mutation-tested after the commit**.
- **Two browsers** for anything visual: WebKit drops things Chromium draws.
- **The real environment**: a change that touches two services is accepted in a two-service container stack driven
  through the real client, not in one process on the laptop, where guards stay green while the image fails.
- **A full guard run** after every merge: "N green - N new red - N known red"; only new red is a regression (known reds: config `guardBaseline`).

Its limit, honestly: no headless browser reproduced a blurry label in real Safari. A person looking at the screen found
it. Agents do not replace that.

## Rules that grew out of failures

| what happened | rule |
|---|---|
| a feature took three days with about ten owner questions per task; one decision flipped three times | a specification of the whole arc before its first task; one numbered `PRINCIPLES.md` with "Replaces:" lines |
| a decision the owner made never reached the list and was never started | a decision not in the principles is lost; the list is the only list |
| a layout arrived "locally" with a mockup, no decision behind it, and had to be redone | what the owner judges by the screen is never decided by an agent; a mockup of all states before code |
| a UX spec last touched at a redesign said nothing about the features built after it | living specs change in the same commit as the behaviour they describe |
| one task was re-scoped three times mid-flight and cost twice the median | split before the first programmer: over ~30 cells or more than two subsystems |
| the precondition check stopped tasks with an incomplete acceptance three times in one day | acceptance is a scenario in the real environment |
| agents were killed while their run waited for a heavy slot | reports are written as you go and end with "Next step"; a fresh agent continues |
| a role recorded "owner's answers" the owner never gave | only the coordinator writes decisions into a brief |
| idle waits over five minutes cost 21 % of all tokens | wait in slices of at most 270 s; the rule sits in every role prompt (21 % -> 7.4 %) |
| a resumed run of parallel tasks replayed one task's cached results into another, and both chains stopped | never `resumeFromRunId` for a multi-task run; relaunch each unfinished task alone with `start` |
| two parallel branches, each green alone, gave six red guards after the second merge | after merging the second of parallel branches over the same files: the guards of both tasks, then the full guard run |
| several container stacks at once pushed a 16 GB machine into swap | at most two chains with acceptance in Docker at once |
| a merged worktree removed after a clean `git status` held the only copy of a measurement corpus in ignored files; an old copy of the repository removed the same way broke 1809 symlinks elsewhere | before removing a worktree or a data directory, the owner says "yes" to the output of `scripts/wt-remove-check.js` (ignored data with sizes, the path in code, symbolic links that lead into it) |
| images of old test stacks (481 of them, ~130 GB) filled the disk and stopped the chains | a tester removes its own stack with `docker compose -p <stack> down -v --rmi all`; the owner's stack is never touched, other images and the build cache are not cleaned by roles |

## The bottleneck is the owner's attention

A day of fourteen tasks is about forty decisions a person has to make. Faster agents do not help until fewer questions
reach that person: rules that answer themselves, questions batched with a recommendation each, a mockup instead of a
description for anything visual, and a two-page model a human can hold in their head next to the long list the agents
read.

## What is inside

| path | what |
|---|---|
| `workflows/role-chain.js` | the chain: preconditions -> (analyst) -> programmer -> tester -> reviewer (+ security reviewer); fix rounds; an analyst after the second rejection |
| `agents/*.md` | role agents: `analyst`, `programmer`, `tester`, `reviewer`, `security-reviewer` (all may edit files - the tester its guards, the reviewers their reports; what they may change in the worktree is enforced by the git post-check, not by tool lists) |
| `skills/role-chain` | reads the project config and starts the workflow |
| `skills/brief` | how to write a task brief |
| `skills/coordinator` | the coordinator's loop |
| `rules/multi-agent.md` | the process rules; lines marked `<!-- role:<id> -->` go into every role prompt |
| `hooks/hooks.json` | PreToolUse on Bash: refuses `git add -A` / `git add .`, pushes to protected branches or of protected tags, and `git remote set-head` / writes of `git symbolic-ref refs/remotes/<remote>/HEAD` / `git update-ref` on it and `git update-ref --stdin`, in any letter case, Unicode case folding included (they move the default branch the hooks protect); an abbreviated long option (`--del`, `--mi`) counts as the option; with `--git-dir` / `--work-tree` / `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` the config is looked up from those paths too and a push is refused (use `-C`); git's global options before the subcommand are read by a table measured against git, and one outside it is refused |
| `scripts/slots.zsh`, `heavy.sh`, `medium.sh` | memory slots for heavy and medium jobs, with a FIFO queue |
| `scripts/stand.sh`, `stand.js` | the ticket of the project's shared stand (queue, holder, reset at issue and release) and its commands from the config |
| `scripts/slot-journal.js` | summary of the slot journal: queue wait and hold per class and per worktree |
| `scripts/guards-all.sh` | a full guard run of one worktree in a heavy slot, with a shared worker budget; new reds rerun alone (`guardRerun`); a run on the same HEAD with a clean tracked tree that ended with exit 0 is not repeated ("reused, HEAD <sha>" and the saved summary; `--force` runs anyway); the main working copy of a repository is refused with 78 (`--main-checkout` runs it, for a project without worktrees) |
| `scripts/main-checkout.js` | is a directory the main working copy of its repository (git-dir == git-common-dir)? 78 with the reason and `wt-setup.sh`, 0 for a linked worktree or with `--main-checkout`; `GIT_*` variables are ignored, and a git error inside a tree with `.git` above it is 78 with git's error; used by `guards-all.sh` and `env-check.js --worktree` |
| `scripts/guards-select.js` | the guards a programmer runs instead of the full suite: changed guards, guards that import a changed file or name it, `guardAlways`; `--command` fills `guardSubsetCommand` |
| `scripts/wait-step.js` | a long deterministic step (the one full guard run of a task) run detached by the workflow between role agents; `wait` blocks at most 270 s and reports JSON |
| `scripts/wt-setup.sh` | creates a task worktree and clones (not symlinks) git-ignored data into it |
| `scripts/wt-remove-check.js` | before a worktree or data directory is removed: prints its ignored data with sizes, the path named in code and the symbolic links that lead into it; removes nothing |
| `scripts/role-diff-check.js` | git post-check of the tester and reviewers |
| `scripts/role-leftovers-check.js` | post-check after the tester and at the end of a task: Docker resources of the task's stack (by the compose project label), processes in its worktree, slots they hold; `--fix` removes only those, never the owner's stack |
| `scripts/chain-cost.js` | cost of chain runs per task from the agent transcripts, and per feature (parts summed by `feature`, across runs) |
| `scripts/detect.js` | the facts of a repository for onboarding, read only, as JSON: git (default branch from origin/HEAD, main/master, tag shapes, remotes without passwords, hooksPath), GitHub workflow files, stacks by manifest, venvs, compose services (`docker compose config`, no daemon), ignored data with sizes, what an earlier onboarding left; the contract is in its header |
| `scripts/env-check.js` | free disk and swap headroom for the preconditions, floors from `preconditions` in the config; `--worktree <dir>`: the task worktree is not the main working copy |
| `scripts/git-hooks/` | `pre-push` (protected branches and tags) and `pre-commit` (cloud conflict copies, extra checks) |
| `scripts/config.js` | finds, validates and resolves the project config |
| `examples/`, `schemas/` | an example project config and its JSON schema |

## Install

From a local clone:

```sh
claude plugin marketplace add /path/to/codis-agents
claude plugin install codis-agents@codis-agents
```

After editing a local clone, run `/reload-plugins` in a session. `claude plugin validate /path/to/codis-agents` checks
the manifests.

Things that bite on first use:

- A plugin installed in the middle of a session gives its skills, workflows and agents only after a session restart.
- `scripts/wt-setup.sh` is a zsh script: run it directly (its shebang is zsh) or with `zsh`, not with `bash`, which fails
  on its zsh syntax.
- A Workflow started by `scriptPath` (for example a modified copy of the role-chain workflow) takes the script only
  from the working directory or the session's scratchpad; anything else is refused. The plugin's own workflow is
  started by name.

Requirements: Node.js 18+ and git everywhere; zsh for the slot scripts and `scripts/wt-setup.sh`. The slot locks use
zsh's own `zsystem flock` on macOS and Linux and need `ps` and `pgrep` (procps; missing - the slot scripts refuse with
exit 72); the exclusive guard lock needs `lockf(1)` (macOS) or `flock(1)` (Linux, util-linux). The memory and swap
readings come from `sysctl`, `memory_pressure`, `vm_stat` and `df` on macOS and from `/proc/meminfo`, `/proc/vmstat`
and `getconf PAGESIZE` on Linux (`SLOT_OS` and `SLOT_PROC` override the source; the Linux readings are checked on a
fake machine and in a container, not on Linux hardware). A Linux machine without swap needs `SLOT_SWAP_MIN_MB=0`, and one
with less swap than 4000 MB a lower `SLOT_SWAP_MIN_MB` (a 4 GiB swap file, 4095 MB, fits the default): with the default
threshold the slot scripts refuse at once (exit 78) and say so.
The workflow, agents, hooks and post-checks work anywhere. `wt-setup.sh` clones ignored data with an APFS clone (`cp -c`) and, where that is refused,
with `cp -r --reflink=auto` (GNU), then a plain copy. On a machine without zsh (Linux, CI) `npm test` stays green and
the zsh tests are skipped with "skipped: zsh not found" in their line and in the final tally.

## Configure a project

The plugin is opt-in per project: without `.claude/codis-agents.json` its hook does nothing. Copy
`examples/codis-agents.example.json` to `<project>/.claude/codis-agents.json` and edit it. The file is looked up in
this order: `$CODIS_AGENTS_CONFIG`; `$CLAUDE_PROJECT_DIR/.claude/`; the nearest `.claude/` above the working directory;
the main checkout of a linked worktree. Check it with:

```sh
node <plugin>/scripts/config.js check
```

| key | meaning |
|---|---|
| `repoDir` | main checkout; worktrees are created from it (`~` is expanded) |
| `worktreeRoot` | one worktree per task lives here |
| `sharedDir` | task folders `<sharedDir>/<task>/` (`BRIEF.md`, `analyst.md`, `prog.md`, `test.md`, `review.md`) and guard logs |
| `guardCommand` | the full guard run, executed with zsh in the worktree; placeholder `{wt}`, optionally `{jobs}` (the worker count of the slot budget) and `{limitFile}` (a file the runner re-reads for an adaptive worker limit). Without both (a runner that sets its own workers, e.g. `cd {wt} && pytest -q`) the run is counted as the whole budget `slots.jobsAlone` and starts only when that is free: no other heavy job. The log is `<sharedDir>/guards-<name>.txt` for a worktree directly under `worktreeRoot`, `guards-<basename>-<cksum of the path>.txt` for any other path |
| `guardCommandLegacy`, `guardAdaptiveProbe` | for branches whose runner has no adaptive limit: if `<wt>/<probe.file>` lacks `<probe.contains>`, the legacy command runs with a fixed worker count |
| `guardRerun` | rerun of new reds one by one after a red full run, in the same slot (`scripts/guards-result.js`): `command` runs one guard (`{wt}`, `{name}`), `newRedPattern` takes the names of new reds from the log (group 1), optional `tallyPattern` (no tally - a cut-off run - nothing reruns) and `maxReruns` (default 10). Red again alone - a new red, the runner's exit code stays; green alone - flaky, listed for the project backlog, not a regression; only flaky - exit 0. Without the key nothing reruns |
| `guardBaseline` | known reds of the project: path, relative to the worktree, of a JSON file `{"<guard name>": "<reason>"}` committed with the project (it changes in the same commit as the fix). Needs `guardRerun`: after a red full run the names that `newRedPattern` finds and the file lists are subtracted before `maxReruns` is counted and never rerun; only known reds - exit 0 and "N known red"; a known name not red in a finished run is named ("known red not red now: X — remove it from the baseline"); a missing or broken file is an error line and the runner's exit code stands, never "all known" in silence |
| `guardExclusive` | which guards share a machine resource and run one at a time under the exclusive lock (`heavy.sh`): `glob` (zsh patterns of the file name, matched with `extendedglob`; `config.js check` refuses one zsh cannot compile, such as `test_[.py`) and `marker` (the line-comment marker, literal), e.g. `{"glob": ["test_*.py"], "marker": "#"}` for a line `# guards:exclusive — <reason>`. Left out: `*-run.js`, `*-run.mjs` and `//`; given, both are required and replace the default |
| `guardFiles` | globs of the project's guard files for `scripts/guards-select.js` (default `*-run.js`, `*-run.mjs`, `*-run.cjs` at any depth) |
| `guardAlways` | guards always in the programmer's selection: a guard whose path contains an entry (scanners of the diff such as secrets or semgrep) |
| `guardSubsetCommand` | runs the selected guards (zsh; `{wt}`, `{onlyArgs}` = `--only <guard>` per guard). When set: one full guard run per task, run by the workflow after the programmer's last commit, and the programmer runs only the selection; without it the programmer runs the full run itself |
| `worktreeSetup` | `scan` directories whose ignored data is copied into a new worktree; `skip` and `link` globs (everything else is an APFS clone) |
| `slots` | `medium`, `heavy`, `total`, `lockDir`, `legacyLock`, `jobsAlone`, `jobsShared` |
| `reportLanguage` | language of role reports (prompts stay in English) |
| `defaultBranch` | base of new worktrees (`wt-setup.sh` without a third argument); left out, it is taken from git: where `refs/remotes/origin/HEAD` points (`git clone` sets it, `git remote set-head origin --auto` sets it again - on the owner's word: the session hook refuses `set-head` in every form writes of `symbolic-ref refs/remotes/<remote>/HEAD` and `update-ref` on it without `ALLOW_PROTECTED_PUSH=1`; only the remote `origin` is read). Not derivable: `config.js check` still passes with a note, `wt-setup.sh` without a base exits 78. `pre-push` never reads the local `origin/HEAD` (a wrapper the session hook does not see can move it): without this key and `protectedBranches` it asks the remote it pushes to, `git ls-remote --symref -- <url> HEAD` (refused when the git config rewrites that URL for a fetch to another address, `url.<base>.insteadOf`, or when the URL is also the name of a configured remote, whose settings `ls-remote` would take) |
| `protectedBranches`, `protectedTagPattern` | refused by the hook and by `pre-push` without `ALLOW_PROTECTED_PUSH=1`; `protectedBranches` defaults to `[defaultBranch]` of the repository that pushes - for `pre-push`, without either key, to the branch the remote names as its `HEAD` (asked only for a branch push); while that is unknown (for `pre-push`: the remote unreachable, timed out after 60 s or naming no `HEAD`, as an empty repository does) both hooks refuse every branch push with the reason (closed, not open; owner 2026-10-21) - a tag to a bare name after a colon too (`git push origin master:master` with a local tag `master`: git matches the bare name against the remote's refs and updates a branch there); a tag goes as `<tag>` or `<src>:refs/tags/<name>` |
| `ownerStackReadOnly` | the owner's Docker Compose project; roles only read from it |
| `medianTaskIE` | median cost of an accepted task; `chain-cost.js` flags tasks above twice this |
| `featureIELimit` | cost of a whole feature (its parts summed by the task field `feature`) above which `chain-cost.js` flags it; default 3 x `medianTaskIE` |
| `testerWritable` | regular expressions of paths the tester may change - the project's guards and fixtures, e.g. `["(^\|/)tests/test_[^/]*\\.py$", "(^\|/)tests/fixtures/"]`; no default: without it the role chain stops every task before any agent, and `role-diff-check.js --role tester` without `--allow` fails |
| `roleNotes` | project-specific lines appended to one role's prompt (`analyst`, `programmer`, `tester`, `reviewer`, `security-reviewer`) |
| `threatModel` | path (in the worktree) of the threat model the security reviewer reads |
| `standingPush` | only for the repository of process rules: `branches` its HEAD may be pushed to without `ALLOW_PROTECTED_PUSH=1`, and a `check` that must pass first; the hooks honour only the committed `standingPush` of the repository that pushes, never forced, never tags |
| `gitHooks` | `blockICloudCopies` and `preCommit` (extra shell commands) for `scripts/git-hooks/pre-commit` |
| `stand` | the project's shared stand (`scripts/stand.sh`): `project` (its compose project, never `ownerStackReadOnly`), `ports`, command templates `up`, `deploy` (must contain `{wt}`), `reset`, `status` (exit 0 only while up), `down` - placeholders `{project}`, `{port}`, `{ports}`, `{repo}`, `{wt}`, values shell-quoted, run with zsh in `cwd` (an absolute or `~` path of an existing directory; without it `repoDir`); `imageFiles` (globs of the files that define the stand's image) and `memLimitMB` (for reference). The plugin only calls the commands; what they do is the project's |
| `preconditions` | `minFreeDiskGB` (default 10: an image build or a full guard run writes several GB) and `minSwapGB` (default 4: four slots of ~1 GB) - floors of free disk on the worktree and task folder volumes and of swap headroom, checked by `scripts/env-check.js` before a task starts |

Recommended in the project's `CLAUDE.md`, so the coordinator session follows the rules:

```markdown
@/path/to/codis-agents/rules/multi-agent.md
```

Git hooks for all worktrees of the project (optional; the Claude Code hook covers agents, these cover everyone):

```sh
git -C <repo> config core.hooksPath /path/to/codis-agents/scripts/git-hooks
```

`core.hooksPath` holds one directory, so the plugin's `pre-commit` runs the project's own checks for it: list them in
`gitHooks.preCommit`. Each entry is a shell command run in the repository root; a non-zero exit refuses the commit and
its output is shown. Keep project-specific checks (a bundle that must match its sources, a secrets scanner) in the
project, for example in its `.githooks/`, and call them from there:

```json
"gitHooks": {
  "blockICloudCopies": true,
  "preCommit": ["node .githooks/pre-commit.js"]
}
```

If the project keeps its own hooks directory as `core.hooksPath` instead, call the plugin from it:
`node /path/to/codis-agents/scripts/git-hooks/pre-commit.js` in its `pre-commit`, and pipe stdin to
`/path/to/codis-agents/scripts/git-hooks/pre-push "$@"` in its `pre-push`.

## Run a chain

1. Write a brief: `<sharedDir>/<task>/BRIEF.md` with the owner's words verbatim and dated, the scope, and the
   acceptance as a scenario in the real environment (skill `codis-agents:brief`).
2. Create the worktree: `<plugin>/scripts/wt-setup.sh <name> <branch> [base]` (base: the default branch when left out).
3. Ask Claude to run the role chain on the task (skill `codis-agents:role-chain`). The skill resolves the config and
   starts the workflow:

```js
Workflow({ name: "codis-agents:role-chain", args: {
  owner: "<the owner's request, verbatim>",
  config: /* output of: node <plugin>/scripts/config.js json */,
  tasks: [{ key: "q2", title: "Queue retries", wt: "q2", branch: "b-q2", analystFirst: true,
            accept: "Add -> the item builds with no tab open; log and screenshot attached" }]
} })
```

Every task carries exactly one of `analystFirst`, `analysis`, `noAnalysis`: `analystFirst: true` runs the analyst
first; `analysis: "<path>"` reuses an existing analyst or diagnosis report (checked by the preconditions, named in the
programmer prompt); `noAnalysis: "<reason>"` says why none is needed (for a defect, why the diagnosis is skipped). With
none or several the task stops before any agent. The result carries `analysis: {mode: run|reused|none, path?, reason?}`.
A feature gets its own analysis: `analysis` must lie in the task's folder or in the folder of its `feature`, and the arc
specification goes into `spec` (context for every role), never into `analysis`.
Optional task fields: `dir`, `gdir`, `start`, `feature` (the feature this task was split from), `spec` (the arc
specification), `useCases` (the feature's `use-cases.md`: actor, trigger, main and alternative flows, errors, out of
scope - context for every role, cited by the matrix, the tester's acceptance follows its flows), `useCasesFirst`,
`stack` (the tester's own compose project), `security`, `base` (the branch or commit the task started from, for
`guards-select.js`), `mode` (`mode: "light"` for a small task: one programmer-checker, the full run, one reviewer - see
below). For a feature, `useCasesFirst: true` with `analystFirst` has the
analyst write only the use cases with their open questions and stops the task with status `use-cases-review`; after
the review with the owner the coordinator relaunches it with `useCases` and `analystFirst`.
Each task ends `done`, `use-cases-review` or `stopped` with the reason, the open questions, a proposed split or the
review findings.

## How the chain decides

- **Preconditions** first: a brief with an acceptance scenario, the worktree on its branch, no uncommitted changes, no
  unanswered question that acceptance depends on, free disk and swap headroom above the floors of `preconditions`
  (`scripts/env-check.js`). Otherwise it stops before any code.
- **Analyst** before the programmer when the task is marked `analystFirst`; a proposal to split stops the chain. With
  `analysis` the phase logs the reused report, with `noAnalysis` the reason. With `useCasesFirst` it writes only the
  use cases and the task stops for the owner's review.
- **Programmer** commits a red guard, then the code, then mutation-tests the guards after the commit and runs the full
  guard suite in a heavy slot - or, with `guardSubsetCommand` in the config, only its new guards and the guards that
  import a changed file or name it, plus `guardAlways` (`scripts/guards-select.js`).
- **One full guard run per task, run by the workflow after the programmer's last commit** (with `guardSubsetCommand`):
  a cheap agent starts `guards-all.sh` through `scripts/wait-step.js` and waits in slices of at most 270 s; red goes back
  to the programmer with its log (at most two rounds, then the coordinator), green goes to the tester, who reuses the
  log. A HEAD whose full run is done, or a fix of docs and guards only, is not run again. A step without an exit code
  stops the task for the coordinator; a red run is a step that ran.
- **Light mode** (`mode: "light"`, chosen by the coordinator for up to ~100 lines of product in one subsystem, off the
  attack surface, without a Docker acceptance): one programmer-checker (red guard, code, mutations, its own acceptance
  with evidence in `test.md`) -> the one full run -> one reviewer; no tester role. A second rejection stops the task for
  the coordinator with the proposal to relaunch it in the full mode.
- **Tester** builds its own inventory, adds and mutation-tests guards, runs the acceptance scenario for real. Red goes
  straight back to the programmer (up to three rounds), without a review. A red from the environment (a cut-off full
  run, no slot, disk or swap exhausted, Docker down) is the verdict `environment`: the task stops with its cause for the
  coordinator, not for a programmer.
- **Reviewer** reads only and tries to refute. With `security: true` a security reviewer follows; done needs both.
- **Rejection**: a fix round, then a second review. A rejection only for docs, guard wording or comments skips the
  tester: the second review reads the diff of the fix; when the fix touches files outside docs and guards, that review
  confirms it changes no behaviour (`fixBehaviourUnchanged`), and only an unconfirmed fix gets a tester round. A second rejection for code brings the analyst into the same run for one more round; after that the
  coordinator decides.
- **Post-checks**: after the tester and each reviewer, `role-diff-check.js` compares the worktree with the previous
  role's HEAD; any change a role may not make stops the chain. This, not a tool list, keeps product code out of their
  reach: a hook on Edit/Write would miss `sed -i`, `python -c`, a heredoc or a `git checkout`, while the post-check
  sees the result. The tester may change only paths matching `testerWritable` (guards and fixtures); the reviewers
  nothing in the worktree (their reports live in `sharedDir`).
- **Leftovers**: after the tester and at the end of the task, `role-leftovers-check.js --fix` removes what the task left
  running - containers, networks, volumes and images labelled with its compose project (`stack`), processes whose cwd
  or argv lies in its worktree, the memory slots they hold - and names them in the result and in `<task>/leftovers.md`.
  It never touches the owner's stack (`ownerStackReadOnly`) or another task; what it cannot remove stops the task.
- A failed post-check (ok=false or no result) is repeated once by the default model (label `...#retry`, logged) and the
  second answer decides: the cheap agent that runs it sometimes answers without running the script, and the scripts
  are deterministic, so a real violation or real leftovers still stop the task.
- Every role prompt carries the marked rules of `rules/multi-agent.md`: wait at most 270 s at a time, hand over past
  ~200k of context, open questions go to the coordinator, living specs change with the behaviour, stage by path,
  never push.

## Memory slots

Heavy work runs through `scripts/heavy.sh <cmd>` and `scripts/medium.sh <cmd>` (or `guards-all.sh <worktree>`):

- **medium** (tsc, one bundler build without a browser): `slots.medium` slots (2);
- **heavy** (browsers, full guard runs, image builds): `slots.heavy` slots (2), one more only while the minimum free
  memory over a 5-minute window stays at 50 % or more and swap does not grow;
- medium + heavy together at most `slots.total` (4); no slot at all while swap capacity is under 4000 MB
  (`SLOT_SWAP_MIN_MB`; 0 switches the swap check off);
- waiters queue in arrival order; a full guard run first in the queue is never starved by single jobs;
- all full guard runs together use at most `slots.jobsAlone` workers (6), `slots.jobsShared` (3) next to another
  heavy job, re-evaluated during the run for runners that read `{limitFile}`.

The thresholds are measurements from a 16 GB machine; every one can be overridden from the environment (see the top of
`scripts/slots.zsh`).

| quantity | macOS | Linux (proc(5)) |
|---|---|---|
| swap capacity | `vm.swapusage` free + free space of `/System/Volumes/VM` | `SwapFree` of `/proc/meminfo` |
| swap used | `vm.swapusage` used | `SwapTotal - SwapFree` |
| free memory (extra heavy slot) | `memory_pressure` free percentage | `MemAvailable / MemTotal` |
| swapped out | `vm_stat` Swapouts x page size | `pswpout` of `/proc/vmstat` x `getconf PAGESIZE` |

On Linux the extra heavy slot is off unless `SLOT_THIRD_FREE_PCT` is set explicitly (the 50 % was measured with
`memory_pressure`, and `MemAvailable` is a different measure). A swap smaller than the threshold
(`SwapTotal / 1024 < SLOT_SWAP_MIN_MB`, no swap at all included) is a refusal at once with the numbers (exit 78), not an
endless wait: `SwapFree` never exceeds `SwapTotal`, and Linux swap does not grow by itself. A 4 GiB swap file shows
`SwapTotal 4194300 kB` = 4095 MB (the header page), so the default is 4000, not 4096 (owner 2026-10-21): such a
swap gets the slot. The refusal names the value of `SLOT_SWAP_MIN_MB` that fits. A swap at least the threshold but filled up is a wait, as on macOS. A reading that cannot be taken (an
unreadable source, an unknown OS) gives one line "swap not measured (...) - not checked" and the slot; the extra heavy
slot is then refused as "memory not measured". Inside a container `/proc/meminfo` shows the memory of the host.

A slot is held by a small zsh that takes `zsystem flock` (an fcntl lock) on the slot file, runs the command as its child
and exits with its code: when the holder dies (even `kill -9`) the kernel drops the lock, and a command it leaves
behind does not hold the slot. The holder never opens its own slot file after taking the lock (closing any descriptor
of the file would drop an fcntl lock), so the command is never exec-ed in its place. The exclusive lock of guards
marked `guards:exclusive` (`<slots.lockDir>/exclusive.lock`) is a `flock(2)` lock by contract, because the project's
guard runner takes the same file with `lockf(1)` or `flock(1)` and on Linux the two lock types do not see each other:
the slot scripts take it with the first executable of `SLOT_EXCL_TOOLS` (default `/usr/bin/lockf /usr/bin/flock
/bin/flock`); with none, a guard marked exclusive is refused (exit 72). Every lock of the slot directory must be
writable for the user: `zsystem flock` opens the file for writing and a failed open looks like "busy", so a slot file,
`admit.lock`, `queue.lock` or the directory left unwritable (by `sudo heavy.sh`, or by root in a container over a shared
slot directory) is a refusal with one line naming the path (exit 77), never an endless wait.

Every slot hold appends one line to the slot journal, `<slots.lockDir>/journal.tsv` (`SLOT_JOURNAL` overrides it, empty
turns it off): request, acquire and release times, class, slot, kind, pid, exit code, worktree and a short command with
`name=value` words masked. A failed write is ignored and never stops a slot. `node scripts/slot-journal.js [--since 2d]
[--until <time>] [--json]` sums it up: queue wait (acquire - request) and hold (release - acquire), total and median,
per class and per worktree, and the share of the queue in the agents' waiting.

## Shared stand

A project can keep one Docker stand for acceptance (config `stand`) instead of a stack per task: testers take it in
turn by ticket. `scripts/stand.sh`:

- `take` waits in the queue (FIFO, "waiting for the stand ticket <project>, position N in queue" at least every
  `SLOT_SAY` s) and then holds the ticket for as long as it runs: start it in the background; the line
  `ticket taken by <worktree>` says it is yours. Refused while the stand is not up (its `status` fails); the project's
  `reset` runs before the ticket is given.
- `deploy [<wt>]` runs the project's deploy of the holder's worktree in a medium slot; `reset` - the project's reset;
  `release` - reset while still held, then free. For another worktree than the holder's all three are refused
  ("the ticket is held by <wt>"); `release --force` is the coordinator's and is journaled.
- `status` - the stand, the holder with its worktree, pid and hold time, the queue; `up` / `down` - the coordinator's.
- `image-diff --base <ref>` - do the worktree's commits since `<ref>` touch `imageFiles` (exit 1: the task builds its
  own stack).

The project's commands run with zsh in `stand.cwd` when it is set (an absolute or `~` path; `config.js check` refuses
one that is not an existing directory), else in `repoDir` (owner 2026-10-21). With `cwd` the commands can name
paths relative to one checkout, so a branch and the main checkout can carry the same config.

The ticket is a lock held by the take process itself: if it dies (even `kill -9`) the ticket is free and the next
holder gets a reset first; the leftovers post-check stops a holder left in the task's worktree. There is no idle limit
(a limit without data would be a guess); hold times are in `status` and in the slot journal (class `stand`). The stand
holds no memory slot: its memory is its own fixed ceiling.

An invalid project config is a refusal for every slot and stand script (exit 78 with the errors), never a silent
fallback to another slot directory: a second directory would be a second queue that the first one does not see.

## Known gaps

- The session hook reads the command line as written: wrappers and indirection (`bash -c 'git push ...'`,
  `command git push`, `builtin`, `exec`, `eval`, `env` with options such as `env -i` / `env -u NAME`, `$G` or `G=git; $G`
  in the place of the command, an alias such as `git -c alias.p=push p` or `git -c alias.x=symbolic-ref x ...`, aliases
  and functions of the user's shell profile) pass it. For a push the git `pre-push` hook of the target repository is a
  second layer, but only while it runs (`git push --no-verify` and `git -c core.hooksPath=...` turn it off, and the
  session hook does not refuse them) and only for the branch it knows: `git remote set-head`, `git symbolic-ref` and
  `git update-ref` have no second layer of their own; once a wrapper has moved `refs/remotes/origin/HEAD`, the session
  hook protects the branch it now points to, while `pre-push` does not read it: it takes the default branch from the
  config or from the remote (`git ls-remote --symref -- <url> HEAD`) and refuses every branch push when neither answers
  (p-head2). When the git config rewrites the pushed URL for a fetch (`url.<base>.insteadOf`, which `ls-remote`
  follows while a push follows `pushInsteadOf` first), `git ls-remote --get-url -- <url>` shows another address and
  `pre-push` refuses every branch push with the reason instead of asking that address; likewise when the pushed URL
  is also the name of a configured remote (any `remote.<url>.*` key: `ls-remote` would take its `uploadpack` or `vcs`,
  which a push to the URL does not; this check runs first, so the reason is the same on git 2.43 and 2.50), and an
  empty URL is refused before any git call. The checks and the query are separate git calls: a process that changes the git config between them is not seen. Wrappers: their own task (owner
  2026-10-21).
- Git config that itself runs a command is the same class of indirection and passes the session hook: `git -c
  core.fsmonitor='git remote set-head origin feat; true' status` moves `refs/remotes/origin/HEAD` (measured with git
  2.50, a project with a config, no tty); likewise `-c core.sshCommand=...`, `-c diff.external=...`, `-c core.pager=...`
  and `GIT_PAGER`, `-c man.<tool>.cmd=...` with `--help`, and config passed through the environment
  (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`, `GIT_CONFIG_PARAMETERS`). Open; to be closed with
  the wrappers in their own task (owner 2026-10-21).
- The session hook splits a line by its own small lexer, not by the grammar of the shell (zsh on macOS, bash in
  Linux), and a git command it does not see as one passes. Open forms (measured with git 2.50, zsh and bash): a leading
  reserved word or modifier (`{ git ...; }`, `! git`, `time [-p] git`, `if ...; then git`, `do git`, zsh `repeat 1 git`,
  `noglob git`, `nocorrect git`, `{git ...}`); a redirection before or between the words (`2>/dev/null git ...`,
  `2> /dev/null git`, `&>/dev/null git`, `git 2>/dev/null remote set-head ...`); a line continuation (backslash and
  newline); `$'...'` with escapes (`$'\x73et-head'`) and `$"..."`; backquotes (`` echo `git ...` ``); an expansion in
  the subcommand or its arguments (`$X`, `${X:-set-head}`, `$(printf set-head)`, `git $(echo remote) ...`). To be closed
  in task p-shell (owner 2026-10-21: after p-head2), which refuses an expansion in `git remote`, `git symbolic-ref` and
  `git update-ref`. A push with an expansion (`git push origin "$BRANCH"`, `git push origin HEAD:$B`) stays allowed
  (owner 2026-10-21): `pre-push`, while it runs, is its layer.
- Global options of git before the subcommand are read by a table measured against git (`GIT_GLOBAL` in
  `scripts/hooks/guard-bash.js`, checked by `tests/hooks-sec-globals.test.js` against the git it runs on); in a
  project with a config an option outside the table is refused. A git that adds a global option with a value needs a
  new row; until then the hook refuses it (fail closed), it does not misread it.
  From a directory without a project config the unknown option is not refused, even when `-C` then points into a
  project: `git --newopt -C <project> remote set-head ...` passes the session hook (open; `pre-push` stays the layer
  for pushes).
- `git branch -dr origin/HEAD` deletes `refs/remotes/origin/HEAD` and the session hook does not judge it; with no
  `defaultBranch` / `protectedBranches` the session hook then refuses every branch push (closed, not open), until the
  owner sets it again; `pre-push` still asks the remote.
- Other ways to move `refs/remotes/origin/HEAD` that the session hook does not judge: `git remote rename` (the HEAD of
  the renamed remote becomes `origin/HEAD`), `git fetch` with `remote.origin.followRemoteHEAD` (git 2.48+), writing the
  ref file under `.git/refs/remotes/` directly. They mislead only the session hook (`pre-push` asks the remote); open,
  for the coordinator's backlog.
- `pre-push` asks the remote at the URL git hands it, from the top of the worktree; a relative URL that does not resolve
  from there is unreachable to it and every branch push is refused (closed);
  `defaultBranch` / `protectedBranches` in the config push without the remote's answer.
- With the protected branches known, a partly qualified destination such as `git push origin HEAD:heads/main` is taken
  by the session hook as the bare name `heads/main`, while git updates `refs/heads/main`; only `pre-push` (while it
  runs) refuses it. Open, for the coordinator's backlog.
- With the protected branches known, glob refspecs (`'refs/heads/*:refs/heads/*'`, `'refs/tags/*:refs/tags/*'`) and
  the matching refspec `:` name no branch or tag the session hook can check, so it lets them through; `pre-push` (while it runs) judges
  every ref they expand to (owner 2026-10-21: backlog).

## Tests

```sh
npm test            # or: node tests/run.js [filter]
```

The suite checks the chain logic with fake agents (every routing case, the post-checks, the rule markers against
`RULE_LIST` and every role prompt), the post-check and cost scripts, the config, the hooks, the worktree setup, the
slots on a fake macOS and a fake Linux machine (classes, the extra slot, swap, queue order, worker budget, the slot
journal and its summary),
the stand ticket on fake project commands, `detect.js` on fixture repositories built from
`tests/fixtures/repos/` against their expected output, that the repository holds no
Cyrillic text, home paths or e-mail addresses, and that a run without zsh skips the zsh tests visibly instead of failing.

## License

MIT
