export const meta = {
  name: 'role-chain',
  description: 'Role chain over tasks in parallel: preconditions -> (analyst) -> programmer -> tester -> reviewer (+ security reviewer); fix rounds and an analyst after the second rejection',
  whenToUse: 'Started by the codis-agents:role-chain skill, which reads .claude/codis-agents.json and passes it. args: {owner: "the owner\'s request, verbatim", config: <resolved project config>, tasks: [{key, title, wt, branch, accept, dir?, gdir?, start?, analystFirst?, stack?, security?}]}',
  phases: [
    { title: 'Preconditions', detail: 'brief, worktree, branch, open questions' },
    { title: 'Analyst', detail: 'matrix of cases or a diagnosis (before the programmer, or after the second rejection)' },
    { title: 'Programmer', detail: 'red guard -> code -> mutations -> full guard run' },
    { title: 'Tester', detail: 'independent inventory, own guards, acceptance in the real environment' },
    { title: 'Reviewer', detail: 'read only, tries to refute' },
  ],
}

// The chain module (rules/multi-agent.md). Verdicts come only through schemas, never from regular expressions over
// text (four runs once ended with an empty result that way).
// The script reads no files: the project config and the owner's words arrive in args.
// Task fields: key, title, wt (worktree path, or a name under config.worktreeRoot), branch, accept (the acceptance
// scenario for the tester), dir (task folder, default <sharedDir>/<key>), gdir (argument of guards-all.sh, default wt),
// start (what is new for the first programmer), analystFirst, stack (the tester's docker compose project),
// security (the brief marks the task as security work - a security reviewer joins the review).

