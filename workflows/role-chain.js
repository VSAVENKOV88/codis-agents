export const meta = {
  name: 'role-chain',
  description: 'Role chain over tasks in parallel: preconditions -> (analyst) -> programmer -> tester -> reviewer (+ security reviewer); fix rounds; an analyst after the second rejection or the second red tester round',
  whenToUse: 'Started by the codis-agents:role-chain skill, which reads .claude/codis-agents.json and passes it. args: {owner: "the owner\'s request, verbatim", config: <resolved project config>, tasks: [{key, title, wt, branch, accept, dir?, gdir?, start?, kind: feature | defect | tail (exactly one), analystFirst | analysis | noAnalysis (exactly one), feature?, spec?, useCases?, useCasesFirst?, stack?, security?, base?, mode?, prior?}]}; with guardSubsetCommand a reviewed task rides the integration train (scripts/train.js ride) before it is done',
  phases: [
    { title: 'Preconditions', detail: 'brief, worktree, branch, open questions' },
    { title: 'Analyst', detail: 'matrix of cases or a diagnosis (before the programmer, after the second rejection, or after the second red tester round)' },
    { title: 'Programmer', detail: 'red guard -> code -> mutations (-> its own full guard run without guardSubsetCommand)' },
    { title: 'Selection', detail: 'the guards of the task\'s diff on every new programmer HEAD, run by the workflow as a wait step (no full guard run in the task; none with innerSelect false)' },
    { title: 'Tester', detail: 'independent inventory, own guards, acceptance in the real environment' },
    { title: 'Reviewer', detail: 'read only, tries to refute' },
    { title: 'Train', detail: 'with guardSubsetCommand: the branch rides the integration train after the review (train.js ride as a wait step); red, seam or conflict -> a fix round' },
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
// Kind of the task - exactly one `kind`: feature, defect or tail (p-train-a1, K1-K7). Without it, or with any other
// value (another string, a list, a blank), the task stops on preconditions before any agent, with no guess from its
// other fields. A feature starts only with use cases - useCasesFirst (with analystFirst) or useCases; a feature without
// either stops before any agent too, so no tokens are spent on it. A defect or a tail needs no use cases (and may carry
// them). Why: a feature started without use cases had its questions born during the task (see below).
// Use cases (rules: "Use cases before the matrix"): useCases - absolute path of the feature's use-cases.md, inside the
// task's or the feature's folder like analysis; every role gets it as context, the analyst's matrix cites it, the tester
// builds acceptance along its flows, the reviewer checks its alternative flows and errors. useCasesFirst (true, with
// analystFirst): the analyst writes only <dir>/use-cases.md with its open questions and the task stops with status
// use-cases-review; after the review with the owner the coordinator relaunches it with useCases and analystFirst.
// Why: questions were born during the task, not before it (one task: ~40 questions to the coordinator on the way and
// 8 programmer rounds, almost all from one flow nobody had written down).
// base (the branch the task started from: scripts/guards-select.js diffs against its merge-base; with
// guardSubsetCommand it is required and is not a protected branch - the branch of the arc, coordinator's decision 6 of
// p-train-ac, 2026-10-29),
// mode ("full", the default, or "light": one programmer-checker, the selection step (INNER), one reviewer - see work()).
// prior (p-testerred-route): the counts of earlier runs of this task, for a relaunch - {testerReds?, trainReds?,
// rejections?, analyst?, mechanism?}, checked before any agent (priorOf); the result of every run carries them as counts
// (countsOf), seed included, so the coordinator copies counts into the next prior and recounts nothing. The counters of a task live in st, which every run starts empty, and
// the script reads no files, so without it a relaunch with start began every count from zero: in cvm-wheel-c (run
// wf_68338028-44b) the first red tester round of the relaunch was the second of the task and went to the programmer.

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
const gname = (t) => String(t.gdir).replace(/\/+$/, '').split('/').pop()
// No full guard run in the task (rules: "No full guard run in the task", p-train-a2; it replaces "One full guard run per
// task"): with guardSubsetCommand in the project config the workflow runs the selection of the task's guards
// (guards-all.sh --select <base>: scripts/guards-select.js over the diff against base, with the rerun of new reds alone,
// the known reds and the quarantine read only, on the remote runner with remoteRun.subsetCommand) as a wait step after
// every programmer round with a new HEAD; the programmer runs only its new guards and mutations; the tester, after its
// own commits, runs the selection of its own diff from the programmer's HEAD (testerSelectRun, p-tester-select: it
// changes only guards and fixtures, so the product guards of the task's selection are already green on the same code),
// and none without a commit. The one full run of the branch belongs to the integration train, not to the task. Without
// the key the programmer runs the full run itself, as before.
const ONE_RUN = typeof CFG.guardSubsetCommand === 'string' && CFG.guardSubsetCommand.trim() !== ''
// Only the train (p-train-only, owner 2026-11-01, translated: "1. Only the train, plus a short tester round after a red train"):
// with guardSubsetCommand and innerSelect false there is no selection inside the task at all - no wait step after a
// programmer round, no selection of the tester; the programmer and the tester run only their new or changed guards and
// mutations, and the train is the first run of all guards. A red train fixed in the product gets a short tester round
// before the second review (trainTester). innerSelect true or absent: the selection as before. Why (diagnosis
// train-only.md, 80 tasks): a selection found a real finding in 21 % of tasks while every task waited for it (a median of
// 32 min, 84-125 min under load); the runner at 6 tasks 94 % -> 65 %.
const INNER = ONE_RUN && CFG.innerSelect !== false
const baseArg = (t) => (nonBlankS(t.base) ? sq(t.base.trim()) : '<the branch or commit this task started from>')
const selectRun = (t) => `${SCRIPTS}/guards-all.sh --select ${baseArg(t)} ${sq(t.gdir)}`
// The tester's selection (p-tester-select, measured 2026-11-01: the repeated selection of the whole task took a median of
// 17.9 min of a task's path and the runner from 58 % to 85 % of its capacity): the diff of its own commits from the
// programmer's HEAD of its round (st.head before the tester), so its guards, the guards that import or name a fixture it
// changed and guardAlways run, not the task's product guards again.
const testerSelectRun = (t, head) => `${SCRIPTS}/guards-all.sh --select ${nonBlankS(head) ? sq(head.trim()) : "<the programmer's HEAD you started from>"} ${sq(t.gdir)}`
function nonBlankS(v) { return typeof v === 'string' && v.trim() !== '' }

// Rules that reach a role only through its prompt (rules/multi-agent.md: the pause and 200k rules worked once they
// were in the prompt). The id matches the marker <!-- role:<id> --> of a line in rules/multi-agent.md; local-* exist
// only in the chain. tests/role-chain.test.js fails when a marked line has no rule or a role prompt lacks one.
const RULE_LIST = (t) => [
  ['local-task', `Task "${t.title}". Brief: ${t.dir}/BRIEF.md (read all of it and the sections it refers to). Worktree ${t.wt}, branch ${t.branch}.${t.specs.length ? ` Arc specification (context of the surface; it is not this task's analysis): ${t.specs.join(', ')}.` : ''}${t.uc ? ` Use cases of the feature (actors, flows, alternative flows, errors): ${t.uc}.` : ''}`],
  ['scope', `The owner asked: "${OWNER}". Do only the task "${t.title}"; refuse neighbouring tasks and do not touch other worktrees.`],
  ['decisions', 'Only the coordinator writes the owner\'s decisions. An open question goes into your own report as a line "❓ coordinator: ..."; do not decide it yourself.'],
  ['pauses', `Pauses: never wait longer than 270 s at a time. A turn without a tool call ends your role - Monitor does not wake a workflow agent (its events reach you only as an attachment to your next request, and a turn of text alone makes no next request), so never end a turn with text like 'Waiting.': start anything long with Bash run_in_background, then wait for it with a blocking Bash loop (timeout 270000: until its log's final line appears or its process has died; do sleep 3; done) and repeat the loop, not with Monitor; an agent with no output for 10 minutes is killed. While your own process waits in a slot queue or runs, keep waiting in slices while your process is alive: do not end your work to wait (the chain has no status for it; ${INNER ? 'the selection of the task\'s guards after a programmer round' : ONE_RUN ? 'the integration train' : 'the one full guard run'} is waited for by the workflow, not by you).`],
  ['context', 'Context: past ~200k finish the current stage, write the report with "Next step: ..." and stop - a fresh agent continues.'],
  ['slots', `Heavy work goes through memory slots: ${SCRIPTS}/heavy.sh <cmd>, ${SCRIPTS}/medium.sh <cmd>, ${INNER ? `a selection of guards ${SCRIPTS}/guards-all.sh --select <ref> ${sq(t.gdir)} (the selection of the task from its base is run by the workflow, never by a role; a role runs only a selection its own instructions name - the tester the one of its own diff)` : ONE_RUN ? 'no selection and no full run of guards in the task (innerSelect false: the train runs them); a guard of your own that needs a browser or a bundler goes through heavy.sh' : `full guard run ${SCRIPTS}/guards-all.sh ${t.gdir}`}; start heavy.sh and guards-all.sh themselves only through Bash run_in_background, never as a blocking call (a blocking call to the heavy command itself is killed by the Bash timeout, its ticket dropped by the slot's trap, and it rejoins the queue at the end), then wait for it with a separate blocking Bash loop of at most 270 s (timeout 270000: until its log's final line appears or its process has died; do sleep 3; done) and repeat it - a turn without a tool call ends your role.`],
  ['rerun', ONE_RUN && !INNER
    ? `No role runs guards-all.sh in the task (innerSelect false): the integration train after the review reruns each new red of its full run alone; red again alone - the task's new red, which comes back to the programmer with the train's result; green alone - flaky, written into the project's quarantine by the train, not a regression.${CFG.guardBaseline ? ` Known reds listed in ${CFG.guardBaseline} (config guardBaseline) are subtracted first and never rerun: not a regression; a fix that turns one green removes its entry in the same commit; do not edit the quarantine.` : ''} Your own guards you run directly; a red one is yours to fix.`
    : `New reds of a ${ONE_RUN ? 'selection' : 'full run'}: ${SCRIPTS}/guards-all.sh reruns each one alone in the same slot. Red again alone - a new red (a regression); green alone - flaky: not a regression, name it in your report under "Flaky guards" for the coordinator, who puts it into the project backlog.${CFG.guardBaseline ? ` Known reds listed in ${CFG.guardBaseline} (config guardBaseline) are subtracted first and never rerun ("N known red"): not a regression; a fix that turns one green removes its entry in the same commit.${ONE_RUN ? ` On a selection the project's quarantine is read only (<sharedDir>/guards-quarantine.json, known reds it lists are subtracted): a flaky guard goes into your report, not into the quarantine; do not edit either file for it.` : ` A flaky guard is written into the project's quarantine (<sharedDir>/guards-quarantine.json, outside the worktree) and is known in later runs; only the coordinator moves it into ${CFG.guardBaseline}: do not edit either file for it.`}` : ''} A ${ONE_RUN ? 'selection' : 'full run'} on the same HEAD with a clean tracked tree that ended green is reused ("reused, HEAD <sha>"); --force runs again.`],
  ['onerun', ONE_RUN && !INNER
    ? `No selection and no full guard run in the task (innerSelect false): the integration train after the review is the first run of all guards. The programmer and the tester run only their new or changed guards and their mutations, never guards-all.sh. A red train comes back to the programmer with its result; a fix that touches the product (a file outside docs and the tester's guards and fixtures) gets a short tester round - the acceptance of the cells the fix touches and the tester's own guards over them - before the second review (in the light mode there is no tester: the programmer-checker runs that acceptance itself), a fix of guards or docs only goes straight to the second review; then the train again.`
    : ONE_RUN
    ? `No full guard run in the task: after every programmer round with a new HEAD the workflow runs the selection of the task's guards, ${selectRun(t)} (a wait step: changed guards, guards that import a changed file or name it, the project's guardAlways; new reds rerun alone, known reds subtracted, the quarantine read only), and hands its log to the next role; no role runs the full suite. The programmer runs only its new guards and mutations, no selection. The tester, after its own commits, runs the selection of its own diff from the programmer's HEAD of its round through Bash run_in_background: ${SCRIPTS}/guards-all.sh --select <the programmer's HEAD> ${sq(t.gdir)} (its guards, the guards that import or name a file it changed - a fixture -, the project's guardAlways; its log ${CFG.sharedDir}/guards-${gname(t)}.select.txt; "nothing selected" - run your new guards directly); no commit of the tester - no selection of its own, the workflow's log is the evidence. A flaky guard of a selection goes into your report, not into the quarantine.`
    : `One full guard run per task: the project config has no guardSubsetCommand, so the programmer runs the full run (${SCRIPTS}/guards-all.sh ${t.gdir}) and the tester reuses its log; ${SCRIPTS}/guards-select.js --wt ${sq(t.wt)} --base ${baseArg(t)} lists the guards a change touches.`],
  ['docker', `Docker: ${CFG.ownerStackReadOnly ? `the owner's stack ${CFG.ownerStackReadOnly}` : 'the owner\'s stack'} is read-only (docker cp out is fine); never write into its containers; only a tester runs its own stack, and only when the brief asks, then removes it with its images and volumes (docker compose -p <stack> down -v --rmi all). Never remove the owner's stack or its images; other images and the build cache are not yours to clean. A post-check after you removes what the task left (its stack, processes in its worktree, the slots they hold) and reports it.`],
  ['stand', CFG.stand && CFG.stand.project
    ? `Shared stand: acceptance in Docker goes to the project's stand ${CFG.stand.project} by ticket (${SCRIPTS}/stand.sh take|deploy|release|status), not to a stack of your own, unless the task's commits change its image files (${SCRIPTS}/stand.sh image-diff, exit 1 -> own stack as before). The take process is the holder: keep it running in the background until release. Call every stand.sh command from one directory: its project config is found from there (take, deploy and status print it), not from your worktree. Never bring the stand up or down, never release another worktree's ticket.`
    : 'Shared stand: the project config has none (no section stand), so acceptance in Docker uses a stack of the task.'],
  ['testerred', 'Red tester rounds are counted per task, across runs (a relaunch carries the counts of the earlier run in the task field prior - the field counts of that run\'s result, copied: testerReds, trainReds, rejections, analyst, mechanism): the second red verdict for the product (any cells, not only the same ones) sends the task to the analyst inside the same run - a matrix of cases from the tester\'s findings in test.md and their cause (prog.md) - then one round programmer -> tester -> review on that matrix; a red tester round after that analyst stops the task for the coordinator. A red of the environment (verdict environment) does not count. Tester: in test.md name every failed case with its expected and actual result and its round, so the analyst builds the matrix from them.'],
  ['fixround', 'Fix rounds (a programmer round after the first: after a red tester, a red guard run or a rejection): its prompt names the report with the findings and the task\'s diff; the brief and the analysis are read only in the sections the findings cite, and only the guards new or changed in the round, the guards the findings name and the guards that cover the product code changed in it are mutated. The first round, and the first round after an analyst, read and mutate as before.'],
  ['postcheck', 'Post-checks: after the tester one service agent runs the git post-check and the leftovers post-check in one command (scripts/role-post-check.js, one JSON with both answers); with security work the reviewer and the security reviewer run at the same time on the same HEAD, and one git post-check after both: neither may change the worktree, a change by either stops the task, a rejection by either is a rejection.'],
  ['sources', 'Sources of a new channel, state or data path: the analyst lists in the matrix every source and consumer of each new channel (a message, an event), state or data path of the task (input events, existing data and old frames, nesting, parallel paths) and gives each its cell; a source without a cell is named "out of the task" with its reason. The reviewer and the security reviewer write a section "What is not in the diff" in their report: the sources without handling or without a guard; such a finding is not docs only.'],
  ['mechanism', 'Mechanism: for a task that brings a new channel, protocol, timing or state the analyst writes a section "Mechanism" before the matrix - 2-3 mechanisms with their cost, the invariant of the new state, the visible limits, a recommendation; a choice that is seen on the screen or rests on time (a timer, a threshold, a race) is a question to the owner ("❓ owner: ..."), never the coordinator\'s layer 2. A programmer whose solution needs a protocol, timer or state that the analysis does not name stops with status mechanism (one line in prog.md) and gets one analyst pass per task; a second one goes to the coordinator (also after a pass of an earlier run, passed as prior.mechanism). The analyst of a second red or a second rejection first answers "mechanism or cells?" and may replace the mechanism (a new section that names the one it replaces); an answer "cells" keeps every section "Mechanism", and every later role is told who wrote the section last. The reviewer writes one line: a simpler mechanism without timings, or "no".'],
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
  mechanismSection: { type: 'boolean', description: 'only the analyst before the first programmer (analystFirst): true when you wrote a section "Mechanism" into analyst.md in this answer' },
  mechanismOrCells: { type: 'string', enum: ['mechanism', 'cells'], description: 'only when the prompt asks "mechanism or cells?" (a second red or a second rejection): mechanism - the reds show the mechanism is wrong and analyst.md replaces it (a new section "Mechanism"); cells - new cells of the same mechanism' },
  summary: { type: 'string' },
}, required: ['ready', 'cells', 'subsystems', 'split', 'questions', 'summary'] }
const USECASES_SCHEMA = { type: 'object', properties: {
  ready: { type: 'boolean', description: 'use-cases.md is written: every use case has all sections of the template' },
  useCases: { type: 'number', description: 'number of use cases' },
  questions: { type: 'array', items: { type: 'string' }, description: 'open questions to the owner, each with a recommendation (the same list ends use-cases.md)' },
  summary: { type: 'string' },
}, required: ['ready', 'useCases', 'questions', 'summary'] }
const PROG_SCHEMA = { type: 'object', properties: {
  status: { type: 'string', enum: ['ready', 'blocked', 'environment', 'mechanism'], description: 'blocked - an answer of the coordinator or owner is needed; mechanism - your solution needs a protocol, timer or state that the analysis does not name: you stopped before the code with one line in prog.md (what and why), and the analyst gets one pass; environment - the red is the environment\'s, not the product\'s (a full run cut off before its tally, the slot queue refused your job - exit 77 or 78 - or your waiting process vanished without an exit code, disk or swap exhausted; a long queue while your process is alive is not one): the task stops for the coordinator' },
  changedFiles: { type: 'array', items: { type: 'string' }, description: 'paths changed in this round (git diff --name-only from the start of the round)' },
  commits: { type: 'array', items: { type: 'string' } },
  head: { type: 'string', description: 'git rev-parse HEAD of the worktree after your commits: the full sha (40 hex digits), not an abbreviation' },
  mutations: { type: 'string', description: 'table: mutant -> guard result -> after checkout' },
  fullRun: { type: 'string', description: 'result of your full guard run: N green, N new red (repeated alone), N flaky (green alone), N known red; when the workflow runs the full run (the prompt says so), "the workflow runs it" and the result of your new guards' },
  acceptance: { type: 'string', description: 'light mode only: the acceptance scenario run by you - result and where its evidence is (test.md, test-* files)' },
  questions: { type: 'array', items: { type: 'string' } },
  summary: { type: 'string' },
}, required: ['status', 'changedFiles', 'commits', 'head', 'mutations', 'fullRun', 'questions', 'summary'] }
const TEST_SCHEMA = { type: 'object', properties: {
  verdict: { type: 'string', enum: ['green', 'red', 'environment'], description: 'environment - red caused by the environment, not by the product: the task stops for the coordinator' },
  environment: { type: 'string', description: 'with verdict environment: the cause and its evidence (a cut-off full run, a refused slot queue, disk or swap, Docker down)' },
  head: { type: 'string', description: 'git rev-parse HEAD of the worktree after your commits: the full sha (40 hex digits), not an abbreviation' },
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
// A role's head is resolved to the full sha right after its answer (p-noghost-d, coordinator's decision 4 of 2026-10-31):
// on 2026-10-30 a role returned "3fb1d6dd", the ride got it, train.js exited 64 and the task stopped as the environment;
// the result file (resultOf), the selection's st.selAt and "the fix round committed nothing" compare it as well. Only an
// abbreviated object name is resolved - gitrevisions(7): a leading substring of the hexadecimal object name, at least
// 4 digits (core.abbrev minimum) - by one cheap service step, `git rev-parse --verify -q '<h>^{commit}'`, whose answer
// is taken only as a full sha that starts with the abbreviation (a failed answer is repeated once, checkTwice). A full sha
// needs no step; anything else, or an abbreviation that does not resolve, is kept as the role gave it (never emptied),
// and train.js refuses it with "head is not a full sha: <value>".
const FULL_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/
const ABBREV_SHA = /^[0-9a-fA-F]{4,64}$/
const SHA_SCHEMA = { type: 'object', properties: { sha: { type: 'string' }, error: { type: 'string' } }, required: ['sha'] }
const sha1 = (t, role, phase, h, retry) => agent(`Run one command and return what it prints as the schema field sha (change nothing, analyse nothing):
git -C ${sq(t.wt)} rev-parse --verify -q ${sq(`${h}^{commit}`)}
If it prints nothing or fails - sha = '', error = the error text or "no such commit".`,
  checkOpts(`sha:${t.key}:${role}`, phase, SHA_SCHEMA, retry))
async function fullHead(t, role, phase, h) {
  if (typeof h !== 'string' || FULL_SHA.test(h) || !ABBREV_SHA.test(h)) return h
  const good = (r) => !!(r && FULL_SHA.test(r.sha || '') && r.sha.startsWith(h.toLowerCase()))
  const { res } = await checkTwice(t, `full sha of the ${role}'s head ${h}`, good, (retry) => sha1(t, role, phase, h, retry))
  if (good(res)) return res.sha
  log(`${t.title}: the ${role}'s head ${h} does not resolve to a commit in ${t.wt} - kept as given (train.js refuses it)`)
  return h
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
const LEFT_WHY = 'This is the leftovers post-check of the codis-agents process the project owner set up (rule "Docker" in rules/multi-agent.md): after the tester and at the end of every task it removes what this task itself left behind. --fix touches only Docker resources labelled with this task\'s own compose project, processes whose cwd or argv lie inside this task\'s worktree, and the slots they hold; the owner\'s stack is excluded by --owner-stack and is never touched. Running it is the expected step, not a decision for you to make.'
const leftArgs = (t) => `${t.stack ? ` --stack ${sq(t.stack)}` : ''}${CFG.ownerStackReadOnly ? ` --owner-stack ${sq(CFG.ownerStackReadOnly)}` : ''}${SLOTS_DIR ? ` --slots-dir ${sq(SLOTS_DIR)}` : ''} --fix --log ${sq(`${t.dir}/leftovers.md`)}`
const leftCheck1 = (t, when, retry) => agent(`${LEFT_WHY}
Run one command and return its JSON output as the schema fields (change nothing else, analyse nothing):
node ${SCRIPTS}/role-leftovers-check.js --wt ${t.wt}${leftArgs(t)}
If the command fails without JSON - ok=false, error = the error text, remaining = [the error text].`,
  checkOpts(`left:${t.key}:${when}`, when === 'tester' ? 'Tester' : 'Reviewer', LEFT_SCHEMA, retry))
const leftPassed = (l) => !!(l && l.ok && !(l.remaining || []).length)
// What a failed first attempt reports as removed was removed (--fix ran before the failure), so it is kept as well.
const keepRemoved = (first, res) => {
  const early = ((first && first.removed) || []).filter((x) => !((res && res.removed) || []).includes(x))
  return res && early.length ? Object.assign({}, res, { removed: early.concat(res.removed || []) }) : res
}
const leftCheck = async (t, when) => {
  const { first, res } = await checkTwice(t, `leftovers (${when})`, leftPassed, (retry) => leftCheck1(t, when, retry))
  return keepRemoved(first, res)
}
// After the tester the git post-check and the leftovers post-check are one service agent (plugin audit P2): one command,
// scripts/role-post-check.js, one JSON {ok, diff, left} with the fields of both scripts. The workflow runtime cannot run
// a command without an agent, so one agent per tester round instead of two. checkTwice repeats both on a failure of
// either; the removed list of the first attempt is kept; diffFail and leftFail read their part as before.
const POST_SCHEMA = { type: 'object', properties: {
  ok: { type: 'boolean' }, diff: DIFF_SCHEMA, left: LEFT_SCHEMA, error: { type: 'string' },
}, required: ['diff', 'left'] }
const postCheck1 = (t, since, retry) => agent(`${LEFT_WHY} The same command first runs the git post-check of the tester (role-diff-check.js: what the tester changed since the programmer's HEAD).
Run one command and return its JSON output as the schema fields (change nothing else, analyse nothing):
node ${SCRIPTS}/role-post-check.js --wt ${t.wt} --since ${since} --role tester${ALLOW}${leftArgs(t)}
If the command fails without JSON - ok=false, error = the error text, diff = {ok: false, offending: [], error: the error text}, left = {ok: false, found: [], removed: [], remaining: [the error text], error: the error text}.`,
  checkOpts(`post:${t.key}:tester`, 'Tester', POST_SCHEMA, retry))
const postPassed = (p) => !!(p && p.diff && p.diff.ok && leftPassed(p.left))
const postCheck = async (t, since) => {
  const { first, res } = await checkTwice(t, 'tester and leftovers (tester)', postPassed, (retry) => postCheck1(t, since, retry))
  return res && Object.assign({}, res, { left: keepRemoved(first && first.left, res.left) })
}
// '' when nothing remains (removed ones are kept in st.leftovers), otherwise the reason to stop.
const leftFail = (st, when, l) => {
  if (!l) return `the leftovers post-check (${when}) returned no result`
  if ((l.removed || []).length) st.leftovers.push(...l.removed.map((x) => `${when}: ${x}`))
  return leftPassed(l) ? ''
    : `leftovers the chain could not remove (${when}): ${(l.remaining || []).join(', ') || l.error || '?'}`
}

// The selection step (ONE_RUN: guards-all.sh --select after every programmer round with a new HEAD). A long
// deterministic step runs between role agents: a cheap service agent starts it with
// scripts/wait-step.js and waits with blocking calls of at most 270 s (its context is tiny, so a wake-up costs almost
// nothing; under the cache lifetime and the 10-minute silence limit); the next role gets the log as a file. The agent
// keeps waiting while the run is alive ("alive":true), whatever its tail: 24 of 37 repeats in one window (2026-10-22..24)
// came from a cheap waiter that gave up on a run waiting 25-64 min in the heavy slot queue ("the tail has not changed").
// wait-step itself ends a hung run at its deadline (rc 124). A step
// without a numeric exit code is repeated once by the default model with --reuse, which attaches to the run or keeps its
// result instead of starting it twice. A numeric exit code means the step ran, whatever its outcome: a red run goes to
// the programmer with its log (in the wait steps experiment a red run whose agent wrote a description into error was
// taken for "could not run" and stopped the task, e2g2 2026-10-19). Only a step that could not run stops the task.
// Why the workflow waits, not a role (measurement 2026-10-10..20): 3.9 full runs per task, about 81 minutes, 37 % of a task's calendar; about
// 80 % of their new reds were the environment or flaky guards.
const RUN_SCHEMA = { type: 'object', properties: {
  done: { type: 'boolean' }, rc: { type: ['number', 'null'] }, seconds: { type: 'number' }, log: { type: 'string' },
  tail: { type: 'string' }, alive: { type: 'boolean' }, pid: { type: 'number' }, error: { type: 'string' },
}, required: ['done', 'rc', 'log'] }
const runStep1 = (t, step, cmd, retry, phase = 'Selection') => {
  const id = `${t.dir}/wait-${step}`
  return agent(`This is a wait step of the codis-agents process the project owner set up: a long deterministic command runs in the background and you only wait for it, so that the role agents do not. Running it is the expected step, not a decision for you to make; change nothing, analyse nothing.
1. Run once: node ${SCRIPTS}/wait-step.js start --id ${sq(id)} --cwd ${sq(t.wt)}${retry ? ' --reuse' : ''} -- ${sq(cmd)}
2. Run: node ${SCRIPTS}/wait-step.js wait --id ${sq(id)} --max 270
   (Bash with timeout 300000 ms; it blocks up to 270 s and prints JSON). While the JSON says "done":false (the run is alive: "alive":true), run the same command 2 again, nothing else in between, whatever the tail, the queue position or the time that has passed: an unchanged tail, a long wait or a queue position that does not move is not a reason to stop - the run may wait hours for a memory slot, and wait-step itself ends a hung run at its deadline. Never run the command of step 1 twice.
3. Return the schema only once the JSON says "done":true: its fields (done, rc, seconds, log, tail, alive, pid, error) exactly as printed - do not describe or judge the result. Never return "done":false yourself, except when a command printed no JSON:
If a command fails without JSON - done=false, rc=null, log=${sq(id + '.log')}, error = the error text.`,
  checkOpts(`run:${t.key}:${step}`, phase, RUN_SCHEMA, retry))
}
const ranStep = (r) => !!(r && typeof r.rc === 'number')
// Exit codes of the selection step that are the environment, not the product (p-wait D1; coordinator 2026-10-24): the
// step's deadline, the refusals of the slot queue before the run (scripts/slots.zsh, guards-all.sh), a selection that
// could not be computed (65) and the remote runner (69; p-train-ac). A project
// runner that itself exits with one of them is taken for the environment too (README). Without this they went to the
// programmer as a red run (#nf) with nothing to fix.
const ENV_RC = {
  124: 'the deadline of the wait step passed - the run was killed with its process group',
  77: 'the slot queue refused the run: the slot directory is not writable',
  78: 'the run was refused before it started: slot or project config, swap below its floor, or the main working copy',
  72: 'the run was refused before it started: no ps or pgrep',
  73: 'the run was refused before it started: mktemp failed',
  65: 'the selection could not be computed: guards-select.js failed (git: unknown base, not a repository)',
  69: 'the remote runner (unreachable, a host key mismatch, another plugin version, a refused push or a vanished run - no run on this machine instead), or a run that did not account for its selected guards (its tally counts fewer than it was given by --only, or it has no tally line)',
}
const envFull = (tag, r) => {
  const why = `exit ${r.rc}: ${ENV_RC[r.rc]}${r.error ? ` (${r.error})` : ''}; log ${r.log}`
  return { fail: `selection after programmer ${tag}: red from the environment, not the product - ${why}`, environment: why, full: selLine(r) }
}
const runStep = async (t, step, cmd, phase) => (await checkTwice(t, `wait step ${step}`, ranStep, (retry) => runStep1(t, step, cmd, retry, phase))).res
// '' when the step ran (any numeric exit code), otherwise why it could not: that goes to the coordinator.
const runFail = (step, r) => (!r ? `the wait step ${step} returned no result`
  : !ranStep(r) ? `the wait step ${step} could not run: ${r.error || 'no exit code'} (log ${r.log})` : '')
// The selection of the worktree (guards-all.sh --select); its log is copied next to the step log, since the next
// selection overwrites it. It is never the log of a full run (guards-<name>.txt): the selection has its own file.
const selectStep = async (t, n) => {
  const step = `select-${n}`
  const copy = `${t.dir}/wait-${step}.guards.txt`
  const r = await runStep(t, step, `${selectRun(t)}; rc=$?; cp ${sq(`${CFG.sharedDir}/guards-${gname(t)}.select.txt`)} ${sq(copy)} 2>/dev/null; exit $rc`)
  const f = runFail(step, r)
  return f ? { fail: f } : Object.assign({}, r, { guards: copy })
}
const selLine = (r) => (r ? `exit ${r.rc}; summary ${r.log}, selection log ${r.guards}` : 'none on this HEAD')
const MAX_SEL_FIX = 2

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
// The kind of a task: {kind} or {error}. Only the exact strings count; nothing is inferred from the other fields.
const KINDS = ['feature', 'defect', 'tail']
const KIND_ERR = 'exactly one kind: feature | defect | tail - the task must carry `kind` ("feature": new behaviour, it needs use cases; "defect": a bug, with its diagnosis or a noAnalysis reason; "tail": a small leftover); the chain does not guess it from the other fields'
const kindOf = (t) => (KINDS.includes(t.kind) ? { kind: t.kind } : { error: `${KIND_ERR} (got ${t.kind === undefined ? 'none' : JSON.stringify(t.kind)})` })
const NO_UC_ERR = 'feature without use cases: add useCasesFirst (the analyst writes them) or useCases (a path)'
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
// The counts of earlier runs of a task (p-testerred-route, mechanism M-A of its analysis): {prior: {...}} or {error}. The
// rules count red tester rounds, red trains, the one analyst of a second red or rejection and the one pass "Mechanism"
// per task, while st lives one run; the coordinator copies the field counts of the last run's result (countsOf), and it
// seeds st (chain()). Only the exact values count, nothing is inferred: testerReds and trainReds - integers >= 0 (red
// verdicts for the product; environment reds and seam, conflict, arc-red trains are not counted), rejections - review
// rejections since the last analyst of the task (the next one is the second; review 1 of p-testerred-route: a run that
// stopped after rejection 1 began the count again), analyst - which
// analyst of the task already ran (tester-red, rejection, train-red), mechanism - true when the pass after a status
// mechanism was made (no pass: leave it out). The light mode has no tester, so testerReds above 0 is refused there.
const PRIOR_ANALYSTS = ['tester-red', 'rejection', 'train-red']
const PRIOR_KEYS = ['testerReds', 'trainReds', 'rejections', 'analyst', 'mechanism']
function priorOf(t, light) {
  if (t.prior === undefined) return { prior: {} }
  const p = t.prior
  const why = 'prior holds the counts of earlier runs of this task (the field counts of the last run\'s result): {testerReds?: integer >= 0, trainReds?: integer >= 0, rejections?: integer >= 0, analyst?: "tester-red" | "rejection" | "train-red", mechanism?: true}'
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: `prior must be an object, not ${JSON.stringify(p)}: ${why}` }
  const unknown = Object.keys(p).filter((k) => !PRIOR_KEYS.includes(k))
  if (unknown.length) return { error: `prior has unknown keys ${unknown.join(', ')}: ${why}` }
  for (const k of ['testerReds', 'trainReds', 'rejections']) {
    if (p[k] !== undefined && !(Number.isInteger(p[k]) && p[k] >= 0)) return { error: `prior.${k} must be an integer >= 0, not ${JSON.stringify(p[k])}: ${why}` }
  }
  if (p.analyst !== undefined && !PRIOR_ANALYSTS.includes(p.analyst)) return { error: `prior.analyst must be one of ${PRIOR_ANALYSTS.join(', ')}, not ${JSON.stringify(p.analyst)}: ${why}` }
  if (p.mechanism !== undefined && p.mechanism !== true) return { error: `prior.mechanism must be true (no pass made: leave it out), not ${JSON.stringify(p.mechanism)}: ${why}` }
  if (light && p.testerReds > 0) return { error: `prior.testerReds ${p.testerReds} with mode light: the light mode has no tester, so its red tester rounds are not counted - run the task in the full mode or drop testerReds` }
  return { prior: p }
}
const PRIOR_MECH = 'an earlier run (prior.mechanism)'
// The counts of a run, in the shape of prior (review 1 of p-testerred-route): every result of a task carries them, the
// seed included, so the next run's prior is a copy and nobody recounts reds from test.md (cvm-wheel-c lost one that way).
const countsOf = (st) => Object.assign({ testerReds: st.reds || 0, trainReds: st.trainReds || 0, rejections: st.rejections || 0 },
  st.analyst ? { analyst: st.analyst } : {}, st.mechanism ? { mechanism: true } : {})
const priorLine = (p) => PRIOR_KEYS.filter((k) => p[k] !== undefined).map((k) => `${k} ${p[k]}`).join(', ')
// The base of a task with ONE_RUN (coordinator's decision 6 of p-train-ac, 2026-10-29): required, since the selection
// diffs against it, and not a protected branch - the branch of the arc. '' when it passes, otherwise why not.
function baseOf(t) {
  if (!ONE_RUN) return ''
  if (!nonBlankS(t.base)) return 'base: with guardSubsetCommand the task needs base - the branch of the arc it started from (the selection of its guards diffs against it)'
  const prot = Array.isArray(CFG.protectedBranches) ? CFG.protectedBranches : []
  if (prot.includes(t.base.trim())) return `base ${t.base.trim()} is a protected branch (protectedBranches): with guardSubsetCommand the base is the branch of the arc, not ${prot.join(', ')}`
  // W3 of p-train-ac: the train moves the base after a green ride, so it is a branch; a full object name is a commit (git
  // names an object by 40 hex digits, or 64 with sha256). An abbreviated sha or a missing branch is caught by the
  // precondition agent (show-ref refs/heads/<base>) and by train.js enqueue, before the queue.
  if (/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(t.base.trim())) return `base ${t.base.trim()} is a commit, not a branch: with guardSubsetCommand the base is the branch of the arc (the train moves it after a green ride)`
  return ''
}
const analysisLine = (a) => (a.mode === 'none' ? `No analysis: ${a.reason}` : `The analysis to follow: ${a.path}`)
// Who wrote the section "Mechanism" of analyst.md last in this run (st.mechSection): the analyst's pass after a status
// mechanism, or a later analyst (second rejection, second red tester round, second red train) that answered "mechanism";
// an answer "cells" leaves it. Every later programmer, programmer-checker and tester prompt and every later analyst names
// it, so a round that knows only the old analysis does not bring the rejected mechanism back (reviews 1 and 2 of
// p-mechanism). st.mechanism stays the round of the pass alone: it decides the route of a second status mechanism (a pass
// of an earlier run arrives as prior.mechanism). The workflow reads no files, so the author of a section written in an
// earlier run is not named here.
const mechAuthor = (t, st) => (st && st.mechSection ? `section "Mechanism" of ${t.dir}/analyst.md (written last by ${st.mechSection}; build and check by it)` : '')
const mechLine = (t, st) => (st && st.mechSection ? `\nThe mechanism of this task: ${mechAuthor(t, st)} - not a mechanism of your own.` : '')

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
Check: ${t.dir}/BRIEF.md exists and contains an acceptance scenario in the real environment;${preAnalysis(t)}${ONE_RUN && nonBlankS(t.base) ? ` the base ${t.base.trim()} is a branch of the repository: git -C ${sq(t.wt)} show-ref --verify --quiet ${sq(`refs/heads/${t.base.trim()}`)} exits 0 (the integration train moves that branch after a green ride; a commit or a missing branch fails);` : ''}${t.uc ? ` the use cases ${t.uc} exist, are non-empty and have no open questions to the owner left unanswered (they were reviewed with the owner);` : ''}${t.specs.length ? ` the arc specification ${t.specs.join(', ')} exists;` : ''} ${t.wt} exists and is on branch ${t.branch}; there are no uncommitted changes (except untracked build output or probes); the brief has no unanswered questions to the owner on which acceptance depends; the environment has room: run node ${SCRIPTS}/env-check.js --path ${sq(t.wt)} --path ${sq(t.dir)} --worktree ${sq(t.wt)} --min-disk-gb ${ENV.minFreeDiskGB} --min-swap-mb ${ENV.swapMinMB} (free disk and swap headroom; the worktree is not the main working copy of its repository) and copy its problems. ok=false if any of this fails.`,
  Object.assign({ label: `pre:${t.key}`, phase: 'Preconditions', schema: PRE_SCHEMA, effort: 'low', agentType: 'general-purpose' }, modelOf('preconditions')))

// The mechanism step (p-mechanism, owner 2026-11-01: "yes to the step 'challenge the mechanism'"; diagnosis mechanism-gap):
// no role could say "the approach is wrong" - the analyst built cells under a mechanism the programmer chose later, the
// analyst of a second red wrote more cells of the same mechanism, the reviewer judged the code against the brief. In
// cvm-wheel-b a probe with a 1500 ms timer took 7 rounds and 30M, and its flicker was seen by the owner an hour after the
// acceptance. Whether a task has a mechanism to choose is judged by its sense, never by a field or the preconditions.
const MECH_SECTION = 'Mechanism: when the task brings a new channel (a message, an event), protocol, timing or state - judged by its sense in the brief and the analysis, no field marks it - write a section "Mechanism" before the matrix: 2-3 mechanisms with their cost, the invariant of the new state (when it holds and what every event does to it), the visible limits (engine, memory, timing) and a recommendation. A choice that is seen on the screen or rests on time (a timer, a threshold, a race) goes into questions as "❓ owner: ..." - layer 3, not the coordinator\'s layer 2; build the cells on the chosen mechanism.'
const KEEP_SECTIONS = (t) => `Keep the earlier sections of ${t.dir}/analyst.md, every section "Mechanism" among them: on "cells" add the matrix to them; on "mechanism" write a new section "Mechanism" that names the one it replaces.`
const MECH_OR_CELLS = (t, st) => `First answer "mechanism or cells?" (mechanismOrCells): do these reds open new cells of the same mechanism, or do they show that the mechanism is wrong (it needs timers, thresholds, races or a provenance it cannot get)? In the second case you may replace the mechanism: a new section "Mechanism" in analyst.md (2-3 mechanisms with their cost, the invariant, the visible limits, the choice; a choice seen on the screen or resting on time goes into questions as "❓ owner: ...") and the matrix of cases on the new mechanism. ${st && st.mechSection ? `The mechanism now: ${mechAuthor(t, st)}. ` : ''}${KEEP_SECTIONS(t)} Then: `
// A later analyst's answer "mechanism" makes it the author of the section (st.mechSection); "cells" leaves the author.
const mechBy = (st, a, who) => { if (a && a.mechanismOrCells === 'mechanism') st.mechSection = `the analyst of the second ${who}` }
const REWORK = (t, a) => (a && a.mechanismOrCells === 'mechanism' ? ` The analyst replaced the mechanism (section "Mechanism" of ${t.dir}/analyst.md): rework the code by it, and rewrite the guards of the old mechanism that no longer hold instead of patching them.` : '')
const MECH_STATUS = 'status=mechanism (before the code, one line in prog.md: what and why) if your solution needs a protocol, timer or state that the analysis and the brief do not name (a probe, a poll, a wait for an answer, a new state machine): the analyst gets one pass and you continue on its section "Mechanism".'
const analyst = (t, why) => agent(`You are the ANALYST/DIAGNOSER (read code only; you write only ${t.dir}/analyst.md). ${RULES(t)}
Reason: ${why}
Write a matrix of cases (every dimension: states x events x environments) or find the cause of the defect with file:line. Count the cells and subsystems. If by the rule "Split the task" the task must be split, propose subtasks and do not declare ready. Every cell has an expected result and a basis (the brief, documentation, an experiment); no thresholds or name lists. For each new channel (a message, an event), state or data path of the task list every source and consumer (input events, existing data and old frames, nesting, parallel paths), each with its cell; a source without a cell is named "out of the task" with its reason. ${MECH_SECTION}${t.uc ? ` Build the matrix on the use cases ${t.uc}: every cell cites its use case (UC-n and the flow step); a flow without cells is a gap.` : ''}${note('analyst')}`,
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

// What the programmer runs after the mutations: nothing more (ONE_RUN: the workflow runs the selection) or the full run.
const guardsPart = (t) => (ONE_RUN && !INNER
  ? `no selection and no full run (innerSelect false): only your new or changed guards and their mutations; the integration train after the review is the first run of all guards (fullRun = "the train runs them" and the result of your new guards)`
  : ONE_RUN
  ? `no selection of guards and no full run of your own (there is no full guard run in the task): after you return, the workflow runs the selection ${selectRun(t)} on your HEAD and hands you its log only if it is red (fullRun = "the workflow runs the selection" and the result of your new guards)`
  : `full run ${SCRIPTS}/guards-all.sh ${t.gdir} in the background -> analysis of new reds that repeated alone (flaky ones go into prog.md for the backlog)`)
// A fix round (p-fixround, audit P5: a fix round is a new agent that reread the brief, analyst.md, prog.md and test.md
// - 33 % of its input; its mutations covered every guard again): it reads the findings and the task's diff, the brief and
// analysis only in the cited sections, and mutates only the guards of this round, the guards the findings name and those
// over product code changed in it (review 1). fix = { report, before }: the report
// with the findings and the HEAD before the round (the previous role's); the first round passes none.
const fixPart = (t, n, fix) => (fix ? `\nFix round ${n} (not the first): do not reread the whole task. Read the findings of this round in ${fix.report} and the task's diff (git -C ${sq(t.wt)} log --oneline ${baseArg(t)}..HEAD, git -C ${sq(t.wt)} diff ${baseArg(t)}..HEAD); read BRIEF.md, the analysis and the arc specification only in the sections the findings cite, and of prog.md only its last round. Mutations in this round only for the guards new or changed in it (git -C ${sq(t.wt)} diff --name-only ${fix.before ? sq(fix.before) : '<the HEAD before this round>'}..HEAD after your commits), the guards the findings name (a finding "guard G has no mutation" is fixed by mutating G) and the guards that cover the product code changed in it (a fix under an unchanged guard is still mutation-tested): a table of this round's mutants; the tables of earlier rounds stay as they are.` : '')
const prog = (t, task, n, fix, st) => (t.light ? progLight(t, task, n, fix, st) : agent(`You are the PROGRAMMER. ${RULES(t)} Report: ${t.dir}/prog.md (round ${n}).
${analysisLine(t.an)}${mechLine(t, st)}
${task}${fixPart(t, n, fix)}
Order: red guard -> commit -> code -> commit -> mutations AFTER the commit (table in prog.md) -> ${guardsPart(t)}. status=blocked if you cannot go on without the owner's answer; ${MECH_STATUS}${note('programmer')}`,
  Object.assign({ label: `prog:${t.key}#${n}`, phase: 'Programmer', schema: PROG_SCHEMA, agentType: roleType('programmer') }, modelOf('programmer'))))
// Light mode: one programmer-checker does the programmer's work and the tester's acceptance; the reviewer follows.
const progLight = (t, task, n, fix, st) => agent(`You are the PROGRAMMER-CHECKER of a task in the light mode: there is no tester role, so you also run the acceptance. ${RULES(t)} Reports: ${t.dir}/prog.md (round ${n}) and ${t.dir}/test.md (your acceptance, round ${n}; keep earlier rounds).
${analysisLine(t.an)}${mechLine(t, st)}
${task}${fixPart(t, n, fix)}
Order: red guard -> commit -> code -> commit -> mutations AFTER the commit (table in prog.md) -> ${guardsPart(t)} -> your own acceptance in the real environment: ${t.accept} Evidence (logs, numbers, screenshots) goes into ${t.dir}/test.md and files with the prefix test-; put the result and where its evidence is into acceptance. status=ready only when the acceptance is met; status=blocked if you cannot go on without the owner's answer; ${MECH_STATUS}${note('programmer')}`,
  Object.assign({ label: `prog:${t.key}#${n}`, phase: 'Programmer', schema: PROG_SCHEMA, agentType: roleType('programmer') }, modelOf('programmer')))

// Acceptance on the project's shared stand (config stand, scripts/stand.sh): image-diff decides whether it fits.
const standSteps = (t) => (CFG.stand && CFG.stand.project ? ` On the project's shared stand ${CFG.stand.project}: (a) ${SCRIPTS}/stand.sh image-diff --wt ${sq(t.wt)} --base <the commit this task branched from> - exit 0: the stand fits, exit 1: the task changes the stand's image files and needs ${t.stack ? 'its own stack (below)' : 'its own stack: write "❓ coordinator: own stack needed, image files changed" into test.md and give the verdict environment'}; (b) ${SCRIPTS}/stand.sh take --wt ${sq(t.wt)} with run_in_background - it waits in the queue ("position N") and then holds the ticket while it runs; wait for its line "ticket taken by" with a blocking Bash loop (until it appears or the take process has died; do sleep 3; done, timeout 270000) repeated while the take process is alive, or ${SCRIPTS}/wait-step.js watch --log <its output> --until 'ticket taken by', never by ending your turn - the stand's queue is not the environment; (c) ${SCRIPTS}/stand.sh deploy ${sq(t.wt)} (your committed HEAD; it runs in a medium slot); (d) the scenario against the stand; (e) ${SCRIPTS}/stand.sh release --wt ${sq(t.wt)} as soon as the evidence is saved, also after a red (the next tester waits for it). A take refused with "not up" or "reset failed" is an environment red for the coordinator.` : '')
const test = (t, n, st, short) => agent(`You are the TESTER. You do not change product code. ${RULES(t)} Report: ${t.dir}/test.md (round ${n}; keep earlier rounds).${mechLine(t, st)}${short ? `\n${short}` : ''}
1. An independent inventory before reading the diff (inputs, places, cells) - compare it with the programmer's coverage.
2. Your own guards for what is not covered -> commit -> mutations after the commit.
3. Acceptance in the real environment: ${t.accept}${standSteps(t)}${t.stack ? ` ${CFG.stand && CFG.stand.project ? 'Only when the stand does not fit, your' : 'Your'} own stack: docker compose -p ${t.stack}; afterwards remove it with its images and volumes: docker compose -p ${t.stack} down -v --rmi all.` : ''} Evidence (logs, numbers, screenshots) goes into ${t.dir} with the prefix test-.${t.uc ? ` Build the acceptance along the flows of the use cases (the main flow, every alternative flow, all errors): ${t.uc}.` : ''}
4. ${ONE_RUN && !INNER ? `There is no selection and no full guard run in the task (innerSelect false): do NOT run guards-all.sh. Run your new and touched guards and their mutations; the integration train after the review is the first run of all guards.` : ONE_RUN ? `There is no full guard run in the task: do NOT run the full suite. The workflow ran the selection of the task's guards on the programmer's HEAD (${selLine(st && st.sel)}); reuse its log ("nothing selected" in it - no guard of the diff, the programmer's new guards are the evidence). Run your new and touched guards and mutations. If you commit guards or fixtures, run the selection of your own diff from the programmer's HEAD through Bash run_in_background: ${testerSelectRun(t, st && st.head)} (your new or changed guards, the guards that import or name a file you changed - a fixture of a product guard outside your diff -, the project's guardAlways; the product guards of the task's selection are already green on the same code); no commit - no selection of your own: reuse its log as the evidence.` : "Do not repeat the programmer's full run: new and touched guards and mutations; a full run only after your own commits."}
green - only if the brief's acceptance is met in full. red - the product fails a guard or the acceptance.
environment - red that the product did not cause, so a programmer has nothing to fix: your or the programmer's full run cut off before its tally (killed, timed out, out of memory), the slot queue refused your heavy job (heavy.sh or guards-all.sh exited 77 or 78) or your waiting process vanished without an exit code - while your heavy.sh, started with run_in_background, is alive in the queue, keep waiting with a blocking Bash loop (a turn without a tool call ends your role): a long queue is not the environment -, disk or swap exhausted (node ${SCRIPTS}/env-check.js --path ${sq(t.wt)} --min-disk-gb ${ENV.minFreeDiskGB} --min-swap-mb ${ENV.swapMinMB}), Docker or your stack down for a reason outside the task's code. Put the cause and its evidence into environment; the task stops for the coordinator. Never use it for a red that the product causes.${note('tester')}`,
  Object.assign({ label: `test:${t.key}#${n}`, phase: 'Tester', schema: TEST_SCHEMA, agentType: roleType('tester') }, modelOf('tester')))

const review = (t, n, scope) => agent(`You are the REVIEWER (read only; you may rerun guards). ${RULES(t)} Report: ${t.dir}/review.md (round ${n}).
Read BRIEF.md, analyst.md (if any), prog.md, test.md, git log/diff of branch ${t.branch} for the task${scope ? ' - ' + scope : ''}. Try to refute "done": cells of the matrix,${t.uc ? ` the alternative flows and errors of the use cases ${t.uc} (closed, not only the main flow),` : ''} guesses instead of data (thresholds, name lists), guards without mutations, the tester's evidence against the acceptance scenario (do not rerun the scenario). Write a section "What is not in the diff" in review.md: the sources of each new channel, state or data path (input events, existing data and old frames, nesting, parallel paths) that have no handling or no guard; such a finding is not docsOnly. One line "Mechanism:" in review.md: is there a simpler mechanism without timings (timers, thresholds, races) for what the task does - name it, or "no".${t.light ? ` This task runs in the light mode: there is no tester role; the programmer-checker ran the acceptance - check its evidence in ${t.dir}/test.md against the acceptance scenario and its mutation table in prog.md.` : ''} Verdict with file:line.${note('reviewer')}`,
  Object.assign({ label: `review:${t.key}#${n}`, phase: 'Reviewer', schema: REVIEW_SCHEMA, agentType: roleType('reviewer') }, modelOf('reviewer')))

const secReview = (t, n, scope) => agent(`You are the SECURITY REVIEWER (read only; you may rerun guards). ${RULES(t)} Report: ${t.dir}/review-sec.md (round ${n}).
The brief marks the task as security work. Read BRIEF.md, ${CFG.threatModel ? `the threat model ${t.wt}/${CFG.threatModel}, ` : ''}git diff of branch ${t.branch} for the task${scope ? ' - ' + scope : ''}, test.md. Look with an attacker's eyes: access by a guest and by another owner, swapped ids, malformed input, secrets (model keys, passes) leaking into responses, logs, postMessage, UI; does the tester have refusal guards for every input, and are they mutation-tested. Write a section "What is not in the diff" in review-sec.md: the sources of each new channel, state or data path (input events, existing data, nesting, parallel paths) that have no handling or no refusal guard; such a finding is not docsOnly. Verdict with file:line; docsOnly - only if the findings concern docs, guard wording or comments alone.${note('security-reviewer')}`,
  Object.assign({ label: `sec:${t.key}#${n}`, phase: 'Reviewer', schema: REVIEW_SCHEMA, agentType: roleType('security-reviewer') }, modelOf('security-reviewer')))

// Programmer -> tester (red -> programmer again, without review), up to maxRounds tester rounds.
// st.head - HEAD after the last committing role; the next role's post-check starts from it.
async function testChecked(t, st, n, short) {
  const tr = await test(t, n, st, short)
  if (!tr) return { fail: 'the tester returned no result' }
  const pc = await postCheck(t, st.head)
  const lf = leftFail(st, 'tester', pc && pc.left)
  const f = diffFail('tester', pc && pc.diff)
  if (f || lf) return { fail: f || lf }
  st.head = await fullHead(t, 'tester', 'Tester', tr.head)
  return { tr }
}
// With t.security the review is reviewer + security reviewer, run together (plugin audit P3: both only read), and one
// git post-check of the reviewers after both, from the same HEAD; done only if both are done.
async function reviewChecked(t, st, n, scope) {
  const [rv, sv] = await Promise.all([review(t, n, scope), t.security ? secReview(t, n, scope) : null])
  if (!rv) return { fail: 'the reviewer returned no result' }
  if (t.security && !sv) return { fail: 'the security reviewer returned no result' }
  const f = diffFail(t.security ? 'reviewer or the security reviewer' : 'reviewer', await diffCheck(t, 'reviewer', st.head))
  if (f) return { fail: f }
  if (!t.security) return { rv }
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

// A programmer round. With ONE_RUN the selection follows it on the new HEAD: red -> a programmer round with the log
// (fix and commit, or explain and change nothing), then the selection again, at most MAX_SEL_FIX rounds. No new
// selection on a HEAD whose selection is done (st.selAt); a round that changed only docs gets one on its new HEAD all
// the same (the selection holds guardAlways, the scanners of the diff - S8 of p-train-ac).
// sameStops (a train fix round): a round with no commit returns {p, same: true} before any selection - the coordinator
// decides on a red the programmer explained (UC-8 2d).
// mergeCheck (a train conflict round with mergeOnlyFiles, p-merge-docs): before the selection scripts/merge-only.js checks
// the round; a round that is only the merge of the arc with docs resolved by hand returns {p, mergeOnly} without one.
async function progStep(t, st, task, n, report, sameStops, mergeCheck) {
  const prev = st.head
  const m = await progMech(t, st, task, n, report ? { report, before: st.head } : null)
  if (m.fail) return m
  const p = m.p
  if (!p) return { fail: 'the programmer returned no result' }
  if (p.status === 'blocked') return { fail: 'programmer: an answer is needed', questions: p.questions }
  if (p.status === 'environment') return envProg(n, p)
  const head = await fullHead(t, 'programmer', 'Programmer', p.head)
  if (sameStops && head === prev) return { p, same: true }
  st.head = head
  if (!ONE_RUN) return { p }
  if (mergeCheck) {
    const mo = await mergeOnlyStep(t, n, prev, head)
    if (mo) { log(`${t.title}: merge-only docs: selection skipped on ${head} (${mo.reason || ''})`); return { p, mergeOnly: mo } }
  }
  if (!INNER) return { p }
  let merged = p, tag = n
  for (let k = 0; ; k++) {
    if (st.selAt && st.head === st.selAt) { log(`${t.title}: the selection on ${st.head} is done - not repeated`); return { p: merged } }
    const sel = await selectStep(t, tag)
    if (sel.fail) return sel
    st.sel = sel; st.selAt = st.head
    log(`${t.title}: selection after programmer ${tag} - exit ${sel.rc}`)
    if (sel.rc === 0) return { p: merged }
    if (ENV_RC[sel.rc]) return envFull(tag, sel)
    if (k === MAX_SEL_FIX) return { fail: `the selection of the task's guards is still red after ${k} programmer rounds with its log (exit ${sel.rc}, ${sel.log})`, full: selLine(sel) }
    const m2 = await progMech(t, st, `The selection of the task's guards the workflow ran on your HEAD after round ${tag} (${selectRun(t)}) exited ${sel.rc}: summary ${sel.log}, selection log ${sel.guards}. Analyse every new red that repeated alone: fix what your change caused (commit, mutations after the commit, your new guards); a known red or a flaky guard - explain it in prog.md and change nothing; a red from the environment (the run cut off before its tally, a refusal of the slot queue - exit 77 or 78 - disk or swap) - status=environment with the evidence. Do not run the selection or a full run yourself: if you commit, the workflow runs the selection again.\n${sel.tail || ''}`, `${tag}f`, { report: `${sel.log} (summary) and ${sel.guards} (selection log)`, before: st.head })
    if (m2.fail) return m2
    const p2 = m2.p
    if (!p2) return { fail: 'the programmer returned no result' }
    if (p2.status === 'blocked') return { fail: 'programmer: an answer is needed', questions: p2.questions }
    if (p2.status === 'environment') return envProg(`${tag}f`, p2)
    merged = Object.assign({}, p2, { changedFiles: (merged.changedFiles || []).concat((p2.changedFiles || []).filter((f) => !(merged.changedFiles || []).includes(f))) })
    tag = `${tag}f`
    const head2 = await fullHead(t, 'programmer', 'Programmer', p2.head)
    if (head2 === st.head) { log(`${t.title}: the red of the selection explained without a commit - the next role gets its log`); return { p: merged } }
    st.head = head2
  }
}

// The programmer's status mechanism (p-mechanism): its solution needs a protocol, timer or state the analysis does not
// name (cvm-wheel-b: a probe with a timer, invented in round 1, its flicker one question among 36). It stops before the
// code; the analyst gets one pass inside the run (st.mechanism; apart from st.analyst, so the analyst of a second red or
// a second rejection still comes) and the programmer runs the same round again on its section "Mechanism"; a second
// mechanism in the run, or a pass with questions or not ready, stops the task for the coordinator. {p} or {fail}.
async function progMech(t, st, task, n, fix) {
  const p = await prog(t, task, n, fix, st)
  if (!p || p.status !== 'mechanism') return { p }
  const again = (q, r) => ({ fail: `programmer ${q}: status mechanism again after the analyst's pass${st.mechanism === PRIOR_MECH ? ' made in an earlier run (prior.mechanism)' : ''} - the coordinator decides on the mechanism: ${r.summary || '?'}`, questions: r.questions || [], mechanism: r.summary || '' })
  if (st.mechanism) return again(n, p)
  st.mechanism = String(n)
  log(`${t.title}: programmer ${n} - status mechanism - analyst`)
  const now = st.mechSection ? ` The mechanism now: ${mechAuthor(t, st)}; your section replaces it and names it.` : ''
  st.mechSection = `the analyst's pass after the status mechanism of round ${n}`
  const a = await analyst(t, `the programmer stopped with status mechanism in round ${n}: its solution needs a protocol, timer or state that the analysis does not name - "${p.summary || '?'}" (its line in ${t.dir}/prog.md). Keep the other sections of ${t.dir}/analyst.md (the matrix of an earlier analyst among them) and add to it a section "Mechanism":${now} 2-3 mechanisms with their cost (the programmer's among them), the invariant of the new state, the visible limits, a recommendation, then the cells the chosen mechanism adds. A choice seen on the screen or resting on time goes into questions as "❓ owner: ..." (the task stops for the owner); otherwise name the mechanism the programmer follows.`)
  if (!a) return { fail: 'the analyst returned no result' }
  if (!a.ready || a.split.length || a.questions.length) return { fail: 'analyst after the status mechanism: split or an answer is needed', split: a.split, questions: a.questions, analyst: a.summary }
  const p2 = await prog(t, `The analyst answered your status mechanism in ${t.dir}/analyst.md (section "Mechanism"): build on the mechanism it names.${REWORK(t, a)} Your task as before:\n${task}`, `${n}m`, fix, st)
  if (p2 && p2.status === 'mechanism') return again(`${n}m`, p2)
  return { p: p2 }
}

// Red tester rounds for the product are counted per task (st.reds, seeded by prior.testerReds of earlier runs;
// environment reds never reach here). The second one, in any cells, sends the task to the analyst inside the same run
// (redAnalyst in work()); a red after that analyst stops the task for the coordinator. Only one analyst of a second red,
// a second rejection or a second red train runs per task (st.analyst, seeded by prior.analyst; the mechanism pass after
// a status mechanism is apart, st.mechanism): after the analyst of the second rejection (st.analyst = 'rejection') the
// tester rounds stay as before. Why: cvm-xy-1 (2026-10-23) - four tester -> programmer
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
  // Rejections count per task since its last analyst (st.rejections, seeded by prior.rejections): after a rejection of an
  // earlier run this one is the second.
  st.rejections = (st.rejections || 0) + 1
  if (st.rejections >= 2) return { fail: 'second review rejection', second: true, docsOnly: r1.docsOnly, review: r1.summary }
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
    : `only the diff of the fix after review 1 (git diff ${before}..${st.head})${byPaths ? '' : `; it touches files outside docs and guards (${other.join(', ') || 'none reported'}): set fixBehaviourUnchanged=true only if that diff changes comments, wording or docs alone and no behaviour`}`
  const x2 = await reviewChecked(t, st, `${tag}2`, scope)
  if (x2.fail) return x2
  const r2 = x2.rv
  log(`${t.title}: review ${tag}2 - ${r2.verdict}`)
  if (r2.verdict !== 'done') { st.rejections += 1; return { fail: 'second review rejection', second: true, docsOnly: r2.docsOnly, review: r2.summary } }
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
  const kd = kindOf(t0)
  if (kd.error) return stop(t0, 'preconditions', { problems: [kd.error], questions: [kd.error] })
  // A refusal after a valid prior carries it as counts (nothing ran, so the next run's prior is the same seed).
  let seed = null
  const refuse = (e) => Object.assign(stop(t0, 'preconditions', { problems: [e], questions: [e] }), { kind: kd.kind }, seed ? { counts: seed } : {})
  const an = analysisOf(t0)
  if (an.error) return refuse(an.error)
  const uc = useCasesOf(t0)
  if (uc.error) return refuse(uc.error)
  if (kd.kind === 'feature' && !uc.path) return refuse(NO_UC_ERR)
  const md = modeOf(t0)
  if (md.error) return refuse(md.error)
  const pr = priorOf(t0, md.light)
  if (pr.error) return refuse(pr.error)
  if (t0.prior !== undefined) seed = countsOf({ reds: pr.prior.testerReds, trainReds: pr.prior.trainReds, rejections: pr.prior.rejections, analyst: pr.prior.analyst, mechanism: pr.prior.mechanism })
  const bs = baseOf(t0)
  if (bs) return refuse(bs)
  const t = Object.assign({}, t0, { kind: kd.kind, an, uc: uc.first ? '' : uc.path || '', ucFirst: uc.first ? uc.path : '', light: md.light })
  const withAn = (r) => Object.assign({}, r, { kind: kd.kind, analysis: an, counts: countsOf(st) }, nonBlank(t0.feature) ? { feature: t0.feature.trim() } : {}, md.light ? { mode: 'light' } : {},
    uc.path && !r.useCases ? { useCases: uc.path } : {})
  // The counters of the task start from the counts of its earlier runs (prior); without prior from zero, as before.
  const p0 = pr.prior
  const st = { head: '', leftovers: [], reds: p0.testerReds || 0, priorReds: p0.testerReds || 0, trainReds: p0.trainReds || 0,
    rejections: p0.rejections || 0, analyst: p0.analyst || '', mechanism: p0.mechanism ? PRIOR_MECH : '' }
  if (priorLine(p0)) log(`${t.title}: prior runs of the task - ${priorLine(p0)} (the counters start from them)`)
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
    const a = await analyst(t, 'the task needs a spec or a diagnosis before code (brief: analystFirst). Set mechanismSection=true in your answer when you wrote a section "Mechanism" into analyst.md (the later rounds of the run name it), false otherwise.')
    if (!a) return stop(t, 'the analyst returned no result')
    // Its section "Mechanism" makes it the author (review 3 of p-mechanism, 0.4.16): the pass after a status mechanism then
    // names the section it replaces, and every later round and analyst names this author.
    if (a.mechanismSection === true) st.mechSection = 'the analyst before the first programmer (analystFirst)'
    if (!a.ready || a.split.length || a.questions.length) return stop(t, 'analyst: split the task or an answer is needed', { split: a.split, questions: a.questions, analyst: a.summary })
  } else log(t.an.mode === 'reused' ? `${t.title}: analyst reused - ${t.an.path}` : `${t.title}: no analyst - ${t.an.reason}`)

  if (t.light) return light(t, st)
  const b = await buildAndTest(t, st, t.start || 'Start with red guards for the cells of the brief (and analyst.md, if any).', '', 3)
  if (b.redAnalyst) return afterRedAnalyst(t, st, b)
  if (b.fail) return stop(t, b.stopWhy || b.fail, b)
  const rv = await reviewLoop(t, st, '')
  if (rv.ok) return ride(t, st, rv.ok.summary)
  if (rv.redAnalyst) return afterRedAnalyst(t, st, rv)
  if (!rv.second || rv.docsOnly) return stop(t, rv.stopWhy || rv.fail, rv)
  // The analyst of the task already ran in an earlier run (prior.analyst): one analyst per task, so a second rejection
  // for code after it stops the task, as it does after the analyst of this run.
  if (st.analyst) return stop(t, `after the analyst: ${rv.fail}`, rv)

  // Second rejection for code -> analyst in the same run, then one full round; a third rejection goes to the coordinator.
  st.analyst = 'rejection'
  st.rejections = 0
  const a = await analyst(t, `${MECH_OR_CELLS(t, st)}second review rejection for code (${t.dir}/review.md):\n${rv.review}`)
  if (!a) return stop(t, 'the analyst returned no result')
  mechBy(st, a, 'review rejection')
  if (!a.ready || a.split.length || a.questions.length) return stop(t, 'analyst after the second rejection: split or an answer is needed', { split: a.split, questions: a.questions, analyst: a.summary })
  const b2 = await buildAndTest(t, st, `After the second review rejection the analyst wrote ${t.dir}/analyst.md - fix according to it and to review.md.${REWORK(t, a)}`, 'A', 2)
  if (b2.fail) return stop(t, `after the analyst: ${b2.fail}`, b2)
  const rv2 = await reviewLoop(t, st, 'A')
  if (rv2.ok) return ride(t, st, rv2.ok.summary)
  return stop(t, `after the analyst: ${rv2.fail}`, rv2)
}

// Second red tester round for the product -> analyst in the same run: a matrix of cases from the tester's findings
// (test.md) and their cause (prog.md), then one round programmer -> tester -> review on it; a red tester round after it
// stops the task (why 'tester red after analyst'), and so does a second rejection after it.
async function afterRedAnalyst(t, st, x) {
  const a = await redAnalystRound(t, st, x)
  return a.out || ride(t, st, a.ok)
}
// The analyst round itself: {ok: the review's summary} to ride, or {out: the task's result}. Inside a ride (a red short
// tester round after a train, innerSelect false) the ride loop goes on with it, so the rides of a run are numbered once
// (step ids, logs, labels) and MAX_RIDES counts all of them - no ride inside a ride.
async function redAnalystRound(t, st, x) {
  const out = (r) => ({ out: r })
  st.analyst = 'tester-red'
  st.rejections = 0
  const a = await analyst(t, `${MECH_OR_CELLS(t, st)}the second red tester round for the product in this task (rule "Red tester rounds are counted per task")${st.priorReds ? ` - this count includes ${st.priorReds} red tester round${st.priorReds > 1 ? 's' : ''} of earlier runs of this task (task field prior), in test.md as well` : ''}. Inputs: the tester's findings in ${t.dir}/test.md (every round) and the programmer's rounds in ${t.dir}/prog.md. Write the matrix of cases those findings belong to - every dimension the reds opened, not only the failed cells - and the cause of the reds with file:line, so the next programmer round closes the whole matrix at once. Last red:\n${x.test || ''}`)
  if (!a) return out(stop(t, 'the analyst returned no result'))
  mechBy(st, a, 'red tester round')
  if (!a.ready || a.split.length || a.questions.length) return out(stop(t, 'analyst after the second red tester round: split or an answer is needed', { split: a.split, questions: a.questions, analyst: a.summary }))
  const b = await buildAndTest(t, st, `After the second red tester round the analyst wrote ${t.dir}/analyst.md - a matrix of cases from the tester's findings: red guards for its cells, then the fix of every cell, according to it and to ${t.dir}/test.md.${REWORK(t, a)}`, 'T', 1)
  if (b.fail) return out(stop(t, b.stopWhy || `after the analyst: ${b.fail}`, b))
  const rv = await reviewLoop(t, st, 'T')
  if (rv.ok) return { ok: rv.ok.summary }
  return out(stop(t, rv.stopWhy || `after the analyst: ${rv.fail}`, rv))
}

// Light mode (owner 2026-10-20): programmer-checker -> the selection step (INNER) -> reviewer; no tester role, so no
// tester post-checks (the reviewer's git post-check and the leftovers check at the end run as usual). A rejection -> one
// programmer round (and the selection on its new HEAD) -> the second review; a second rejection goes to the coordinator
// with the proposal to relaunch in the full mode. Why: tasks of up to 100 lines of product took 2-2.6 h through the
// chain against about 0.6 h in one session (measurement 2026-10-20).
async function light(t, st) {
  const s1 = await progStep(t, st, t.start || 'Start with red guards for the cells of the brief (and analyst.md, if any).', '1')
  if (s1.fail) return stop(t, s1.fail, s1)
  const x1 = await reviewChecked(t, st, '1')
  if (x1.fail) return stop(t, x1.fail, x1)
  log(`${t.title}: review 1 (light) - ${x1.rv.verdict}`)
  if (x1.rv.verdict === 'done') return ride(t, st, x1.rv.summary)
  st.rejections = (st.rejections || 0) + 1
  if (st.rejections >= 2) return stop(t, LIGHT_SECOND, { second: true, docsOnly: x1.rv.docsOnly, review: x1.rv.summary })
  const before = st.head
  const s2 = await progStep(t, st, `Review 1 - rejected${x1.rv.docsOnly ? ' for docs only: fix the docs, guard wording or comments it names and change no behaviour' : ''}. Fix according to ${t.dir}/review.md, and run the acceptance again if the fix touches what it checks:\n${x1.rv.summary}`, 'r', `${t.dir}/review.md`)
  if (s2.fail) return stop(t, s2.fail, Object.assign({}, s2, { review: x1.rv.summary }))
  const x2 = await reviewChecked(t, st, '2', `the fix after review 1 (git diff ${before}..${st.head}) and whether review 1 is answered`)
  if (x2.fail) return stop(t, x2.fail, x2)
  log(`${t.title}: review 2 (light) - ${x2.rv.verdict}`)
  if (x2.rv.verdict === 'done') return ride(t, st, x2.rv.summary)
  st.rejections += 1
  return stop(t, LIGHT_SECOND, { second: true, docsOnly: x2.rv.docsOnly, review: x2.rv.summary })
}
const LIGHT_SECOND = 'second review rejection in the light mode: the coordinator relaunches the task in the full mode (drop mode "light": tester, analyst after a second rejection)'

// ---- The integration train after the review (p-train-c3, W1-W15 of p-train-ac) ----
// With guardSubsetCommand a task whose review is done rides the train: one wait step runs scripts/train.js ride
// (enqueue {task, branch, the head after the review, base, dir} + await; the dispatcher is whoever waits, see train.js),
// and its exit code is the verdict, since the workflow reads no files; the details (logs, files, partner) stay in the
// result file <sharedDir>/train/result/<task>-<head>.json, which the next role reads.
//   0 green: the arc branch moved to the train commit -> done. 10 green-unmerged -> done, the merge waits for the
//   coordinator. 11 red, 12 seam, 13 conflict -> a programmer round on the result (a fix round) -> the selection on its
//   new HEAD -> the second review of the diff of the fix -> the train again; a round with no commit (a red explained)
//   goes to the coordinator (UC-8 2d); the second red train of the task sends it to the analyst inside the same run
//   (like the second red tester round; only one analyst per run), then one round, and a red after it stops the task.
//   14 arc-red, 15 coordinator -> stopped for the coordinator (not the environment). 74 the queue unavailable, 75 the
//   queue halted (the environment of a train), 124 the deadline of the step (4 h, coordinator's decision 5) -> stopped
//   with environment; the entry stays and its verdict comes later without an addressee (p-verdict-orphan-a): train.js
//   status names it, train.js watch (the coordinator's background wait) ends on it, a relaunch of the task alone takes it
//   (ride is idempotent: the same task and head queued is kept, a result already there is returned and taken) or the
//   coordinator takes it with train.js ack. 65: refused before the queue (the base is protected or not a branch). At most
//   MAX_RIDES rides per run.
// Without guardSubsetCommand there is no train: done after the review, as before (W13).
const TRAIN_RC = { 0: 'green', 10: 'green-unmerged', 11: 'red', 12: 'seam', 13: 'conflict', 14: 'arc-red', 15: 'coordinator' }
const TRAIN_ENV = {
  74: 'the train queue is unavailable (no queue directory, not writable)',
  75: 'the train queue is halted for the coordinator: the environment of a train (a run cut off before its tally, the runner, the worktree, a git error, an attribution that could not run)',
  124: 'the deadline of the wait step passed (the train did not come back in time)',
  78: 'the dispatcher found no project config (nothing was queued)',
}
const MAX_RIDES = 4
// A conflict round that is only the merge of the arc, with every file resolved by hand in the project's docs
// (mergeOnlyFiles), skips the selection (p-merge-docs; diagnosis (b); the owner took the recommendation on narrowing
// selections, 2026-11-01).
// The check is scripts/merge-only.js run by a cheap service step (the workflow runs no command itself): exit 0 yes, 1 no,
// 2 an error; an answer without a boolean or with an error is repeated once, and a doubt keeps the selection. The seam is
// the train's: it runs the full suite over the arc and the branch. Why (cvm-line-shell 2026-11-01): select-t1 took 21 min
// after a merge that resolved only canvas-model.md; 8 of 15 conflicts before the trains were in docs only.
const MERGE_GLOBS = Array.isArray(CFG.mergeOnlyFiles) ? CFG.mergeOnlyFiles.filter((g) => typeof g === 'string' && g.trim() !== '') : []
// The project's guardFiles go along: a file under a docs glob that is a guard keeps the selection (merge-only.js --guards;
// without the key merge-only.js takes the key's default).
const GUARD_GLOBS = Array.isArray(CFG.guardFiles) ? CFG.guardFiles.filter((g) => typeof g === 'string' && g.trim() !== '') : []
const MERGE_SCHEMA = { type: 'object', properties: {
  mergeOnly: { type: 'boolean' }, reason: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, error: { type: 'string' },
}, required: ['mergeOnly'] }
const mergeCmd = (t, before, head) => `node ${SCRIPTS}/merge-only.js ${sq(before)} ${sq(head)} --base ${sq(String(t.base).trim())} --wt ${sq(t.wt)}${MERGE_GLOBS.map((g) => ` --files ${sq(g)}`).join('')}${GUARD_GLOBS.map((g) => ` --guards ${sq(g)}`).join('')}`
const mergeOnly1 = (t, n, before, head, retry) => agent(`Run one command and return its JSON output as the schema fields (change nothing, analyse nothing):
${mergeCmd(t, before, head)}
Exit 0, 1 and 2 all print JSON: return its fields as printed. If it prints no JSON - mergeOnly=false, error = the error text.`,
  checkOpts(`merge:${t.key}:${n}`, 'Train', MERGE_SCHEMA, retry))
const mergeAnswered = (r) => !!(r && typeof r.mergeOnly === 'boolean' && !r.error)
async function mergeOnlyStep(t, n, before, head) {
  const { res } = await checkTwice(t, `merge-only check of ${before}..${head}`, mergeAnswered, (retry) => mergeOnly1(t, n, before, head, retry))
  return mergeAnswered(res) && res.mergeOnly === true ? res : null
}
const resultOf = (t, head) => `${CFG.sharedDir}/train/result/${t.key}-${head}.json`
const rideCmd = (t, head) => `${CFG.configPath ? `CODIS_AGENTS_CONFIG=${sq(CFG.configPath)} ` : ''}node ${SCRIPTS}/train.js ride --task ${sq(t.key)} --branch ${sq(t.branch)} --head ${sq(head)} --base ${sq(String(t.base).trim())} --dir ${sq(t.dir)}`
const fixTail = (t) => (INNER
  ? 'Commit on the branch (a red guard first when none covers it, mutations after the commit); do not run the selection or a full run yourself: the workflow runs the selection on your new HEAD, then the second review of the diff, then the train again. If there is nothing to fix on the branch (a known or a stale guard), explain it in prog.md and commit nothing: the coordinator decides.'
  : t.light
    ? 'Commit on the branch (a red guard first when none covers it, mutations after the commit); run only the red guards of the result and your new or changed guards, no selection and no full run (innerSelect false). There is no tester round in the light mode: run the acceptance of the cells the fix touches yourself in the real environment and add it to test.md (round of this fix) when the fix touches the product; then the second review of the diff, then the train again. If there is nothing to fix on the branch (a known or a stale guard), explain it in prog.md and commit nothing: the coordinator decides.'
    : 'Commit on the branch (a red guard first when none covers it, mutations after the commit); run only the red guards of the result and your new or changed guards, no selection and no full run (innerSelect false): a fix that touches the product gets a short tester round, then the second review of the diff, then the train again. If there is nothing to fix on the branch (a known or a stale guard), explain it in prog.md and commit nothing: the coordinator decides.')
// innerSelect false (p-train-only): does the fix round of a red train touch the product? Any file outside docs and the
// tester's guards and fixtures (docsOrGuard: testerWritable), and a new commit that names no changed file (unknown is not
// docs); a conflict round that is only the merge of the arc with docs resolved (merge-only) does not.
const touchesProduct = (s) => !s.mergeOnly && (!(s.p && s.p.changedFiles || []).length || (s.p.changedFiles || []).some((f) => !docsOrGuard(f)))
// The short tester round after a red train fixed in the product (owner 2026-11-01, translated: "a short tester round
// after a red train"): the acceptance of the cells the fix touches and the tester's own guards over them, not the whole task again.
// Red -> a programmer round with test.md -> the tester again; the red tester rounds count with the task's others
// (testerRed: the second -> the analyst inside the same run, whose round rides the train itself). Returns null to go on,
// or the task's result.
async function trainTester(t, st, n, v, res, before, extra) {
  for (let k = 1; ; k++) {
    const label = `t${n}${k > 1 ? `-${k}` : ''}`
    const short = `Short tester round after the integration train's ${v} (round ${label}): the train result is ${res}; the programmer fixed it in the product, git -C ${sq(t.wt)} diff ${before}..${st.head}. Do not redo the whole task: find the cells of the acceptance and of the matrix that this fix touches, run the acceptance on those cells in the real environment and your own guards over them (a new guard where a touched cell has none: commit, mutations after the commit). No selection and no full run: the train runs all guards after the second review.`
    const x = await testChecked(t, st, label, short)
    if (x.fail) return stop(t, x.fail, extra)
    const tr = x.tr
    log(`${t.title}: short tester ${label} after the train - ${tr.verdict}`)
    if (tr.verdict === 'green') return null
    if (tr.verdict === 'environment') { const e = envStop(label, tr); return stop(t, e.fail, Object.assign({}, e, extra)) }
    const red = testerRed(t, st, label, tr)
    if (red && red.redAnalyst) { const a = await redAnalystRound(t, st, red); return a.out || { again: a.ok } }
    if (red) return stop(t, red.stopWhy || red.fail, Object.assign({}, extra, { test: tr.summary }))
    if (k === 2) return stop(t, `train ${n} (${v}): the short tester round is still red after a fix round - the coordinator decides`, Object.assign({}, extra, { test: tr.summary }))
    const s2 = await progStep(t, st, `Short tester round ${label} after the train's ${v} - red. Fix according to ${t.dir}/test.md:\n${tr.summary}`, `${label}f`, `${t.dir}/test.md`)
    if (s2.fail) return stop(t, s2.fail, Object.assign({}, s2, extra))
  }
}
const trainTask = (t, v, res) => {
  const base = String(t.base).trim()
  if (v === 'red') return `The integration train came back red for your branch (verdict red): read the result ${res} - its train log (log), the attribution log (attribution) and the guards red on the arc head ${base} + your branch alone (guards); copies of the logs are in ${t.dir}. Fix the red on the branch. ${fixTail(t)}`
  if (v === 'conflict') return `The integration train excluded your branch: merging it into the train conflicts (verdict conflict; the files are in ${res}, field files). Your fix: merge the head of the arc branch ${base} into your branch ${t.branch} and resolve the conflict, then check the guards of those files. ${fixTail(t)}${MERGE_GLOBS.length ? ` When every file you resolve matches mergeOnlyFiles (${MERGE_GLOBS.join(', ')}), commit the merge alone - one merge commit, no other edits and no other commits: the workflow then skips the selection (scripts/merge-only.js) and goes to the second review and the train.` : ''}`
  return `The integration train found a seam (verdict seam): your branch is green alone on the arc head but red together with its partner, named in ${res} (partner, partnerBranch; the guards in guards; partnerResult is the partner's own result - it arrived first and rode before you). Your fix: merge the head of the arc branch ${base} into your branch ${t.branch} (it holds the partner once partnerResult is green) and fix the seam with it on that head. ${fixTail(t)}`
}
async function ride(t, st, review) {
  if (!ONE_RUN) return { task: t.key, status: 'done', review }
  const results = []
  for (let n = 1; ; n++) {
    const head = st.head, step = `train-${n}`, res = resultOf(t, head)
    const r = await runStep(t, step, rideCmd(t, head), 'Train')
    const f = runFail(step, r)
    // the ride may have queued its entry before it died (killed from outside, the Mac asleep or rebooted): then the entry
    // stays with a dead waiter and its verdict comes without an addressee (source S8 of p-verdict-orphan)
    if (f) return stop(t, `${f}; branch ${t.branch} head ${head} - the review accepted it; the ride may have queued it before it stopped: when train.js status lists the entry, its verdict comes later without an addressee - train.js watch (the coordinator's background wait) ends on it, then relaunch the task alone (its ride takes the ready verdict) or take it by hand with train.js ack --task ${t.key} --head ${head}; when it is not listed, the coordinator queues it (train.js enqueue) or relaunches the task alone`, { review })
    const v = TRAIN_RC[r.rc]
    const info = { rc: r.rc, verdict: v || 'environment', result: res, log: r.log, tail: r.tail || '' }
    log(`${t.title}: train ${n} - exit ${r.rc}${v ? ` (${v})` : ''}`)
    const keep = `the queue entry stays (branch ${t.branch} head ${head}) and its verdict comes later without an addressee: train.js status names it under "verdicts without an addressee", train.js watch (the coordinator's background wait) ends on it; then relaunch the task alone (its ride takes the ready verdict) or take it by hand with train.js ack --task ${t.key} --head ${head}`
    if (v === 'green') return { task: t.key, status: 'done', review, train: info }
    if (v === 'green-unmerged') return { task: t.key, status: 'done', review, train: Object.assign(info, { note: `green, the merge waits for the coordinator: it merges the train commit named in ${res} (refs/runs/train/<id>)` }) }
    if (v === 'arc-red') return stop(t, `train ${n}: arc-red - the arc branch ${String(t.base).trim()} itself is red without the passengers (the train's halt and ${res} name the guards); the coordinator fixes it and runs train.js resume; ${keep}`, { review, train: info })
    if (v === 'coordinator') return stop(t, `train ${n}: halted for the coordinator - a red train with no automatic attribution (the reason is in train.js status and the halt); the coordinator decides and runs train.js resume; ${keep}`, { review, train: info })
    if (!v) {
      if (r.rc === 65) return stop(t, `train ${n}: refused before the queue (exit 65: the base ${String(t.base).trim()} is a protected branch or not a branch of the repository); log ${r.log}`, { review, train: info })
      if (TRAIN_ENV[r.rc]) {
        const why = `exit ${r.rc}: ${TRAIN_ENV[r.rc]}; ${r.rc === 74 || r.rc === 78 ? `branch ${t.branch} head ${head} is not queued - the review accepted it, the coordinator queues it (train.js enqueue) or relaunches the task alone` : keep}; log ${r.log}`
        return stop(t, `train ${n}: red from the environment, not the product - ${why}`, { environment: why, review, train: info })
      }
      return stop(t, `train ${n}: train.js ride exit ${r.rc} (log ${r.log}) - the coordinator decides; ${keep}`, { review, train: info })
    }
    results.push(res)
    if (n === MAX_RIDES) return stop(t, `train ${n}: still ${v} after ${MAX_RIDES} rides - the coordinator decides`, { review, train: info })
    let task = '', fix = res
    if (v === 'red') {
      st.trainReds = (st.trainReds || 0) + 1
      if (st.analyst === 'train-red') return stop(t, `train red after analyst (train ${n})`, { review, train: info })
      if (!st.analyst && st.trainReds >= 2) {
        st.analyst = 'train-red'
        st.rejections = 0
        log(`${t.title}: train ${n} - the second red train of the task - analyst`)
        const a = await analyst(t, `${MECH_OR_CELLS(t, st)}the second red train for this task (the integration train after the review; like the second red tester round). Inputs: the train results ${results.join(', ')} (each names its train log, its attribution log and the guards red on the arc head + this branch alone) and the programmer's rounds in ${t.dir}/prog.md. Write the matrix of cases those reds belong to and their cause with file:line, so the next programmer round closes the whole matrix at once.`)
        if (!a) return stop(t, 'the analyst returned no result', { review, train: info })
        mechBy(st, a, 'red train')
        if (!a.ready || a.split.length || a.questions.length) return stop(t, 'analyst after the second red train: split or an answer is needed', { split: a.split, questions: a.questions, analyst: a.summary, review, train: info })
        task = `After the second red train the analyst wrote ${t.dir}/analyst.md - a matrix of cases from the train's reds (${results.join(', ')}): red guards for its cells, then the fix of every cell.${REWORK(t, a)} ${fixTail(t)}`
        fix = null
      }
    }
    const before = st.head
    const s = await progStep(t, st, task || trainTask(t, v, res), `t${n}`, fix, true, v === 'conflict' && MERGE_GLOBS.length > 0)
    if (s.fail) return stop(t, s.fail, Object.assign({}, s, { review, train: info }))
    if (s.same) return stop(t, `train ${n} (${v}): the programmer committed nothing (the red explained, not fixed: ${s.p && s.p.summary || '?'}) - the coordinator decides; the branch is not queued again`, { review, train: info })
    if (!INNER && !t.light && touchesProduct(s)) {
      const out = await trainTester(t, st, n, v, res, before, { review, train: info })
      if (out && out.again !== undefined) { review = out.again; continue }
      if (out) return out
    }
    const skipped = s.mergeOnly ? `; merge-only docs: selection skipped - the round is only the merge of the arc ${String(t.base).trim()} and every file resolved by hand matches mergeOnlyFiles (${(s.mergeOnly.files || []).join(', ') || 'none'}); check that the resolution keeps the content of both sides` : ''
    const x = await reviewChecked(t, st, `t${n}`, `only the diff of the fix after train ${n} (git diff ${before}..${st.head}): does it answer the train's ${v} (${res}) and change nothing else${skipped}`)
    if (x.fail) return stop(t, x.fail, Object.assign({}, x, { train: info }))
    log(`${t.title}: review t${n} - ${x.rv.verdict}`)
    if (x.rv.verdict !== 'done') return stop(t, `train ${n} (${v}): the review of the fix rejected it - the coordinator decides`, { review: x.rv.summary, train: info })
    review = x.rv.summary
  }
}

const results = await pipeline(TASKS, (t) => chain(t))
return results.map((r, i) => r || stop(TASKS[i], 'the chain crashed'))
