---
name: brief
description: Write or update a BRIEF.md for a codis-agents task - the owner's words verbatim, scope, the acceptance scenario in the real environment, the matrix or split, open questions. Use when the owner asks to prepare, write or update a brief, or before starting the role chain on a new task.
---

# Write a task brief

A brief is the one document every role reads. It lives at `<sharedDir>/<task>/BRIEF.md` (`sharedDir` from
`.claude/codis-agents.json`; `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.js" get sharedDir`). Only the coordinator
writes it.

## Template

```markdown
# <task> - <one line: what changes for the owner>
Owner <date>, verbatim: "<the owner's words>".

## Where
Worktree <worktreeRoot>/<name>, branch <branch> from <base>. Sources to read: <files, docs, earlier reports>.

## Requirements
1. ...
Matrix of cases (if more than one dimension): states x events x environments, each cell with expected result and basis.

## Not in the task
- ... (neighbouring work the roles must refuse)

## Acceptance (a scenario in the real environment)
"<owner action> -> <observable result>", where it runs (browser, image, device) and what evidence the tester attaches.

## Open questions
- ❓ <question for the owner> (acceptance depends on it: yes/no)
```

## Rules

- The owner's decisions go in verbatim, with the date, in the same turn they are given, before the next action.
  Roles never write them; a role's question arrives as "❓ coordinator: ..." in its report.
- Acceptance is a scenario, not a feature name. The reviewer checks the scenario, not the wording.
- Split before the first programmer if the matrix has more than ~30 cells, spans more than two subsystems, depends on
  an unanswered question, or lifts an "inactive while ..." restriction. For a defect, set the analyst first. The chain
  task carries exactly one of `analystFirst`, `analysis` (the path of an analysis it reuses) or `noAnalysis` (a written
  reason; for a defect, why the diagnosis is skipped).
- Mark security work (accounts, login, connectors, OAuth, access passes, host rollout) so the chain adds the security
  reviewer (`security: true`).
- When several branches run in parallel, hand out ranges of any shared numbering (issue ids, version notes) in their
  briefs so they do not collide.
- Create the worktree with `${CLAUDE_PLUGIN_ROOT}/scripts/wt-setup.sh <name> <branch> [base]`: it clones ignored data
  instead of symlinking it.