const ARGS = typeof args === 'string' ? JSON.parse(args) : (args || {})
const OWNER = ARGS.owner || ''
const CFG = ARGS.config || {}
const TASKS_IN = ARGS.tasks || []
if (!TASKS_IN.length) throw new Error('role-chain: args.tasks is empty')
for (const k of ['sharedDir', 'worktreeRoot', 'scriptsDir']) {
  if (!CFG[k]) throw new Error(`role-chain: args.config.${k} is missing - start the chain through the codis-agents:role-chain skill`)
}
const SCRIPTS = CFG.scriptsDir
const LANG = CFG.reportLanguage || 'English'
const NOTES = CFG.roleNotes || {}
const PROTECTED = (CFG.protectedBranches || ['main']).join(', ')
const PREFIX = ARGS.agentTypePrefix === undefined ? 'codis-agents:' : ARGS.agentTypePrefix
const roleType = (role) => (PREFIX ? PREFIX + role : 'general-purpose')
const abs = (p) => (p.startsWith('/') ? p : `${CFG.worktreeRoot}/${p}`)
const TASKS = TASKS_IN.map((t) => Object.assign({}, t, {
  dir: t.dir || `${CFG.sharedDir}/${t.key}`, wt: abs(t.wt), gdir: t.gdir || t.wt,
}))
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// Rules that reach a role only through its prompt (rules/multi-agent.md: the pause and 200k rules worked once they
// were in the prompt). The id matches the marker <!-- role:<id> --> of a line in rules/multi-agent.md; local-* exist
// only in the chain. tests/role-chain.test.js fails when a marked line has no rule or a role prompt lacks one.
const RULE_LIST = (t) => [
  ['local-task', `Task "${t.title}". Brief: ${t.dir}/BRIEF.md (read all of it and the sections it refers to). Worktree ${t.wt}, branch ${t.branch}.`],
  ['scope', `The owner asked: "${OWNER}". Do only the task "${t.title}"; refuse neighbouring tasks and do not touch other worktrees.`],
  ['decisions', 'Only the coordinator writes the owner\'s decisions. An open question goes into your own report as a line "❓ coordinator: ..."; do not decide it yourself.'],
  ['pauses', 'Pauses: never wait longer than 270 s at a time - run anything long through Bash run_in_background and wait with Monitor in slices; an agent with no output for 10 minutes is killed.'],
  ['context', 'Context: past ~200k finish the current stage, write the report with "Next step: ..." and stop - a fresh agent continues.'],
  ['slots', `Heavy work goes through memory slots: ${SCRIPTS}/heavy.sh <cmd>, ${SCRIPTS}/medium.sh <cmd>, full guard run ${SCRIPTS}/guards-all.sh ${t.gdir}.`],
  ['docker', `Docker: ${CFG.ownerStackReadOnly ? `the owner's stack ${CFG.ownerStackReadOnly}` : 'the owner\'s stack'} is read-only (docker cp out is fine); never write into its containers; only a tester runs its own stack, and only when the brief asks.`],
  ['specs', 'Living specs (UX specs, state models, gap lists) change in the same commit as the behaviour they describe.'],
  ['push', `Do not push, do not merge into ${PROTECTED}, do not create tags.`],
  ['gitadd', 'git add only by path (never -A or .): synced folders spawn conflict copies "name 2.ext".'],
  ['report', `Write your role report as you go, in the task folder, in ${LANG}; if it already exists, continue from it and git log, not from scratch. Its last line is "Next step: ...".`],
]
const RULES = (t) => RULE_LIST(t).map((r) => r[1]).join('\n')
const note = (role) => (NOTES[role] ? `\nProject notes: ${NOTES[role]}` : '')

const PRE_SCHEMA = { type: 'object', properties: {
  ok: { type: 'boolean' },
  problems: { type: 'array', items: { type: 'string' } },
  blockingQuestions: { type: 'array', items: { type: 'string' }, description: 'questions to the owner in the brief, unanswered, on which acceptance depends' },
}, required: ['ok', 'problems', 'blockingQuestions'] }
const ANALYST_SCHEMA = { type: 'object', properties: {
  ready: { type: 'boolean', description: 'the matrix or diagnosis is ready and the programmer can start' },
  cells: { type: 'number' }, subsystems: { type: 'number' },
  split: { type: 'array', items: { type: 'string' }, description: 'if the task must be split (rules: "Split the task") - the proposed subtasks' },
  questions: { type: 'array', items: { type: 'string' } },
  summary: { type: 'string' },
}, required: ['ready', 'cells', 'subsystems', 'split', 'questions', 'summary'] }
const PROG_SCHEMA = { type: 'object', properties: {
  status: { type: 'string', enum: ['ready', 'blocked'], description: 'blocked - an answer of the coordinator or owner is needed' },
  changedFiles: { type: 'array', items: { type: 'string' }, description: 'paths changed in this round (git diff --name-only from the start of the round)' },
  commits: { type: 'array', items: { type: 'string' } },
  head: { type: 'string', description: 'git rev-parse HEAD of the worktree after your commits' },
  mutations: { type: 'string', description: 'table: mutant -> guard result -> after checkout' },
  fullRun: { type: 'string', description: 'result of the full guard run: N green, N new red, N known red' },
  questions: { type: 'array', items: { type: 'string' } },
  summary: { type: 'string' },
}, required: ['status', 'changedFiles', 'commits', 'head', 'mutations', 'fullRun', 'questions', 'summary'] }
const TEST_SCHEMA = { type: 'object', properties: {
  verdict: { type: 'string', enum: ['green', 'red'] },
  head: { type: 'string', description: 'git rev-parse HEAD of the worktree after your commits' },
  summary: { type: 'string', description: 'acceptance numbers per profile/environment, own guards and mutations, red with file:line' },
}, required: ['verdict', 'head', 'summary'] }
const DIFF_SCHEMA = { type: 'object', properties: {
  ok: { type: 'boolean' }, offending: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
}, required: ['ok', 'offending'] }
const REVIEW_SCHEMA = { type: 'object', properties: {
  verdict: { type: 'string', enum: ['done', 'rejected'] },
  docsOnly: { type: 'boolean', description: 'rejected only for docs, guard wording, comments' },
  summary: { type: 'string', description: 'findings with file:line' },
}, required: ['verdict', 'docsOnly', 'summary'] }

// Post-check of a role by git (not a hook: a hook cannot see python -c, a heredoc, a checkout).
const ALLOW = (CFG.testerWritable || []).map((r) => ` --allow ${sq(r)}`).join('')
const diffCheck = (t, role, since) => agent(`Run one command and return its JSON output as the schema fields (change nothing, analyse nothing):
node ${SCRIPTS}/role-diff-check.js --wt ${t.wt} --since ${since} --role ${role}${role === 'tester' ? ALLOW : ''}
If the command fails without JSON - ok=false, error = the error text.`,
  { label: `diff:${t.key}:${role}`, phase: role === 'tester' ? 'Tester' : 'Reviewer', schema: DIFF_SCHEMA, effort: 'low', model: 'haiku', agentType: 'general-purpose' })
const diffFail = (role, d) => !d ? `the ${role} post-check returned no result`
  : !d.ok ? `the ${role} changed what the role may not: ${(d.offending || []).join(', ') || d.error || '?'}` : ''

const DOCS_PATH = /(\.md$)|(^|\/)docs\//
const stop = (t, why, extra) => Object.assign({ task: t.key, status: 'stopped', why }, extra || {})

const pre = (t) => agent(`You check PRECONDITIONS (read only, change nothing). ${RULES(t)}
Check: ${t.dir}/BRIEF.md exists and contains an acceptance scenario in the real environment; ${t.wt} exists and is on branch ${t.branch}; there are no uncommitted changes (except untracked build output or probes); the brief has no unanswered questions to the owner on which acceptance depends. ok=false if any of this fails.`,
  { label: `pre:${t.key}`, phase: 'Preconditions', schema: PRE_SCHEMA, effort: 'low', agentType: 'general-purpose' })

const analyst = (t, why) => agent(`You are the ANALYST/DIAGNOSER (read code only; you write only ${t.dir}/analyst.md). ${RULES(t)}
Reason: ${why}
Write a matrix of cases (every dimension: states x events x environments) or find the cause of the defect with file:line. Count the cells and subsystems. If by the rule "Split the task" the task must be split, propose subtasks and do not declare ready. Every cell has an expected result and a basis (the brief, documentation, an experiment); no thresholds or name lists.${note('analyst')}`,
  { label: `analyst:${t.key}`, phase: 'Analyst', schema: ANALYST_SCHEMA, agentType: roleType('analyst') })

const prog = (t, task, n) => agent(`You are the PROGRAMMER. ${RULES(t)} Report: ${t.dir}/prog.md (round ${n}).
${task}
Order: red guard -> commit -> code -> commit -> mutations AFTER the commit (table in prog.md) -> full run ${SCRIPTS}/guards-all.sh ${t.gdir} in the background -> analysis of new reds. status=blocked if you cannot go on without the owner's answer.${note('programmer')}`,
  { label: `prog:${t.key}#${n}`, phase: 'Programmer', schema: PROG_SCHEMA, agentType: roleType('programmer') })

