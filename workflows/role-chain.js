export const meta = {
  name: 'role-chain',
  description: 'Role chain over tasks in parallel: preconditions -> (analyst) -> programmer -> tester -> reviewer (+ security reviewer); fix rounds and an analyst after the second rejection',
  whenToUse: 'Started by the codis-agents:role-chain skill, which reads .claude/codis-agents.json and passes it. args: {owner: "the owner\'s request, verbatim", config: <resolved project config>, tasks: [{key, title, wt, branch, accept, dir?, gdir?, start?, analystFirst | analysis | noAnalysis (exactly one), feature?, spec?, stack?, security?}]}',
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
// start (what is new for the first programmer), stack (the tester's docker compose project),
// security (the brief marks the task as security work - a security reviewer joins the review),
// feature (key of the feature this task is a part of, when the feature was split: its folder <sharedDir>/<feature>
// holds the analysis of the whole feature), spec (path or paths of the arc specification: context for every role,
// never the task's analysis).
// Analysis marker - exactly one of: analystFirst (true: the analyst runs before the programmer), analysis (absolute path
// of an existing analyst or diagnosis report of THIS task - inside its folder dir, or inside the folder of its feature),
// noAnalysis (a short written reason why none is needed: a tail, a one-line fix). Without exactly one the task stops
// before any agent: the chain does not guess whether a task is a defect. An arc specification is not an analysis
// (tasks that had only the arc spec: 44 % red testers and 2.4 programmer rounds, against 24 % and 1.65 with their own
// analysis): it goes into spec, and an analysis path outside the task's or feature's folder, or equal to a spec path,
// stops the task.

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
const specsOf = (t) => (t.spec === undefined ? [] : [].concat(t.spec))
const TASKS = TASKS_IN.map((t) => Object.assign({}, t, {
  dir: t.dir || `${CFG.sharedDir}/${t.key}`, wt: abs(t.wt), gdir: t.gdir || t.wt, specs: specsOf(t),
}))
// Environment floors of the preconditions (config preconditions; the defaults are explained in scripts/env-check.js).
const ENV = Object.assign({ minFreeDiskGB: 10, minSwapGB: 4 }, CFG.preconditions || {})
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// Rules that reach a role only through its prompt (rules/multi-agent.md: the pause and 200k rules worked once they
// were in the prompt). The id matches the marker <!-- role:<id> --> of a line in rules/multi-agent.md; local-* exist
// only in the chain. tests/role-chain.test.js fails when a marked line has no rule or a role prompt lacks one.
const RULE_LIST = (t) => [
  ['local-task', `Task "${t.title}". Brief: ${t.dir}/BRIEF.md (read all of it and the sections it refers to). Worktree ${t.wt}, branch ${t.branch}.${t.specs.length ? ` Arc specification (context of the surface; it is not this task's analysis): ${t.specs.join(', ')}.` : ''}`],
  ['scope', `The owner asked: "${OWNER}". Do only the task "${t.title}"; refuse neighbouring tasks and do not touch other worktrees.`],
  ['decisions', 'Only the coordinator writes the owner\'s decisions. An open question goes into your own report as a line "❓ coordinator: ..."; do not decide it yourself.'],
  ['pauses', 'Pauses: never wait longer than 270 s at a time - run anything long through Bash run_in_background and wait with Monitor in slices; an agent with no output for 10 minutes is killed.'],
  ['context', 'Context: past ~200k finish the current stage, write the report with "Next step: ..." and stop - a fresh agent continues.'],
  ['slots', `Heavy work goes through memory slots: ${SCRIPTS}/heavy.sh <cmd>, ${SCRIPTS}/medium.sh <cmd>, full guard run ${SCRIPTS}/guards-all.sh ${t.gdir}.`],
  ['docker', `Docker: ${CFG.ownerStackReadOnly ? `the owner's stack ${CFG.ownerStackReadOnly}` : 'the owner\'s stack'} is read-only (docker cp out is fine); never write into its containers; only a tester runs its own stack, and only when the brief asks, then removes it with its images and volumes (docker compose -p <stack> down -v --rmi all). Never remove the owner's stack or its images; other images and the build cache are not yours to clean. A post-check after you removes what the task left (its stack, processes in its worktree, the slots they hold) and reports it.`],
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
  verdict: { type: 'string', enum: ['green', 'red', 'environment'], description: 'environment - red caused by the environment, not by the product: the task stops for the coordinator' },
  environment: { type: 'string', description: 'with verdict environment: the cause and its evidence (a cut-off full run, no slot, disk or swap, Docker down)' },
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
// A post-check agent runs one deterministic script. A cheap agent sometimes returns ok=false without running it, so a
// failed check (ok=false or no result) is repeated once by the default model (label <label>#retry) and the second
// answer decides: the script gives the same answer again, so a real violation or real leftovers still stop the task.
const checkOpts = (label, phase, schema, retry) => Object.assign({ label: retry ? `${label}#retry` : label, phase, schema, effort: 'low', agentType: 'general-purpose' },
  retry ? {} : { model: 'haiku' })
async function checkTwice(t, what, passed, run) {
  const first = await run(false)
  if (passed(first)) return { res: first }
  log(`${t.title}: ${what} post-check ${first ? 'failed' : 'returned no result'} - repeated once by the default model`)
  return { first, res: await run(true) }
}
const ALLOW = (CFG.testerWritable || []).map((r) => ` --allow ${sq(r)}`).join('')
const diffCheck1 = (t, role, since, retry) => agent(`Run one command and return its JSON output as the schema fields (change nothing, analyse nothing):
node ${SCRIPTS}/role-diff-check.js --wt ${t.wt} --since ${since} --role ${role}${role === 'tester' ? ALLOW : ''}
If the command fails without JSON - ok=false, error = the error text.`,
  checkOpts(`diff:${t.key}:${role}`, role === 'tester' ? 'Tester' : 'Reviewer', DIFF_SCHEMA, retry))
const diffCheck = async (t, role, since) => (await checkTwice(t, role, (d) => !!(d && d.ok), (retry) => diffCheck1(t, role, since, retry))).res
const diffFail = (role, d) => !d ? `the ${role} post-check returned no result`
  : !d.ok ? `the ${role} changed what the role may not: ${(d.offending || []).join(', ') || d.error || '?'}` : ''

// Leftovers post-check: Docker resources of the task's stack (by label), processes in its worktree, the slots they hold.
// --fix removes only those; what was removed goes into the task result and <dir>/leftovers.md, what remains stops it.
const LEFT_SCHEMA = { type: 'object', properties: {
  ok: { type: 'boolean' }, found: { type: 'array', items: { type: 'string' } }, removed: { type: 'array', items: { type: 'string' } },
  remaining: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
}, required: ['ok', 'found', 'removed', 'remaining'] }
const SLOTS_DIR = CFG.slots && CFG.slots.lockDir
// A post-check agent sees only this text: without the context below it took --fix for a destructive step nobody asked
// for and refused to run it (two refusals in one task, 2026-10-19), which stopped a task that had nothing left over.
const leftCheck1 = (t, when, retry) => agent(`This is the leftovers post-check of the codis-agents process the project owner set up (rule "Docker" in rules/multi-agent.md): after the tester and at the end of every task it removes what this task itself left behind. --fix touches only Docker resources labelled with this task's own compose project, processes whose cwd or argv lie inside this task's worktree, and the slots they hold; the owner's stack is excluded by --owner-stack and is never touched. Running it is the expected step, not a decision for you to make.
Run one command and return its JSON output as the schema fields (change nothing else, analyse nothing):
node ${SCRIPTS}/role-leftovers-check.js --wt ${t.wt}${t.stack ? ` --stack ${sq(t.stack)}` : ''}${CFG.ownerStackReadOnly ? ` --owner-stack ${sq(CFG.ownerStackReadOnly)}` : ''}${SLOTS_DIR ? ` --slots-dir ${sq(SLOTS_DIR)}` : ''} --fix --log ${sq(`${t.dir}/leftovers.md`)}
If the command fails without JSON - ok=false, error = the error text, remaining = [the error text].`,
  checkOpts(`left:${t.key}:${when}`, when === 'tester' ? 'Tester' : 'Reviewer', LEFT_SCHEMA, retry))
const leftPassed = (l) => !!(l && l.ok && !(l.remaining || []).length)
// What a failed first attempt reports as removed was removed (--fix ran before the failure), so it is kept as well.
const leftCheck = async (t, when) => {
  const { first, res } = await checkTwice(t, `leftovers (${when})`, leftPassed, (retry) => leftCheck1(t, when, retry))
  const early = ((first && first.removed) || []).filter((x) => !((res && res.removed) || []).includes(x))
  return res && early.length ? Object.assign({}, res, { removed: early.concat(res.removed || []) }) : res
}
// '' when nothing remains (removed ones are kept in st.leftovers), otherwise the reason to stop.
const leftFail = (st, when, l) => {
  if (!l) return `the leftovers post-check (${when}) returned no result`
  if ((l.removed || []).length) st.leftovers.push(...l.removed.map((x) => `${when}: ${x}`))
  return leftPassed(l) ? ''
    : `leftovers the chain could not remove (${when}): ${(l.remaining || []).join(', ') || l.error || '?'}`
}

// The analysis marker of a task: {mode: 'run'|'reused'|'none', path?, reason?}, or {error} when not exactly one is given.
const nonBlank = (v) => typeof v === 'string' && v.trim() !== ''
const MARKERS = 'the task must carry exactly one of `analystFirst` (true: the analyst runs first), `analysis` (absolute path of an existing analyst or diagnosis report of this task, inside its folder or the folder of its `feature`), `noAnalysis` (why no analysis is needed: a tail, a one-line fix; for a defect, why the diagnosis is skipped); an arc specification goes into `spec`, it is not an analysis'
// The folders an analysis of this task may live in: its own, and the folder of the feature it was split from.
const ownFolders = (t) => [t.dir].concat(nonBlank(t.feature) ? [`${CFG.sharedDir}/${t.feature.trim()}`] : [])
  .map((d) => d.replace(/\/+$/, '') + '/')
function analysisOf(t) {
  if (t.feature !== undefined && !nonBlank(t.feature)) return { error: 'feature must be a non-empty task key' }
  if (t.specs.some((p) => !nonBlank(p))) return { error: 'spec must be a non-empty path or a list of them' }
  const given = [['analystFirst', t.analystFirst !== undefined && t.analystFirst !== false],
    ['analysis', t.analysis !== undefined], ['noAnalysis', t.noAnalysis !== undefined]].filter((g) => g[1]).map((g) => g[0])
  const bad = given.length !== 1 ? `${given.length ? 'several' : 'no'} analysis markers${given.length ? ` (${given.join(', ')})` : ''}`
    : given[0] === 'analystFirst' && t.analystFirst !== true ? 'analystFirst must be true'
    : given[0] === 'analysis' && !nonBlank(t.analysis) ? 'analysis must be a non-empty path'
    : given[0] === 'noAnalysis' && !nonBlank(t.noAnalysis) ? 'noAnalysis must be a non-empty reason' : ''
  if (bad) return { error: `${bad}: ${MARKERS}` }
  if (given[0] === 'analystFirst') return { mode: 'run', path: `${t.dir}/analyst.md` }
  if (given[0] === 'analysis') {
    const p = t.analysis.trim()
    const where = ownFolders(t)
    if (t.specs.map((x) => x.trim()).includes(p)) return { error: `analysis ${p} is the arc specification of this task (spec): ${MARKERS}` }
    if (!p.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(p) || !where.some((d) => p.startsWith(d))) {
      return { error: `analysis ${p} is not an absolute path inside ${where.join(' or ')}: ${MARKERS}` }
    }
    return { mode: 'reused', path: p }
  }
  return { mode: 'none', reason: t.noAnalysis.trim() }
}
const analysisLine = (a) => (a.mode === 'none' ? `No analysis: ${a.reason}` : `The analysis to follow: ${a.path}`)

const DOCS_PATH = /(\.md$)|(^|\/)docs\//
const stop = (t, why, extra) => Object.assign({ task: t.key, status: 'stopped', why }, extra || {})

// What the preconditions check about the task's own analysis: an arc specification passed as the task's analysis, or a
// noAnalysis reason that only points to it, is not an analysis of the task (rules: "Analyst or diagnoser").
const preAnalysis = (t) => (t.an.mode === 'reused'
  ? ` the reused analysis ${t.an.path} exists, is non-empty and is a matrix of cases or a diagnosis written for this task (or for the feature it was split from), not a specification of the whole arc;`
  : t.an.mode === 'none'
    ? ` the noAnalysis reason "${t.an.reason}" says why this task needs no matrix of its own (a tail, a one-line fix, a rename); "the arc specification covers it" is not such a reason;`
    : '')
const pre = (t) => agent(`You check PRECONDITIONS (read only, change nothing). ${RULES(t)}
Check: ${t.dir}/BRIEF.md exists and contains an acceptance scenario in the real environment;${preAnalysis(t)}${t.specs.length ? ` the arc specification ${t.specs.join(', ')} exists;` : ''} ${t.wt} exists and is on branch ${t.branch}; there are no uncommitted changes (except untracked build output or probes); the brief has no unanswered questions to the owner on which acceptance depends; the environment has room: run node ${SCRIPTS}/env-check.js --path ${sq(t.wt)} --path ${sq(t.dir)} --min-disk-gb ${ENV.minFreeDiskGB} --min-swap-gb ${ENV.minSwapGB} (free disk and swap headroom) and copy its problems. ok=false if any of this fails.`,
  { label: `pre:${t.key}`, phase: 'Preconditions', schema: PRE_SCHEMA, effort: 'low', agentType: 'general-purpose' })

const analyst = (t, why) => agent(`You are the ANALYST/DIAGNOSER (read code only; you write only ${t.dir}/analyst.md). ${RULES(t)}
Reason: ${why}
Write a matrix of cases (every dimension: states x events x environments) or find the cause of the defect with file:line. Count the cells and subsystems. If by the rule "Split the task" the task must be split, propose subtasks and do not declare ready. Every cell has an expected result and a basis (the brief, documentation, an experiment); no thresholds or name lists.${note('analyst')}`,
  { label: `analyst:${t.key}`, phase: 'Analyst', schema: ANALYST_SCHEMA, agentType: roleType('analyst') })

const prog = (t, task, n) => agent(`You are the PROGRAMMER. ${RULES(t)} Report: ${t.dir}/prog.md (round ${n}).
${analysisLine(t.an)}
${task}
Order: red guard -> commit -> code -> commit -> mutations AFTER the commit (table in prog.md) -> full run ${SCRIPTS}/guards-all.sh ${t.gdir} in the background -> analysis of new reds. status=blocked if you cannot go on without the owner's answer.${note('programmer')}`,
  { label: `prog:${t.key}#${n}`, phase: 'Programmer', schema: PROG_SCHEMA, agentType: roleType('programmer') })

const test = (t, n) => agent(`You are the TESTER. You do not change product code. ${RULES(t)} Report: ${t.dir}/test.md (round ${n}; keep earlier rounds).
1. An independent inventory before reading the diff (inputs, places, cells) - compare it with the programmer's coverage.
2. Your own guards for what is not covered -> commit -> mutations after the commit.
3. Acceptance in the real environment: ${t.accept}${t.stack ? ` Your own stack: docker compose -p ${t.stack}; afterwards remove it with its images and volumes: docker compose -p ${t.stack} down -v --rmi all.` : ''} Evidence (logs, numbers, screenshots) goes into ${t.dir} with the prefix test-.
4. Do not repeat the programmer's full run: new and touched guards and mutations; a full run only after your own commits.
green - only if the brief's acceptance is met in full. red - the product fails a guard or the acceptance.
environment - red that the product did not cause, so a programmer has nothing to fix: your or the programmer's full run cut off before its tally (killed, timed out, out of memory), no memory slot within your time, disk or swap exhausted (node ${SCRIPTS}/env-check.js --path ${sq(t.wt)} --min-disk-gb ${ENV.minFreeDiskGB} --min-swap-gb ${ENV.minSwapGB}), Docker or your stack down for a reason outside the task's code. Put the cause and its evidence into environment; the task stops for the coordinator. Never use it for a red that the product causes.${note('tester')}`,
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
  const lf = leftFail(st, 'tester', await leftCheck(t, 'tester'))
  if (lf) return { fail: lf }
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

// A red from the environment goes to the coordinator, not to a programmer: a programmer round "without changes" cost
// about 3.3M tokens in one window (cut-off full runs, a full disk, no heavy slot).
const envStop = (round, tr) => ({ fail: `tester ${round}: red from the environment, not the product - ${tr.environment || tr.summary || '?'}`,
  environment: tr.environment || tr.summary || '', test: tr.summary })

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
    if (tr.verdict === 'environment') return envStop(`${tag}${r}`, tr)
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
    if (tr.verdict === 'environment') return Object.assign(envStop(`${tag}after-review`, tr), { review: r1.summary })
    if (tr.verdict !== 'green') return { fail: 'tester after the review fix - red', test: tr.summary, review: r1.summary }
  }
  const x2 = await reviewChecked(t, st, `${tag}2`, docsOnly ? 'only the diff of the fix after review 1' : '')
  if (x2.fail) return x2
  const r2 = x2.rv
  log(`${t.title}: review ${tag}2 - ${r2.verdict}`)
  if (r2.verdict === 'done') return { ok: r2 }
  return { fail: 'second review rejection', second: true, docsOnly: r2.docsOnly, review: r2.summary }
}

// After the preconditions every outcome passes the leftovers post-check; removed leftovers are named in the result.
// The analysis marker is checked before any agent; from then on every result carries it (analysis).
async function chain(t0) {
  const an = analysisOf(t0)
  if (an.error) return stop(t0, 'preconditions', { problems: [an.error], questions: [an.error] })
  const t = Object.assign({}, t0, { an })
  const withAn = (r) => Object.assign({}, r, { analysis: an })
  const st = { head: '', leftovers: [] }
  const pc = await pre(t)
  if (!pc) return withAn(stop(t, 'the precondition check returned no result'))
  if (!pc.ok || pc.blockingQuestions.length) return withAn(stop(t, 'preconditions', { problems: pc.problems, questions: pc.blockingQuestions }))
  const r = await work(t, st)
  const lf = leftFail(st, 'end', await leftCheck(t, 'end'))
  const out = lf ? (r.status === 'stopped' ? Object.assign({}, r, { why: `${r.why}; ${lf}` }) : stop(t, lf, { review: r.review })) : r
  return withAn(st.leftovers.length ? Object.assign({}, out, { leftovers: st.leftovers }) : out)
}

async function work(t, st) {

  if (t.an.mode === 'run') {
    const a = await analyst(t, 'the task needs a spec or a diagnosis before code (brief: analystFirst)')
    if (!a) return stop(t, 'the analyst returned no result')
    if (!a.ready || a.split.length || a.questions.length) return stop(t, 'analyst: split the task or an answer is needed', { split: a.split, questions: a.questions, analyst: a.summary })
  } else log(t.an.mode === 'reused' ? `${t.title}: analyst reused - ${t.an.path}` : `${t.title}: no analyst - ${t.an.reason}`)

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
