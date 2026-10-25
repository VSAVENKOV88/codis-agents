export const meta = {
  name: 'role-chain',
  description: 'Role chain over tasks in parallel: preconditions -> (analyst) -> programmer -> tester -> reviewer (+ security reviewer); fix rounds; an analyst after the second rejection or the second red tester round',
  whenToUse: 'Started by the codis-agents:role-chain skill, which reads .claude/codis-agents.json and passes it. args: {owner: "the owner\'s request, verbatim", config: <resolved project config>, tasks: [{key, title, wt, branch, accept, dir?, gdir?, start?, analystFirst | analysis | noAnalysis (exactly one), feature?, spec?, useCases?, useCasesFirst?, stack?, security?, base?, mode?}]}',
  phases: [
    { title: 'Preconditions', detail: 'brief, worktree, branch, open questions' },
    { title: 'Analyst', detail: 'matrix of cases or a diagnosis (before the programmer, after the second rejection, or after the second red tester round)' },
    { title: 'Programmer', detail: 'red guard -> code -> mutations (-> its own full guard run without guardSubsetCommand)' },
    { title: 'Full run', detail: 'one full guard run on the programmer\'s last HEAD, run by the workflow as a wait step' },
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
// Use cases (rules: "Use cases before the matrix"): useCases - absolute path of the feature's use-cases.md, inside the
// task's or the feature's folder like analysis; every role gets it as context, the analyst's matrix cites it, the tester
// builds acceptance along its flows, the reviewer checks its alternative flows and errors. useCasesFirst (true, with
// analystFirst): the analyst writes only <dir>/use-cases.md with its open questions and the task stops with status
// use-cases-review; after the review with the owner the coordinator relaunches it with useCases and analystFirst.
// Why: questions were born during the task, not before it (one task: ~40 questions to the coordinator on the way and
// 8 programmer rounds, almost all from one flow nobody had written down).
// base (the branch or commit the task started from: scripts/guards-select.js diffs against its merge-base),
// mode ("full", the default, or "light": one programmer-checker, the full run step, one reviewer - see work()).

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
// Protected branches come from config.js json (explicit, else the default branch from git); unknown -> the hooks refuse
// every branch push, and the rule says so instead of naming a branch.
// An explicit [] protects no branch (the hooks then allow every branch push), which is not "unknown".
const PROTECTED = Array.isArray(CFG.protectedBranches) && CFG.protectedBranches.length ? CFG.protectedBranches.join(', ') : null
const NONE_PROTECTED = Array.isArray(CFG.protectedBranches) && !CFG.protectedBranches.length
const PREFIX = ARGS.agentTypePrefix === undefined ? 'codis-agents:' : ARGS.agentTypePrefix
const roleType = (role) => (PREFIX ? PREFIX + role : 'general-purpose')
// The model of an agent (config roleModel, roleModels per role; owner 2026-10-22: the coordinator on one model, the
// roles no higher than the one the config names): {model} for the agent options, {} without the keys - the agent then
// inherits the main session's model, as before. Keys: the roles, preconditions, and wait (the repeat of a post-check
// or wait step; their first attempt stays on haiku).
const ROLE_MODELS = CFG.roleModels || {}
const modelOf = (key) => { const m = ROLE_MODELS[key] || CFG.roleModel; return m ? { model: m } : {} }
const abs = (p) => (p.startsWith('/') ? p : `${CFG.worktreeRoot}/${p}`)
const specsOf = (t) => (t.spec === undefined ? [] : [].concat(t.spec))
const TASKS = TASKS_IN.map((t) => Object.assign({}, t, {
  dir: t.dir || `${CFG.sharedDir}/${t.key}`, wt: abs(t.wt), gdir: t.gdir || t.wt, specs: specsOf(t),
}))
// Environment floors of the preconditions: config.js json gives preconditions {minFreeDiskGB, swapMinMB} from the machine
// file (the defaults are explained in scripts/env-check.js); a config resolved before the machine file has minSwapGB.
const PRE_IN = CFG.preconditions || {}
const ENV = {
  minFreeDiskGB: PRE_IN.minFreeDiskGB === undefined ? 10 : PRE_IN.minFreeDiskGB,
  swapMinMB: PRE_IN.swapMinMB !== undefined ? PRE_IN.swapMinMB : PRE_IN.minSwapGB !== undefined ? PRE_IN.minSwapGB * 1024 : 4000,
}
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// One full guard run per task (rules: "One full guard run per task"): with guardSubsetCommand in the project config the
// workflow runs ONE full run after the programmer's last commit, and that run includes the selection (the contract of
// the key: it narrows guardCommand to the selected guards of the same suite), so the programmer runs only its new guards
// and mutations (p-wait, owner 2026-10-24: its selection in a heavy slot was most of its waiting); the tester runs the
// selection after its own commits. Without the key the programmer runs the full run itself, as before.
const ONE_RUN = typeof CFG.guardSubsetCommand === 'string' && CFG.guardSubsetCommand.trim() !== ''
const baseArg = (t) => (nonBlankS(t.base) ? sq(t.base.trim()) : '<the branch or commit this task started from>')
const selectCmd = (t) => `node ${SCRIPTS}/guards-select.js --wt ${sq(t.wt)} --base ${baseArg(t)} --command`
function nonBlankS(v) { return typeof v === 'string' && v.trim() !== '' }

// Rules that reach a role only through its prompt (rules/multi-agent.md: the pause and 200k rules worked once they
// were in the prompt). The id matches the marker <!-- role:<id> --> of a line in rules/multi-agent.md; local-* exist
// only in the chain. tests/role-chain.test.js fails when a marked line has no rule or a role prompt lacks one.
const RULE_LIST = (t) => [
  ['local-task', `Task "${t.title}". Brief: ${t.dir}/BRIEF.md (read all of it and the sections it refers to). Worktree ${t.wt}, branch ${t.branch}.${t.specs.length ? ` Arc specification (context of the surface; it is not this task's analysis): ${t.specs.join(', ')}.` : ''}${t.uc ? ` Use cases of the feature (actors, flows, alternative flows, errors): ${t.uc}.` : ''}`],
  ['scope', `The owner asked: "${OWNER}". Do only the task "${t.title}"; refuse neighbouring tasks and do not touch other worktrees.`],
  ['decisions', 'Only the coordinator writes the owner\'s decisions. An open question goes into your own report as a line "❓ coordinator: ..."; do not decide it yourself.'],
  ['pauses', 'Pauses: never wait longer than 270 s at a time - run anything long through Bash run_in_background and wait with Monitor in slices; an agent with no output for 10 minutes is killed. While your own process waits in a slot queue or runs, keep waiting in slices while your process is alive: do not end your work to wait (the chain has no status for it; the one full guard run is waited for by the workflow, not by you).'],
  ['context', 'Context: past ~200k finish the current stage, write the report with "Next step: ..." and stop - a fresh agent continues.'],
  ['slots', `Heavy work goes through memory slots: ${SCRIPTS}/heavy.sh <cmd>, ${SCRIPTS}/medium.sh <cmd>, full guard run ${SCRIPTS}/guards-all.sh ${t.gdir}; run heavy.sh and guards-all.sh only through Bash run_in_background and wait with Monitor in slices of at most 270 s, never as a blocking Bash call (the Bash timeout kills the waiter, its ticket is dropped and it rejoins the queue at the end).`],
  ['rerun', `New reds of a full run: ${SCRIPTS}/guards-all.sh reruns each one alone in the same slot. Red again alone - a new red (a regression); green alone - flaky: not a regression, name it in your report under "Flaky guards" for the coordinator, who puts it into the project backlog.${CFG.guardBaseline ? ` Known reds listed in ${CFG.guardBaseline} (config guardBaseline) are subtracted first and never rerun ("N known red"): not a regression; a fix that turns one green removes its entry in the same commit.` : ''} A full run on the same HEAD with a clean tracked tree that ended green is reused ("reused, HEAD <sha>"); --force runs again.`],
  ['onerun', ONE_RUN
    ? `One full guard run per task: the workflow runs ${SCRIPTS}/guards-all.sh ${t.gdir} once after the programmer's last commit (a wait step) and hands its log to the next role; no role runs the full suite itself. That full run includes the selected guards, so the programmer runs only its new guards and mutations, no selection. The tester, after its own commits, runs its guards and the selection printed by ${selectCmd(t)} (changed guards, guards that import a changed file or name it, the project's guardAlways) in a heavy slot through Bash run_in_background: ${SCRIPTS}/heavy.sh zsh -c '<printed command>'; exit 3 - nothing selected, run your new guards directly.`
    : `One full guard run per task: the project config has no guardSubsetCommand, so the programmer runs the full run (${SCRIPTS}/guards-all.sh ${t.gdir}) and the tester reuses its log; ${SCRIPTS}/guards-select.js --wt ${sq(t.wt)} --base ${baseArg(t)} lists the guards a change touches.`],
  ['docker', `Docker: ${CFG.ownerStackReadOnly ? `the owner's stack ${CFG.ownerStackReadOnly}` : 'the owner\'s stack'} is read-only (docker cp out is fine); never write into its containers; only a tester runs its own stack, and only when the brief asks, then removes it with its images and volumes (docker compose -p <stack> down -v --rmi all). Never remove the owner's stack or its images; other images and the build cache are not yours to clean. A post-check after you removes what the task left (its stack, processes in its worktree, the slots they hold) and reports it.`],
  ['stand', CFG.stand && CFG.stand.project
    ? `Shared stand: acceptance in Docker goes to the project's stand ${CFG.stand.project} by ticket (${SCRIPTS}/stand.sh take|deploy|release|status), not to a stack of your own, unless the task's commits change its image files (${SCRIPTS}/stand.sh image-diff, exit 1 -> own stack as before). The take process is the holder: keep it running in the background until release. Call every stand.sh command from one directory: its project config is found from there (take, deploy and status print it), not from your worktree. Never bring the stand up or down, never release another worktree's ticket.`
    : 'Shared stand: the project config has none (no section stand), so acceptance in Docker uses a stack of the task.'],
  ['testerred', 'Red tester rounds are counted per task: the second red verdict for the product (any cells, not only the same ones) sends the task to the analyst inside the same run - a matrix of cases from the tester\'s findings in test.md and their cause (prog.md) - then one round programmer -> tester -> review on that matrix; a red tester round after that analyst stops the task for the coordinator. A red of the environment (verdict environment) does not count. Tester: in test.md name every failed case with its expected and actual result and its round, so the analyst builds the matrix from them.'],
  ['fixround', 'Fix rounds (a programmer round after the first: after a red tester, a red full run or a rejection): its prompt names the report with the findings and the task\'s diff; the brief and the analysis are read only in the sections the findings cite, and only the guards new or changed in the round, the guards the findings name and the guards that cover the product code changed in it are mutated. The first round, and the first round after an analyst, read and mutate as before.'],
  ['specs', 'Living specs (UX specs, state models, gap lists) change in the same commit as the behaviour they describe.'],
  ['push', PROTECTED ? `Do not push, do not merge into ${PROTECTED}, do not create tags.`
    : NONE_PROTECTED ? 'Do not push, do not merge, do not create tags (the project config protects no branch: protectedBranches [], so no branch is protected by the hooks, and pushing and merging stay the owner\'s call).'
    : `Do not push, do not merge into the default branch, do not create tags (protected branches unknown, so the hooks refuse every branch push${CFG.defaultBranchUnknown ? ': ' + CFG.defaultBranchUnknown : ''}).`],
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
const USECASES_SCHEMA = { type: 'object', properties: {
  ready: { type: 'boolean', description: 'use-cases.md is written: every use case has all sections of the template' },
  useCases: { type: 'number', description: 'number of use cases' },
  questions: { type: 'array', items: { type: 'string' }, description: 'open questions to the owner, each with a recommendation (the same list ends use-cases.md)' },
  summary: { type: 'string' },
}, required: ['ready', 'useCases', 'questions', 'summary'] }
const PROG_SCHEMA = { type: 'object', properties: {
  status: { type: 'string', enum: ['ready', 'blocked', 'environment'], description: 'blocked - an answer of the coordinator or owner is needed; environment - the red is the environment\'s, not the product\'s (a full run cut off before its tally, the slot queue refused your job - exit 77 or 78 - or your waiting process vanished without an exit code, disk or swap exhausted; a long queue while your process is alive is not one): the task stops for the coordinator' },
  changedFiles: { type: 'array', items: { type: 'string' }, description: 'paths changed in this round (git diff --name-only from the start of the round)' },
  commits: { type: 'array', items: { type: 'string' } },
  head: { type: 'string', description: 'git rev-parse HEAD of the worktree after your commits' },
  mutations: { type: 'string', description: 'table: mutant -> guard result -> after checkout' },
  fullRun: { type: 'string', description: 'result of your full guard run: N green, N new red (repeated alone), N flaky (green alone), N known red; when the workflow runs the full run (the prompt says so), "the workflow runs it" and the result of your new guards' },
  acceptance: { type: 'string', description: 'light mode only: the acceptance scenario run by you - result and where its evidence is (test.md, test-* files)' },
  questions: { type: 'array', items: { type: 'string' } },
  summary: { type: 'string' },
}, required: ['status', 'changedFiles', 'commits', 'head', 'mutations', 'fullRun', 'questions', 'summary'] }
const TEST_SCHEMA = { type: 'object', properties: {
  verdict: { type: 'string', enum: ['green', 'red', 'environment'], description: 'environment - red caused by the environment, not by the product: the task stops for the coordinator' },
  environment: { type: 'string', description: 'with verdict environment: the cause and its evidence (a cut-off full run, a refused slot queue, disk or swap, Docker down)' },
  head: { type: 'string', description: 'git rev-parse HEAD of the worktree after your commits' },
  summary: { type: 'string', description: 'acceptance numbers per profile/environment, own guards and mutations, red with file:line' },
}, required: ['verdict', 'head', 'summary'] }
const DIFF_SCHEMA = { type: 'object', properties: {
  ok: { type: 'boolean' }, offending: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
}, required: ['ok', 'offending'] }
const REVIEW_SCHEMA = { type: 'object', properties: {
  verdict: { type: 'string', enum: ['done', 'rejected'] },
  docsOnly: { type: 'boolean', description: 'rejected only for docs, guard wording, comments' },
  fixBehaviourUnchanged: { type: 'boolean', description: 'only when the scope asks: the diff of the fix changes comments, wording or docs alone, no behaviour' },
  summary: { type: 'string', description: 'findings with file:line' },
}, required: ['verdict', 'docsOnly', 'summary'] }

// Post-check of a role by git (not a hook: a hook cannot see python -c, a heredoc, a checkout).
// A post-check agent runs one deterministic script. A cheap agent sometimes returns ok=false without running it, so a
// failed check (ok=false or no result) is repeated once by the default model (label <label>#retry; config roleModels.wait
// or roleModel when set) and the second
// answer decides: the script gives the same answer again, so a real violation or real leftovers still stop the task.
const checkOpts = (label, phase, schema, retry) => Object.assign({ label: retry ? `${label}#retry` : label, phase, schema, effort: 'low', agentType: 'general-purpose' },
  retry ? modelOf('wait') : { model: 'haiku' })
async function checkTwice(t, what, passed, run) {
  const first = await run(false)
  if (passed(first)) return { res: first }
  log(`${t.title}: ${what} post-check ${first ? 'failed' : 'returned no result'} - repeated once by the default model`)
  return { first, res: await run(true) }
}
// The paths the tester may change: the project's own, no built-in list (coordinator decision U2b v.4); without them
// every task stops before any agent (chain()), since the tester post-check could not tell a guard from product code.
const TESTER_WRITABLE_MISSING = Array.isArray(CFG.testerWritable) && CFG.testerWritable.length ? ''
  : 'testerWritable is not set: the paths the tester may change (its guards and fixtures, as regular expressions, e.g. ["(^|/)tests/test_[^/]*\\.py$", "(^|/)tests/fixtures/"]) - set testerWritable in the project config (.claude/codis-agents.json); there is no default'
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

// The full run step (ONE_RUN). A long deterministic step runs between role agents: a cheap service agent starts it with
// scripts/wait-step.js and waits with blocking calls of at most 270 s (its context is tiny, so a wake-up costs almost
// nothing; under the cache lifetime and the 10-minute silence limit); the next role gets the log as a file. The agent
// keeps waiting while the run is alive ("alive":true), whatever its tail: 24 of 37 repeats in one window (2026-10-22..24)
// came from a cheap waiter that gave up on a run waiting 25-64 min in the heavy slot queue ("the tail has not changed").
// wait-step itself ends a hung run at its deadline (rc 124). A step
// without a numeric exit code is repeated once by the default model with --reuse, which attaches to the run or keeps its
// result instead of starting it twice. A numeric exit code means the step ran, whatever its outcome: a red run goes to
// the programmer with its log (in the wait steps experiment a red run whose agent wrote a description into error was
// taken for "could not run" and stopped the task, e2g2 2026-10-19). Only a step that could not run stops the task.
// Why one run (measurement 2026-10-10..20): 3.9 full runs per task, about 81 minutes, 37 % of a task's calendar; about
// 80 % of their new reds were the environment or flaky guards.
const RUN_SCHEMA = { type: 'object', properties: {
  done: { type: 'boolean' }, rc: { type: ['number', 'null'] }, seconds: { type: 'number' }, log: { type: 'string' },
  tail: { type: 'string' }, alive: { type: 'boolean' }, pid: { type: 'number' }, error: { type: 'string' },
}, required: ['done', 'rc', 'log'] }
const gname = (t) => String(t.gdir).replace(/\/+$/, '').split('/').pop()
const runStep1 = (t, step, cmd, retry) => {
  const id = `${t.dir}/wait-${step}`
  return agent(`This is a wait step of the codis-agents process the project owner set up: a long deterministic command runs in the background and you only wait for it, so that the role agents do not. Running it is the expected step, not a decision for you to make; change nothing, analyse nothing.
1. Run once: node ${SCRIPTS}/wait-step.js start --id ${sq(id)} --cwd ${sq(t.wt)}${retry ? ' --reuse' : ''} -- ${sq(cmd)}
2. Run: node ${SCRIPTS}/wait-step.js wait --id ${sq(id)} --max 270
   (Bash with timeout 300000 ms; it blocks up to 270 s and prints JSON). While the JSON says "done":false (the run is alive: "alive":true), run the same command 2 again, nothing else in between, whatever the tail, the queue position or the time that has passed: an unchanged tail, a long wait or a queue position that does not move is not a reason to stop - the run may wait hours for a memory slot, and wait-step itself ends a hung run at its deadline. Never run the command of step 1 twice.
3. Return the schema only once the JSON says "done":true: its fields (done, rc, seconds, log, tail, alive, pid, error) exactly as printed - do not describe or judge the result. Never return "done":false yourself, except when a command printed no JSON:
If a command fails without JSON - done=false, rc=null, log=${sq(id + '.log')}, error = the error text.`,
  checkOpts(`run:${t.key}:${step}`, 'Full run', RUN_SCHEMA, retry))
}
const ranStep = (r) => !!(r && typeof r.rc === 'number')
// Exit codes of the full run step that are the environment, not the product (p-wait D1; coordinator 2026-10-24): the
// step's deadline, and the refusals of the slot queue before the run (scripts/slots.zsh, guards-all.sh). A project
// runner that itself exits with one of them is taken for the environment too (README). Without this they went to the
// programmer as a red run (#nf) with nothing to fix.
const ENV_RC = {
  124: 'the deadline of the wait step passed - the run was killed with its process group',
  77: 'the slot queue refused the run: the slot directory is not writable',
  78: 'the run was refused before it started: slot or project config, swap below its floor, or the main working copy',
  72: 'the run was refused before it started: no ps or pgrep',
  73: 'the run was refused before it started: mktemp failed',
}
const envFull = (tag, r) => {
  const why = `exit ${r.rc}: ${ENV_RC[r.rc]}${r.error ? ` (${r.error})` : ''}; log ${r.log}`
  return { fail: `full run after programmer ${tag}: red from the environment, not the product - ${why}`, environment: why, full: fullLine(r) }
}
const runStep = async (t, step, cmd) => (await checkTwice(t, `wait step ${step}`, ranStep, (retry) => runStep1(t, step, cmd, retry))).res
// '' when the step ran (any numeric exit code), otherwise why it could not: that goes to the coordinator.
const runFail = (step, r) => (!r ? `the wait step ${step} returned no result`
  : !ranStep(r) ? `the wait step ${step} could not run: ${r.error || 'no exit code'} (log ${r.log})` : '')
// Full run of the worktree; the log of guards-all.sh is copied next to the step log, since the next run overwrites it.
const fullStep = async (t, n) => {
  const step = `full-${n}`
  const copy = `${t.dir}/wait-${step}.guards.txt`
  const r = await runStep(t, step, `${SCRIPTS}/guards-all.sh ${sq(t.gdir)}; rc=$?; cp ${sq(`${CFG.sharedDir}/guards-${gname(t)}.txt`)} ${sq(copy)} 2>/dev/null; exit $rc`)
  const f = runFail(step, r)
  return f ? { fail: f } : Object.assign({}, r, { guards: copy })
}
const fullLine = (r) => (r ? `exit ${r.rc}; summary ${r.log}, full log ${r.guards}` : 'none on this HEAD')
const MAX_FULL_FIX = 2

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
// The use cases of a task: {path?, first?} or {error}. A path lies where an analysis may (the task's or feature's folder).
function useCasesOf(t) {
  if (t.useCasesFirst !== undefined) {
    if (t.useCasesFirst !== true) return { error: 'useCasesFirst must be true' }
    if (t.useCases !== undefined) return { error: 'useCasesFirst with useCases: the use cases are written already - drop useCasesFirst' }
    // analysisOf has already checked exactly one marker, so without analysis and noAnalysis it is analystFirst: true.
    if (t.analysis !== undefined || t.noAnalysis !== undefined) return { error: 'useCasesFirst goes with analystFirst alone: the analyst writes the use cases first' }
    return { first: true, path: `${t.dir}/use-cases.md` }
  }
  if (t.useCases === undefined) return {}
  const p = nonBlank(t.useCases) ? t.useCases.trim() : ''
  const where = ownFolders(t)
  if (!p) return { error: 'useCases must be a non-empty path' }
  if (t.specs.map((x) => x.trim()).includes(p)) return { error: `useCases ${p} is the arc specification of this task (spec)` }
  if (!p.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(p) || !where.some((d) => p.startsWith(d))) return { error: `useCases ${p} is not an absolute path inside ${where.join(' or ')}` }
  return { path: p }
}
// The mode of a task: {light} or {error}. Light (rules: "Light mode for small tasks"): up to ~100 lines of product, one
// subsystem, no attack surface, no acceptance in a Docker stack - so security work and a task stack are refused here.
function modeOf(t) {
  if (t.mode === undefined || t.mode === 'full') return { light: false }
  if (t.mode !== 'light') return { error: `mode must be "full" (the default) or "light", not ${JSON.stringify(t.mode)}` }
  if (t.security) return { error: 'mode light is not for security work (security): run it in the full mode with a tester and a security reviewer' }
  if (t.stack) return { error: 'mode light has no acceptance in a Docker stack (stack): run it in the full mode with a tester' }
  return { light: true }
}
const analysisLine = (a) => (a.mode === 'none' ? `No analysis: ${a.reason}` : `The analysis to follow: ${a.path}`)

// Paths a fix "for docs" may touch without a tester round: docs, and guards and fixtures (guard wording; the paths the
// tester may change, config testerWritable). A fix touching anything else - a comment in product code - is confirmed
// by the second review on the diff of the fix (fixBehaviourUnchanged), not by a tester round. Before 2026-10-19 only
// .md and docs/ counted, so a stale comment in a .js or .html file sent 4 of 5 such rejections through the tester.
const DOCS_PATH = /(\.md$)|(^|\/)docs\//
const GUARD_PATHS = (CFG.testerWritable || []).map((r) => new RegExp(r))
const docsOrGuard = (f) => DOCS_PATH.test(f) || GUARD_PATHS.some((re) => re.test(f))
const stop = (t, why, extra) => Object.assign({ task: t.key, status: 'stopped', why }, extra || {})

// What the preconditions check about the task's own analysis: an arc specification passed as the task's analysis, or a
// noAnalysis reason that only points to it, is not an analysis of the task (rules: "Analyst or diagnoser").
const preAnalysis = (t) => (t.an.mode === 'reused'
  ? ` the reused analysis ${t.an.path} exists, is non-empty and is a matrix of cases or a diagnosis written for this task (or for the feature it was split from), not a specification of the whole arc;`
  : t.an.mode === 'none'
    ? ` the noAnalysis reason "${t.an.reason}" says why this task needs no matrix of its own (a tail, a one-line fix, a rename); "the arc specification covers it" is not such a reason;`
    : '')
const pre = (t) => agent(`You check PRECONDITIONS (read only, change nothing). ${RULES(t)}
Check: ${t.dir}/BRIEF.md exists and contains an acceptance scenario in the real environment;${preAnalysis(t)}${t.uc ? ` the use cases ${t.uc} exist, are non-empty and have no open questions to the owner left unanswered (they were reviewed with the owner);` : ''}${t.specs.length ? ` the arc specification ${t.specs.join(', ')} exists;` : ''} ${t.wt} exists and is on branch ${t.branch}; there are no uncommitted changes (except untracked build output or probes); the brief has no unanswered questions to the owner on which acceptance depends; the environment has room: run node ${SCRIPTS}/env-check.js --path ${sq(t.wt)} --path ${sq(t.dir)} --worktree ${sq(t.wt)} --min-disk-gb ${ENV.minFreeDiskGB} --min-swap-mb ${ENV.swapMinMB} (free disk and swap headroom; the worktree is not the main working copy of its repository) and copy its problems. ok=false if any of this fails.`,
  Object.assign({ label: `pre:${t.key}`, phase: 'Preconditions', schema: PRE_SCHEMA, effort: 'low', agentType: 'general-purpose' }, modelOf('preconditions')))

const analyst = (t, why) => agent(`You are the ANALYST/DIAGNOSER (read code only; you write only ${t.dir}/analyst.md). ${RULES(t)}
Reason: ${why}
Write a matrix of cases (every dimension: states x events x environments) or find the cause of the defect with file:line. Count the cells and subsystems. If by the rule "Split the task" the task must be split, propose subtasks and do not declare ready. Every cell has an expected result and a basis (the brief, documentation, an experiment); no thresholds or name lists.${t.uc ? ` Build the matrix on the use cases ${t.uc}: every cell cites its use case (UC-n and the flow step); a flow without cells is a gap.` : ''}${note('analyst')}`,
  Object.assign({ label: `analyst:${t.key}`, phase: 'Analyst', schema: ANALYST_SCHEMA, agentType: roleType('analyst') }, modelOf('analyst')))

// First step of a feature with useCasesFirst: the use cases alone, then the task stops for the review with the owner.
const ucAnalyst = (t, p) => agent(`You are the ANALYST, first step of a feature: USE CASES (read the brief and the code; you write only ${p}). ${RULES(t)}
Write the use cases of the feature before any matrix of cases or spec. One section per use case:
## UC-<n>. <name>
- Actor: who acts (a person in a role, the system, another service).
- Trigger: what starts it.
- Preconditions: what holds before it starts.
- Main flow: numbered steps, the actor and the system in turn.
- Alternative flows: <n>a, <n>b, ... - each branches from a step of the main flow and says where it rejoins or ends (also the flows where a person and an AI or another actor hand work back and forth).
- Errors: what can fail at each step and what the actor sees then.
- Out of scope: what this use case deliberately does not cover.
End the file with "Open questions to the owner": one numbered list, each question with your recommendation; put the same list into questions. ready=true when every use case has all sections. Do not write a matrix of cases and do not answer the questions yourself: the task stops here, and the coordinator reviews the use cases with the owner.${note('analyst')}`,
  Object.assign({ label: `usecases:${t.key}`, phase: 'Analyst', schema: USECASES_SCHEMA, agentType: roleType('analyst') }, modelOf('analyst')))

// What the programmer runs after the mutations: nothing more (ONE_RUN: the workflow's full run includes the selection) or
// the full run itself.
const guardsPart = (t) => (ONE_RUN
  ? `no selection of guards and no full run of your own: do NOT run the full guard run yourself - after you return, the workflow runs ${SCRIPTS}/guards-all.sh ${t.gdir} once on your HEAD (it includes the selected guards) and hands you the log only if it is red (fullRun = "the workflow runs it" and the result of your new guards)`
  : `full run ${SCRIPTS}/guards-all.sh ${t.gdir} in the background -> analysis of new reds that repeated alone (flaky ones go into prog.md for the backlog)`)
// A fix round (p-fixround, audit P5: a fix round is a new agent that reread the brief, analyst.md, prog.md and test.md
// - 33 % of its input; its mutations covered every guard again): it reads the findings and the task's diff, the brief and
// analysis only in the cited sections, and mutates only the guards of this round, the guards the findings name and those
// over product code changed in it (review 1). fix = { report, before }: the report
// with the findings and the HEAD before the round (the previous role's); the first round passes none.
const fixPart = (t, n, fix) => (fix ? `\nFix round ${n} (not the first): do not reread the whole task. Read the findings of this round in ${fix.report} and the task's diff (git -C ${sq(t.wt)} log --oneline ${baseArg(t)}..HEAD, git -C ${sq(t.wt)} diff ${baseArg(t)}..HEAD); read BRIEF.md, the analysis and the arc specification only in the sections the findings cite, and of prog.md only its last round. Mutations in this round only for the guards new or changed in it (git -C ${sq(t.wt)} diff --name-only ${fix.before ? sq(fix.before) : '<the HEAD before this round>'}..HEAD after your commits), the guards the findings name (a finding "guard G has no mutation" is fixed by mutating G) and the guards that cover the product code changed in it (a fix under an unchanged guard is still mutation-tested): a table of this round's mutants; the tables of earlier rounds stay as they are.` : '')
const prog = (t, task, n, fix) => (t.light ? progLight(t, task, n, fix) : agent(`You are the PROGRAMMER. ${RULES(t)} Report: ${t.dir}/prog.md (round ${n}).
${analysisLine(t.an)}
${task}${fixPart(t, n, fix)}
Order: red guard -> commit -> code -> commit -> mutations AFTER the commit (table in prog.md) -> ${guardsPart(t)}. status=blocked if you cannot go on without the owner's answer.${note('programmer')}`,
  Object.assign({ label: `prog:${t.key}#${n}`, phase: 'Programmer', schema: PROG_SCHEMA, agentType: roleType('programmer') }, modelOf('programmer'))))
// Light mode: one programmer-checker does the programmer's work and the tester's acceptance; the reviewer follows.
const progLight = (t, task, n, fix) => agent(`You are the PROGRAMMER-CHECKER of a task in the light mode: there is no tester role, so you also run the acceptance. ${RULES(t)} Reports: ${t.dir}/prog.md (round ${n}) and ${t.dir}/test.md (your acceptance, round ${n}; keep earlier rounds).
${analysisLine(t.an)}
${task}${fixPart(t, n, fix)}
Order: red guard -> commit -> code -> commit -> mutations AFTER the commit (table in prog.md) -> ${guardsPart(t)} -> your own acceptance in the real environment: ${t.accept} Evidence (logs, numbers, screenshots) goes into ${t.dir}/test.md and files with the prefix test-; put the result and where its evidence is into acceptance. status=ready only when the acceptance is met; status=blocked if you cannot go on without the owner's answer.${note('programmer')}`,
  Object.assign({ label: `prog:${t.key}#${n}`, phase: 'Programmer', schema: PROG_SCHEMA, agentType: roleType('programmer') }, modelOf('programmer')))

// Acceptance on the project's shared stand (config stand, scripts/stand.sh): image-diff decides whether it fits.
const standSteps = (t) => (CFG.stand && CFG.stand.project ? ` On the project's shared stand ${CFG.stand.project}: (a) ${SCRIPTS}/stand.sh image-diff --wt ${sq(t.wt)} --base <the commit this task branched from> - exit 0: the stand fits, exit 1: the task changes the stand's image files and needs ${t.stack ? 'its own stack (below)' : 'its own stack: write "❓ coordinator: own stack needed, image files changed" into test.md and give the verdict environment'}; (b) ${SCRIPTS}/stand.sh take --wt ${sq(t.wt)} with run_in_background - it waits in the queue ("position N") and then holds the ticket while it runs: wait (Monitor, slices of at most 270 s) for its line "ticket taken by"; (c) ${SCRIPTS}/stand.sh deploy ${sq(t.wt)} (your committed HEAD; it runs in a medium slot); (d) the scenario against the stand; (e) ${SCRIPTS}/stand.sh release --wt ${sq(t.wt)} as soon as the evidence is saved, also after a red (the next tester waits for it). A take refused with "not up" or "reset failed" is an environment red for the coordinator.` : '')
const test = (t, n, st) => agent(`You are the TESTER. You do not change product code. ${RULES(t)} Report: ${t.dir}/test.md (round ${n}; keep earlier rounds).
1. An independent inventory before reading the diff (inputs, places, cells) - compare it with the programmer's coverage.
2. Your own guards for what is not covered -> commit -> mutations after the commit.
3. Acceptance in the real environment: ${t.accept}${standSteps(t)}${t.stack ? ` ${CFG.stand && CFG.stand.project ? 'Only when the stand does not fit, your' : 'Your'} own stack: docker compose -p ${t.stack}; afterwards remove it with its images and volumes: docker compose -p ${t.stack} down -v --rmi all.` : ''} Evidence (logs, numbers, screenshots) goes into ${t.dir} with the prefix test-.${t.uc ? ` Build the acceptance along the flows of the use cases (the main flow, every alternative flow, all errors): ${t.uc}.` : ''}
4. ${ONE_RUN ? `Do NOT run the full guard run: the workflow ran it once on the programmer's HEAD (${fullLine(st && st.full)}); reuse its log. Run your new and touched guards and mutations; if you commit guards, run them and the selection (${selectCmd(t)}), not the full suite.` : "Do not repeat the programmer's full run: new and touched guards and mutations; a full run only after your own commits."}
green - only if the brief's acceptance is met in full. red - the product fails a guard or the acceptance.
environment - red that the product did not cause, so a programmer has nothing to fix: your or the programmer's full run cut off before its tally (killed, timed out, out of memory), the slot queue refused your heavy job (heavy.sh or guards-all.sh exited 77 or 78) or your waiting process vanished without an exit code - while your heavy.sh, started with run_in_background, is alive in the queue, keep waiting in slices: a long queue is not the environment -, disk or swap exhausted (node ${SCRIPTS}/env-check.js --path ${sq(t.wt)} --min-disk-gb ${ENV.minFreeDiskGB} --min-swap-mb ${ENV.swapMinMB}), Docker or your stack down for a reason outside the task's code. Put the cause and its evidence into environment; the task stops for the coordinator. Never use it for a red that the product causes.${note('tester')}`,
  Object.assign({ label: `test:${t.key}#${n}`, phase: 'Tester', schema: TEST_SCHEMA, agentType: roleType('tester') }, modelOf('tester')))

const review = (t, n, scope) => agent(`You are the REVIEWER (read only; you may rerun guards). ${RULES(t)} Report: ${t.dir}/review.md (round ${n}).
Read BRIEF.md, analyst.md (if any), prog.md, test.md, git log/diff of branch ${t.branch} for the task${scope ? ' - ' + scope : ''}. Try to refute "done": cells of the matrix,${t.uc ? ` the alternative flows and errors of the use cases ${t.uc} (closed, not only the main flow),` : ''} guesses instead of data (thresholds, name lists), guards without mutations, the tester's evidence against the acceptance scenario (do not rerun the scenario).${t.light ? ` This task runs in the light mode: there is no tester role; the programmer-checker ran the acceptance - check its evidence in ${t.dir}/test.md against the acceptance scenario and its mutation table in prog.md.` : ''} Verdict with file:line.${note('reviewer')}`,
  Object.assign({ label: `review:${t.key}#${n}`, phase: 'Reviewer', schema: REVIEW_SCHEMA, agentType: roleType('reviewer') }, modelOf('reviewer')))

const secReview = (t, n, scope) => agent(`You are the SECURITY REVIEWER (read only; you may rerun guards). ${RULES(t)} Report: ${t.dir}/review-sec.md (round ${n}).
The brief marks the task as security work. Read BRIEF.md, ${CFG.threatModel ? `the threat model ${t.wt}/${CFG.threatModel}, ` : ''}git diff of branch ${t.branch} for the task${scope ? ' - ' + scope : ''}, test.md. Look with an attacker's eyes: access by a guest and by another owner, swapped ids, malformed input, secrets (model keys, passes) leaking into responses, logs, postMessage, UI; does the tester have refusal guards for every input, and are they mutation-tested. Verdict with file:line; docsOnly - only if the findings concern docs, guard wording or comments alone.${note('security-reviewer')}`,
  Object.assign({ label: `sec:${t.key}#${n}`, phase: 'Reviewer', schema: REVIEW_SCHEMA, agentType: roleType('security-reviewer') }, modelOf('security-reviewer')))

// Programmer -> tester (red -> programmer again, without review), up to maxRounds tester rounds.
// st.head - HEAD after the last committing role; the next role's post-check starts from it.
async function testChecked(t, st, n) {
  const tr = await test(t, n, st)
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
    fixBehaviourUnchanged: rv.fixBehaviourUnchanged === true && sv.fixBehaviourUnchanged === true,
    summary: `Reviewer (${rv.verdict}): ${rv.summary}\nSecurity (${sv.verdict}, ${t.dir}/review-sec.md): ${sv.summary}`,
  } }
}

// A red from the environment goes to the coordinator, not to a programmer: a programmer round "without changes" cost
// about 3.3M tokens in one window (cut-off full runs, a full disk, no heavy slot).
const envStop = (round, tr) => ({ fail: `tester ${round}: red from the environment, not the product - ${tr.environment || tr.summary || '?'}`,
  environment: tr.environment || tr.summary || '', test: tr.summary })

const envProg = (n, p) => ({ fail: `programmer ${n}: red from the environment, not the product - ${p.summary || '?'}`, environment: p.summary || '' })
const docsOrGuardOnly = (p) => (p.changedFiles || []).length > 0 && p.changedFiles.every(docsOrGuard)

// A programmer round. With ONE_RUN the full run follows it on the new HEAD: red -> a programmer round with the log
// (fix and commit, or explain and change nothing), then the run again, at most MAX_FULL_FIX rounds. No new run on a
// HEAD whose full run is done (st.fullAt), and none after a fix of docs and guard files only once a full run was done:
// the product did not change and the programmer ran the touched guards.
async function progStep(t, st, task, n, report) {
  const p = await prog(t, task, n, report ? { report, before: st.head } : null)
  if (!p) return { fail: 'the programmer returned no result' }
  if (p.status === 'blocked') return { fail: 'programmer: an answer is needed', questions: p.questions }
  if (p.status === 'environment') return envProg(n, p)
  st.head = p.head
  if (!ONE_RUN) return { p }
  if (st.fullAt && docsOrGuardOnly(p)) { log(`${t.title}: round ${n} changed only docs and guard files - no full run`); return { p } }
  let merged = p, tag = n
  for (let k = 0; ; k++) {
    if (st.fullAt && st.head === st.fullAt) { log(`${t.title}: the full run on ${st.head} is done - not repeated`); return { p: merged } }
    const full = await fullStep(t, tag)
    if (full.fail) return full
    st.full = full; st.fullAt = st.head
    log(`${t.title}: full run after programmer ${tag} - exit ${full.rc}`)
    if (full.rc === 0) return { p: merged }
    if (ENV_RC[full.rc]) return envFull(tag, full)
    if (k === MAX_FULL_FIX) return { fail: `the full guard run is still red after ${k} programmer rounds with its log (exit ${full.rc}, ${full.log})`, full: fullLine(full) }
    const p2 = await prog(t, `The full guard run the workflow ran on your HEAD after round ${tag} exited ${full.rc}: summary ${full.log}, full log ${full.guards}. Analyse every new red that repeated alone: fix what your change caused (commit, mutations after the commit, your new guards); a known red or a flaky guard - explain it in prog.md and change nothing; a red from the environment (the run cut off before its tally, a refusal of the slot queue - exit 77 or 78 - disk or swap) - status=environment with the evidence. Do not run the full run yourself: if you commit, the workflow runs it again.\n${full.tail || ''}`, `${tag}f`, { report: `${full.log} (summary) and ${full.guards} (full log)`, before: st.head })
    if (!p2) return { fail: 'the programmer returned no result' }
    if (p2.status === 'blocked') return { fail: 'programmer: an answer is needed', questions: p2.questions }
    if (p2.status === 'environment') return envProg(`${tag}f`, p2)
    merged = Object.assign({}, p2, { changedFiles: (merged.changedFiles || []).concat((p2.changedFiles || []).filter((f) => !(merged.changedFiles || []).includes(f))) })
    tag = `${tag}f`
    if (p2.head === st.head) { log(`${t.title}: the red of the full run explained without a commit - the next role gets its log`); return { p: merged } }
    st.head = p2.head
  }
}

// Red tester rounds for the product are counted per task (st.reds; environment reds never reach here). The second one,
// in any cells, sends the task to the analyst inside the same run (redAnalyst in work()); a red after that analyst stops
// the task for the coordinator. Only one analyst runs inside a run: after the analyst of the second rejection
// (st.analyst = 'rejection') the tester rounds stay as before. Why: cvm-xy-1 (2026-10-23) - four tester -> programmer
// rounds in a row, each red opening a new cell of a matrix nobody had written; the count stood only on rejections.
function testerRed(t, st, round, tr) {
  st.reds = (st.reds || 0) + 1
  if (st.analyst === 'tester-red') return { fail: `tester red after analyst (round ${round})`, stopWhy: 'tester red after analyst', test: tr.summary }
  if (!st.analyst && st.reds >= 2) { log(`${t.title}: tester ${round} - the second red tester round for the product - analyst`); return { redAnalyst: true, test: tr.summary } }
  return null
}

async function buildAndTest(t, st, firstTask, tag, maxRounds) {
  const s1 = await progStep(t, st, firstTask, `${tag}1`)
  if (s1.fail) return s1
  for (let r = 1; r <= maxRounds; r++) {
    const x = await testChecked(t, st, `${tag}${r}`)
    if (x.fail) return x
    const tr = x.tr
    log(`${t.title}: tester ${tag}${r} - ${tr.verdict}`)
    if (tr.verdict === 'green') return { ok: tr }
    if (tr.verdict === 'environment') return envStop(`${tag}${r}`, tr)
    const red = testerRed(t, st, `${tag}${r}`, tr)
    if (red) return red
    if (r === maxRounds) return { fail: `${maxRounds} red tester rounds`, test: tr.summary }
    const s = await progStep(t, st, `Tester round ${tag}${r} - red. Fix according to ${t.dir}/test.md:\n${tr.summary}`, `${tag}${r + 1}`, `${t.dir}/test.md`)
    if (s.fail) return s
  }
}

// Review; rejection -> fix. A rejection for docs only goes programmer -> second review of the diff of the fix, without a
// tester: when the fix touches only docs and guard files, by the changed paths; when it touches other files (a comment
// in product code), the second review confirms fixBehaviourUnchanged, and only an unconfirmed fix gets a tester round.
// A rejection for code: tester, then the second review.
async function reviewLoop(t, st, tag) {
  const x1 = await reviewChecked(t, st, `${tag}1`)
  if (x1.fail) return x1
  const r1 = x1.rv
  log(`${t.title}: review ${tag}1 - ${r1.verdict}`)
  if (r1.verdict === 'done') return { ok: r1 }
  const before = st.head
  const sp = await progStep(t, st, `Review ${tag}1 - rejected${r1.docsOnly ? ' for docs only: fix the docs, guard wording or comments it names and change no behaviour' : ''}. Fix according to ${t.dir}/review.md:\n${r1.summary}`, `${tag}r`, `${t.dir}/review.md`)
  if (sp.fail) return sp
  const p = sp.p
  const testAfter = async () => {
    const xt = await testChecked(t, st, `${tag}after-review`)
    if (xt.fail) return xt
    const tr = xt.tr
    if (tr.verdict === 'environment') return Object.assign(envStop(`${tag}after-review`, tr), { review: r1.summary })
    if (tr.verdict !== 'green') return Object.assign(testerRed(t, st, `${tag}after-review`, tr) || { fail: 'tester after the review fix - red', test: tr.summary }, { review: r1.summary })
    return {}
  }
  const changed = p.changedFiles || []
  const byPaths = r1.docsOnly && changed.length > 0 && changed.every(docsOrGuard)
  const other = changed.filter((f) => !docsOrGuard(f))
  if (!r1.docsOnly) {
    const xt = await testAfter()
    if (xt.fail || xt.redAnalyst) return xt
  }
  const scope = !r1.docsOnly ? ''
    : `only the diff of the fix after review 1 (git diff ${before}..${p.head})${byPaths ? '' : `; it touches files outside docs and guards (${other.join(', ') || 'none reported'}): set fixBehaviourUnchanged=true only if that diff changes comments, wording or docs alone and no behaviour`}`
  const x2 = await reviewChecked(t, st, `${tag}2`, scope)
  if (x2.fail) return x2
  const r2 = x2.rv
  log(`${t.title}: review ${tag}2 - ${r2.verdict}`)
  if (r2.verdict !== 'done') return { fail: 'second review rejection', second: true, docsOnly: r2.docsOnly, review: r2.summary }
  if (r1.docsOnly && !byPaths && r2.fixBehaviourUnchanged !== true) {
    log(`${t.title}: rejected "for docs", the fix touches ${other.join(', ') || 'unreported files'} and the review did not confirm it changes no behaviour - tester round`)
    const xt = await testAfter()
    if (xt.fail || xt.redAnalyst) return xt
  }
  return { ok: r2 }
}

// After the preconditions every outcome passes the leftovers post-check; removed leftovers are named in the result.
// The analysis marker is checked before any agent; from then on every result carries it (analysis).
async function chain(t0) {
  if (TESTER_WRITABLE_MISSING) return stop(t0, 'preconditions', { problems: [TESTER_WRITABLE_MISSING], questions: [TESTER_WRITABLE_MISSING] })
  const an = analysisOf(t0)
  if (an.error) return stop(t0, 'preconditions', { problems: [an.error], questions: [an.error] })
  const uc = useCasesOf(t0)
  if (uc.error) return stop(t0, 'preconditions', { problems: [uc.error], questions: [uc.error] })
  const md = modeOf(t0)
  if (md.error) return stop(t0, 'preconditions', { problems: [md.error], questions: [md.error] })
  const t = Object.assign({}, t0, { an, uc: uc.first ? '' : uc.path || '', ucFirst: uc.first ? uc.path : '', light: md.light })
  const withAn = (r) => Object.assign({}, r, { analysis: an }, nonBlank(t0.feature) ? { feature: t0.feature.trim() } : {}, md.light ? { mode: 'light' } : {},
    uc.path && !r.useCases ? { useCases: uc.path } : {})
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

  if (t.ucFirst) {
    const u = await ucAnalyst(t, t.ucFirst)
    if (!u) return stop(t, 'the use cases analyst returned no result')
    if (!u.ready) return stop(t, 'use cases analyst: the use cases are not ready', { questions: u.questions, analyst: u.summary })
    return { task: t.key, status: 'use-cases-review', useCases: t.ucFirst, questions: u.questions, analyst: u.summary,
      why: `use cases written: review the use cases with the owner (their open questions as one list), then relaunch the task with the useCases field set to this file and analystFirst - the matrix of cases is built on them` }
  }
  if (t.an.mode === 'run') {
    const a = await analyst(t, 'the task needs a spec or a diagnosis before code (brief: analystFirst)')
    if (!a) return stop(t, 'the analyst returned no result')
    if (!a.ready || a.split.length || a.questions.length) return stop(t, 'analyst: split the task or an answer is needed', { split: a.split, questions: a.questions, analyst: a.summary })
  } else log(t.an.mode === 'reused' ? `${t.title}: analyst reused - ${t.an.path}` : `${t.title}: no analyst - ${t.an.reason}`)

  if (t.light) return light(t, st)
  const b = await buildAndTest(t, st, t.start || 'Start with red guards for the cells of the brief (and analyst.md, if any).', '', 3)
  if (b.redAnalyst) return afterRedAnalyst(t, st, b)
  if (b.fail) return stop(t, b.fail, b)
  const rv = await reviewLoop(t, st, '')
  if (rv.ok) return { task: t.key, status: 'done', review: rv.ok.summary }
  if (rv.redAnalyst) return afterRedAnalyst(t, st, rv)
  if (!rv.second || rv.docsOnly) return stop(t, rv.fail, rv)

  // Second rejection for code -> analyst in the same run, then one full round; a third rejection goes to the coordinator.
  st.analyst = 'rejection'
  const a = await analyst(t, `second review rejection for code:\n${rv.review}`)
  if (!a) return stop(t, 'the analyst returned no result')
  if (!a.ready || a.split.length || a.questions.length) return stop(t, 'analyst after the second rejection: split or an answer is needed', { split: a.split, questions: a.questions, analyst: a.summary })
  const b2 = await buildAndTest(t, st, `After the second review rejection the analyst wrote ${t.dir}/analyst.md - fix according to it and to review.md.`, 'A', 2)
  if (b2.fail) return stop(t, `after the analyst: ${b2.fail}`, b2)
  const rv2 = await reviewLoop(t, st, 'A')
  if (rv2.ok) return { task: t.key, status: 'done', review: rv2.ok.summary }
  return stop(t, `after the analyst: ${rv2.fail}`, rv2)
}

// Second red tester round for the product -> analyst in the same run: a matrix of cases from the tester's findings
// (test.md) and their cause (prog.md), then one round programmer -> tester -> review on it; a red tester round after it
// stops the task (why 'tester red after analyst'), and so does a second rejection after it.
async function afterRedAnalyst(t, st, x) {
  st.analyst = 'tester-red'
  const a = await analyst(t, `the second red tester round for the product in this task (rule "Red tester rounds are counted per task"). Inputs: the tester's findings in ${t.dir}/test.md (every round) and the programmer's rounds in ${t.dir}/prog.md. Write the matrix of cases those findings belong to - every dimension the reds opened, not only the failed cells - and the cause of the reds with file:line, so the next programmer round closes the whole matrix at once. Last red:\n${x.test || ''}`)
  if (!a) return stop(t, 'the analyst returned no result')
  if (!a.ready || a.split.length || a.questions.length) return stop(t, 'analyst after the second red tester round: split or an answer is needed', { split: a.split, questions: a.questions, analyst: a.summary })
  const b = await buildAndTest(t, st, `After the second red tester round the analyst wrote ${t.dir}/analyst.md - a matrix of cases from the tester's findings: red guards for its cells, then the fix of every cell, according to it and to ${t.dir}/test.md.`, 'T', 1)
  if (b.fail) return stop(t, b.stopWhy || `after the analyst: ${b.fail}`, b)
  const rv = await reviewLoop(t, st, 'T')
  if (rv.ok) return { task: t.key, status: 'done', review: rv.ok.summary }
  return stop(t, rv.stopWhy || `after the analyst: ${rv.fail}`, rv)
}

// Light mode (owner 2026-10-20): programmer-checker -> the full run step -> reviewer; no tester role, so no tester
// post-checks (the reviewer's git post-check and the leftovers check at the end run as usual). A rejection -> one
// programmer round (and the full run if it committed) -> the second review; a second rejection goes to the coordinator
// with the proposal to relaunch in the full mode. Why: tasks of up to 100 lines of product took 2-2.6 h through the
// chain against about 0.6 h in one session (measurement 2026-10-20).
async function light(t, st) {
  const s1 = await progStep(t, st, t.start || 'Start with red guards for the cells of the brief (and analyst.md, if any).', '1')
  if (s1.fail) return stop(t, s1.fail, s1)
  const x1 = await reviewChecked(t, st, '1')
  if (x1.fail) return stop(t, x1.fail, x1)
  log(`${t.title}: review 1 (light) - ${x1.rv.verdict}`)
  if (x1.rv.verdict === 'done') return { task: t.key, status: 'done', review: x1.rv.summary }
  const before = st.head
  const s2 = await progStep(t, st, `Review 1 - rejected${x1.rv.docsOnly ? ' for docs only: fix the docs, guard wording or comments it names and change no behaviour' : ''}. Fix according to ${t.dir}/review.md, and run the acceptance again if the fix touches what it checks:\n${x1.rv.summary}`, 'r', `${t.dir}/review.md`)
  if (s2.fail) return stop(t, s2.fail, Object.assign({}, s2, { review: x1.rv.summary }))
  const x2 = await reviewChecked(t, st, '2', `the fix after review 1 (git diff ${before}..${st.head}) and whether review 1 is answered`)
  if (x2.fail) return stop(t, x2.fail, x2)
  log(`${t.title}: review 2 (light) - ${x2.rv.verdict}`)
  if (x2.rv.verdict === 'done') return { task: t.key, status: 'done', review: x2.rv.summary }
  return stop(t, 'second review rejection in the light mode: the coordinator relaunches the task in the full mode (drop mode "light": tester, analyst after a second rejection)',
    { second: true, docsOnly: x2.rv.docsOnly, review: x2.rv.summary })
}

const results = await pipeline(TASKS, (t) => chain(t))
return results.map((r, i) => r || stop(TASKS[i], 'the chain crashed'))