const test = (t, n) => agent(`You are the TESTER. You do not change product code. ${RULES(t)} Report: ${t.dir}/test.md (round ${n}; keep earlier rounds).
1. An independent inventory before reading the diff (inputs, places, cells) - compare it with the programmer's coverage.
2. Your own guards for what is not covered -> commit -> mutations after the commit.
3. Acceptance in the real environment: ${t.accept}${t.stack ? ` Your own stack: docker compose -p ${t.stack}, tear it down afterwards.` : ''} Evidence (logs, numbers, screenshots) goes into ${t.dir} with the prefix test-.
4. Do not repeat the programmer's full run: new and touched guards and mutations; a full run only after your own commits.
green - only if the brief's acceptance is met in full.${note('tester')}`,
  { label: `test:${t.key}#${n}`, phase: 'Tester', schema: TEST_SCHEMA, agentType: roleType('tester') })

const review = (t, n, scope) => agent(`You are the REVIEWER (read only; you may rerun guards). ${RULES(t)} Report: ${t.dir}/review.md (round ${n}).
Read BRIEF.md, analyst.md (if any), prog.md, test.md, git log/diff of branch ${t.branch} for the task${scope ? ' - ' + scope : ''}. Try to refute "done": cells of the matrix, guesses instead of data (thresholds, name lists), guards without mutations, the tester's evidence against the acceptance scenario (do not rerun the scenario). Verdict with file:line.${note('reviewer')}`,
  { label: `review:${t.key}#${n}`, phase: 'Reviewer', schema: REVIEW_SCHEMA, agentType: roleType('reviewer') })

const secReview = (t, n, scope) => agent(`You are the SECURITY REVIEWER (read only; you may rerun guards). ${RULES(t)} Report: ${t.dir}/review-sec.md (round ${n}).
The brief marks the task as security work. Read BRIEF.md, ${CFG.threatModel ? `the threat model ${t.wt}/${CFG.threatModel}, ` : ''}git diff of branch ${t.branch} for the task${scope ? ' - ' + scope : ''}, test.md. Look with an attacker's eyes: access by a guest and by another owner, swapped ids, malformed input, secrets (model keys, passes) leaking into responses, logs, postMessage, UI; does the tester have refusal guards for every input, and are they mutation-tested. Verdict with file:line; docsOnly - only if the findings concern docs alone.${note('security-reviewer')}`,
  { label: `sec:${t.key}#${n}`, phase: 'Reviewer', schema: REVIEW_SCHEMA, agentType: roleType('security-reviewer') })

// Programmer -> tester (red -> programmer again, without review), up to maxRounds tester rounds.
// st.head - HEAD after the last committing role; the next role's post-check starts from it.
async function testChecked(t, st, n) {
  const tr = await test(t, n)
  if (!tr) return { fail: 'the tester returned no result' }
  const f = diffFail('tester', await diffCheck(t, 'tester', st.head))
  if (f) return { fail: f }
  st.head = tr.head
  return { tr }
}
// With t.security the review is reviewer + security reviewer; done only if both are done.
async function reviewChecked(t, st, n, scope) {
  const rv = await review(t, n, scope)
  if (!rv) return { fail: 'the reviewer returned no result' }
  const f = diffFail('reviewer', await diffCheck(t, 'reviewer', st.head))
  if (f) return { fail: f }
  if (!t.security) return { rv }
  const sv = await secReview(t, n, scope)
  if (!sv) return { fail: 'the security reviewer returned no result' }
  const fs = diffFail('security reviewer', await diffCheck(t, 'reviewer', st.head))
  if (fs) return { fail: fs }
  const bad = [rv, sv].filter((v) => v.verdict !== 'done')
  return { rv: {
    verdict: bad.length ? 'rejected' : 'done',
    docsOnly: bad.length > 0 && bad.every((v) => v.docsOnly),
    summary: `Reviewer (${rv.verdict}): ${rv.summary}\nSecurity (${sv.verdict}, ${t.dir}/review-sec.md): ${sv.summary}`,
  } }
}

async function buildAndTest(t, st, firstTask, tag, maxRounds) {
  let p = await prog(t, firstTask, `${tag}1`)
  if (!p) return { fail: 'the programmer returned no result' }
  if (p.status === 'blocked') return { fail: 'programmer: an answer is needed', questions: p.questions }
  st.head = p.head
  for (let r = 1; r <= maxRounds; r++) {
    const x = await testChecked(t, st, `${tag}${r}`)
    if (x.fail) return x
    const tr = x.tr
    log(`${t.title}: tester ${tag}${r} - ${tr.verdict}`)
    if (tr.verdict === 'green') return { ok: tr }
    if (r === maxRounds) return { fail: `${maxRounds} red tester rounds`, test: tr.summary }
    p = await prog(t, `Tester round ${tag}${r} - red. Fix according to ${t.dir}/test.md:\n${tr.summary}`, `${tag}${r + 1}`)
    if (!p) return { fail: 'the programmer returned no result' }
    if (p.status === 'blocked') return { fail: 'programmer: an answer is needed', questions: p.questions }
    st.head = p.head
  }
}

// Review; rejection -> fix; rejection for docs only (confirmed by the changed paths) -> second review of that diff only,
// otherwise tester and second review.
async function reviewLoop(t, st, tag) {
  const x1 = await reviewChecked(t, st, `${tag}1`)
  if (x1.fail) return x1
  const r1 = x1.rv
  log(`${t.title}: review ${tag}1 - ${r1.verdict}`)
  if (r1.verdict === 'done') return { ok: r1 }
  const p = await prog(t, `Review ${tag}1 - rejected. Fix according to ${t.dir}/review.md:\n${r1.summary}`, `${tag}r`)
  if (!p) return { fail: 'the programmer returned no result' }
  if (p.status === 'blocked') return { fail: 'programmer: an answer is needed', questions: p.questions }
  st.head = p.head
  const docsOnly = r1.docsOnly && p.changedFiles.length > 0 && p.changedFiles.every((f) => DOCS_PATH.test(f))
  if (r1.docsOnly && !docsOnly) log(`${t.title}: rejected "for docs", but the fix touches code - full round`)
  if (!docsOnly) {
    const xt = await testChecked(t, st, `${tag}after-review`)
    if (xt.fail) return xt
    const tr = xt.tr
    if (tr.verdict !== 'green') return { fail: 'tester after the review fix - red', test: tr.summary, review: r1.summary }
  }
  const x2 = await reviewChecked(t, st, `${tag}2`, docsOnly ? 'only the diff of the fix after review 1' : '')
  if (x2.fail) return x2
  const r2 = x2.rv
  log(`${t.title}: review ${tag}2 - ${r2.verdict}`)
  if (r2.verdict === 'done') return { ok: r2 }
  return { fail: 'second review rejection', second: true, docsOnly: r2.docsOnly, review: r2.summary }
}

async function chain(t) {
  const st = { head: '' }
  const pc = await pre(t)
  if (!pc) return stop(t, 'the precondition check returned no result')
  if (!pc.ok || pc.blockingQuestions.length) return stop(t, 'preconditions', { problems: pc.problems, questions: pc.blockingQuestions })

  if (t.analystFirst) {
    const a = await analyst(t, 'the task needs a spec or a diagnosis before code (brief: analystFirst)')
    if (!a) return stop(t, 'the analyst returned no result')
    if (!a.ready || a.split.length || a.questions.length) return stop(t, 'analyst: split the task or an answer is needed', { split: a.split, questions: a.questions, analyst: a.summary })
  }

  const b = await buildAndTest(t, st, t.start || 'Start with red guards for the cells of the brief (and analyst.md, if any).', '', 3)
  if (b.fail) return stop(t, b.fail, b)
  const rv = await reviewLoop(t, st, '')
  if (rv.ok) return { task: t.key, status: 'done', review: rv.ok.summary }
  if (!rv.second || rv.docsOnly) return stop(t, rv.fail, rv)

  // Second rejection for code -> analyst in the same run, then one full round; a third rejection goes to the coordinator.
  const a = await analyst(t, `second review rejection for code:\n${rv.review}`)
  if (!a) return stop(t, 'the analyst returned no result')
  if (!a.ready || a.split.length || a.questions.length) return stop(t, 'analyst after the second rejection: split or an answer is needed', { split: a.split, questions: a.questions, analyst: a.summary })
  const b2 = await buildAndTest(t, st, `After the second review rejection the analyst wrote ${t.dir}/analyst.md - fix according to it and to review.md.`, 'A', 2)
  if (b2.fail) return stop(t, `after the analyst: ${b2.fail}`, b2)
  const rv2 = await reviewLoop(t, st, 'A')
  if (rv2.ok) return { task: t.key, status: 'done', review: rv2.ok.summary }
  return stop(t, `after the analyst: ${rv2.fail}`, rv2)
}

const results = await pipeline(TASKS, (t) => chain(t))
return results.map((r, i) => r || stop(TASKS[i], 'the chain crashed'))
