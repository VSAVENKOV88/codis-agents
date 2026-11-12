#!/usr/bin/env node
'use strict';
// The census of git calls (p-codex-A2b-2h-1, cell H2; invariant I-g of the analysis): every git process the plugin's
// trusted processes start goes through scripts/trusted-git.js, except the named exceptions E1-E8 below, each with its
// reason. Files: what git tracks under scripts/ and workflows/ - *.js, *.sh, *.zsh and files whose first line is
// "#!/usr/bin/env node" (scripts/git-hooks/*); tests/, skills/, rules/ and *.md are fixtures and texts for agents, not
// processes of the plugin. Forms:
//   (a) JS: a call whose first argument is the literal 'git' ("git", `git`): spawnSync('git', sh('git', run('git',
//       lit('git') ...), except the lookup of the binary which('git', ...);
//   (b) JS: spawnSync / execFileSync / spawn / execFile / execSync whose first argument is not a literal: each is in
//       the table below with its class - not git (node itself, a codex binary, the sandbox, a generic runner whose git
//       callers form (a) sees), the module, or a git binary of an exception;
//   (c) shell: the word git in command position (line start, after ; & | ( $( then else do) outside comment lines must
//       be followed by "${TRUSTED_GIT[@]}", the array the file fills from `trusted-git.js flags`.
// Every entry of the tables matches exactly its count of places: a new place fails as unknown, a place gone fails as
// an exception without a place (the list does not pile up).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');

// Form (a): the literal 'git' outside the module - the exceptions E1-E8 (the analysis, section 2.1).
const LITERAL = [
  { file: 'scripts/chain-run.js', has: "spawnSync('git', ['-c', 'core.fsmonitor=false', 'config', '--get', k]", count: 1,
    why: 'E4: the identity of a codex commit (config --get, inert); already core.fsmonitor=false' },
  { file: 'scripts/standing-push.js', has: "spawnSync('git'", count: 1,
    why: 'E5: the standing-push check of the user\'s own repository, called only from E6 and the pre-push hook of a push the user started there' },
  { file: 'scripts/hooks/guard-bash.js', has: "spawnSync('git'", count: 5,
    why: 'E6: the PreToolUse hook over the agent\'s own git command in its own directory (rev-parse, symbolic-ref, remote get-url: inert)' },
  { file: 'scripts/git-hooks/pre-commit.js', has: "spawnSync('git'", count: 1,
    why: 'E7: a git hook of the user, run inside the user\'s git commit, where that repository\'s hooks already act' },
  { file: 'scripts/config.js', has: "spawnSync('git', ['config', '--name-only', '--list', '-z']", count: 1,
    why: 'E7: remoteHead, called only by pushBranches from the pre-push hook of the user\'s git push (reads url.insteadOf)' },
  { file: 'scripts/config.js', has: "spawnSync('git', ['ls-remote', '--get-url'", count: 1, why: 'E7: remoteHead (as above; the user\'s ssh)' },
  { file: 'scripts/config.js', has: "spawnSync('git', ['ls-remote', '--symref'", count: 1, why: 'E7: remoteHead (as above)' },
  { file: 'workflows/role-chain.js', has: "lit('git')", count: 1,
    why: 'E8: the step sha of the Workflow script (rev-parse --verify, inert); the script loads no module' },
];
// Form (b): a first argument that is not a literal.
const DYNAMIC = [
  { file: 'scripts/trusted-git.js', has: 'spawnSync(bin, argv(args), o)', count: 1, cls: 'the module' },
  { file: 'scripts/commit-service.js', has: 'spawnSync(gitBin,', count: 1, cls: 'git: E1 - its own SAFE_C recipe (empty hooksPath, fsmonitor=false, protocol.allow=never, GIT_CONFIG_GLOBAL=/dev/null) in the sandbox of the commit channel' },
  { file: 'scripts/commit-walk.js', has: 'spawnSync(job.git, job.gitArgs.concat(args)', count: 1, cls: 'git: E2 - gitArgs are SAFE_C of commit-service.js' },
  { file: 'scripts/role-exec.js', has: "spawnSync(bin, ['-c', 'core.fsmonitor=false', '-C', wt]", count: 1, cls: 'git: E3 - gitRead (rev-parse, merge-base: inert), GIT_* dropped, fsmonitor=false' },
  { file: 'scripts/role-exec.js', has: 'spawnSync(bin, args, { encoding', count: 1, cls: 'not git: a generic runner (its git callers are form (a))' },
  { file: 'scripts/role-exec.js', has: 'spawnSync(interp,', count: 1, cls: 'not git: the interpreter probe' },
  { file: 'scripts/commit-service.js', has: 'spawn(spec.bin,', count: 3, cls: 'not git: the sandbox of the commit channel' },
  { file: 'scripts/heavy-exec.js', has: 'spawn(spec.bin,', count: 1, cls: 'not git: the codex sandbox' },
  { file: 'scripts/heavy-service.js', has: 'spawn(spec.bin,', count: 1, cls: 'not git: the codex sandbox' },
  { file: 'scripts/heavy-service.js', has: 'spawnSync(codexBin,', count: 1, cls: 'not git: codex --version' },
  { file: 'scripts/codex-hooks-check.js', has: 'spawn(codex,', count: 1, cls: 'not git: codex app-server' },
  { file: 'scripts/analysis-check.js', has: 'spawn(argv[0],', count: 1, cls: 'not git: the check command' },
  { file: 'scripts/chain-run.js', has: 'spawn(argv[0],', count: 1, cls: 'not git: an exec step of the conductor (git only through E8)' },
  { file: 'scripts/detect.js', has: 'spawnSync(cmd, args,', count: 1, cls: 'not git: the generic sh (its git callers go through the module)' },
  { file: 'scripts/wt-remove-check.js', has: 'spawnSync(cmd, a,', count: 1, cls: 'not git: the generic run (du, find)' },
  { file: 'scripts/role-leftovers-check.js', has: 'spawnSync(cmd, a,', count: 1, cls: 'not git: the generic run (docker, ps, lsof)' },
];

const files = spawnSync('git', ['-C', ROOT, 'ls-files', '-z', '--', 'scripts', 'workflows'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean)
  .filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());
const text = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const isJs = (f) => f.endsWith('.js') || (!/\.[a-z]+$/.test(path.basename(f)) && text(f).startsWith('#!/usr/bin/env node'));
const isSh = (f) => /\.(sh|zsh)$/.test(f);
ok('the census reads the plugin\'s scripts (trusted-git.js, train.js, guards-all.sh, wt-setup.sh, git-hooks/pre-push among them)',
  ['scripts/trusted-git.js', 'scripts/train.js', 'scripts/guards-all.sh', 'scripts/wt-setup.sh', 'scripts/git-hooks/pre-push', 'workflows/role-chain.js'].every((f) => files.includes(f) && (isJs(f) || isSh(f))), files.join(' '));

// JS text with comment lines blanked (a line whose code starts with // or *), line numbers kept.
const code = (s) => s.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');
const lineAt = (s, i) => s.slice(0, i).split('\n').length;
const lineText = (s, n) => s.split('\n')[n - 1].trim();

const literalHits = [], dynamicHits = [], shellHits = [], shellNoArray = [];
for (const f of files) {
  if (isJs(f)) {
    const s = code(text(f));
    for (const m of s.matchAll(/([A-Za-z_$][\w$.]*)\(\s*(['"`])git\2/g)) {
      if (m[1] === 'which' || m[1].endsWith('.which')) continue;
      const n = lineAt(s, m.index);
      literalHits.push({ file: f, line: n, text: lineText(s, n) });
    }
    for (const m of s.matchAll(/(?<![\w$.])(?:[\w$]+\.)?(spawnSync|execFileSync|spawn|execFile|execSync)\(\s*([^'"`\s)][^,)]*)/g)) {
      if (m[2].trim() === 'process.execPath') continue;
      const n = lineAt(s, m.index);
      dynamicHits.push({ file: f, line: n, text: lineText(s, n) });
    }
  } else if (isSh(f)) {
    const lines = text(f).split('\n');
    let found = false;
    lines.forEach((l, i) => {
      if (/^\s*#/.test(l)) return;
      for (const m of l.matchAll(/(^|[;&|(]|\$\(|\bthen\b|\belse\b|\bdo\b)\s*git(?=\s|$)/g)) {
        found = true;
        const after = l.slice(m.index + m[0].length);
        if (!/^\s+"\$\{TRUSTED_GIT\[@\]\}"/.test(after)) shellHits.push({ file: f, line: i + 1, text: l.trim() });
      }
    });
    if (found && !/^TRUSTED_GIT=\(\$\{\(f\)"\$\(node "\$H\/trusted-git\.js" flags\)"\}\)/m.test(text(f))) shellNoArray.push(f);
  }
}

// Each place matches one entry; each entry matches exactly its count.
function audit(hits, table, label) {
  const unknown = hits.filter((h) => !table.some((e) => e.file === h.file && h.text.includes(e.has)));
  ok(`(${label}) every place is through the module or a named entry`, unknown.length === 0,
    unknown.map((h) => `${h.file}:${h.line}: ${h.text.slice(0, 160)}`).join('\n         '));
  for (const e of table) {
    const n = hits.filter((h) => h.file === e.file && h.text.includes(e.has)).length;
    ok(`(${label}) ${e.file} "${e.has.slice(0, 60)}": ${e.count} place${e.count === 1 ? '' : 's'} - ${(e.why || e.cls).slice(0, 90)}`, n === e.count,
      n === 0 ? 'an exception without a place: remove it from the table' : `${n} places found`);
  }
}
audit(literalHits, LITERAL, 'a');
audit(dynamicHits, DYNAMIC, 'b');
ok('(c) every git in command position of a shell script carries "${TRUSTED_GIT[@]}"', shellHits.length === 0,
  shellHits.map((h) => `${h.file}:${h.line}: ${h.text.slice(0, 160)}`).join('\n         '));
ok('(c) a shell script that calls git fills TRUSTED_GIT from trusted-git.js flags', shellNoArray.length === 0, shellNoArray.join(' '));
ok('(c) guards-all.sh and wt-setup.sh call git (the census sees them)', ['scripts/guards-all.sh', 'scripts/wt-setup.sh'].every((f) =>
  text(f).split('\n').some((l) => !/^\s*#/.test(l) && /(^|[;&|(]|\$\()\s*git\s/.test(l))));
// E8 is named next to its place, so a change of its subcommand is seen there.
ok('E8: workflows/role-chain.js names the exception next to lit(\'git\')', /trusted-git-census/.test(text('workflows/role-chain.js')));

// ---- the forms (a)-(c) do not see (tester of p-codex-A2b-2h-1) ----
//   (d) shell: a script found by its first line (#!/bin/sh, zsh, bash; with or without an extension) and git after if,
//       elif, while, until, !, {, exec, command, time, xargs or a backquote - command positions (c) does not list;
//   (e) JS: a command line handed to a shell - the literal first argument of execSync / exec, or the literal after '-c'
//       of spawnSync / spawn / execFileSync / execFile of sh, zsh or bash - with git in command position.
const POS = '(^|[;&|(`{!]|\\$\\(|\\b(?:then|else|elif|do|if|while|until|exec|command|time|xargs)\\b)\\s*git';
const SHELL_GIT = new RegExp(POS + '(?=\\s|$|[\'"`])');
const SHELL_GIT_OK = new RegExp(POS + '\\s+"\\$\\{TRUSTED_GIT\\[@\\]\\}"', 'g');
// Lines of a shell text that call git without the trusted flags (comment lines aside).
const shellGitLines = (s) => s.split('\n').map((l, i) => ({ l, n: i + 1 }))
  .filter(({ l }) => !/^\s*#/.test(l) && SHELL_GIT.test(l.replace(SHELL_GIT_OK, ' ')));
const SHELLS = '(?:\\/(?:usr\\/)?bin\\/)?(?:sh|zsh|bash)';
function jsShellGit(src) {
  const s = code(src), hits = [];
  const check = (lit, at) => { if (shellGitLines(lit).length) hits.push(lineAt(s, at)); };
  for (const m of s.matchAll(/(?<![\w$])(?:[\w$]+\.)?(?:execSync|exec)\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g)) check(m[2], m.index);
  for (const m of s.matchAll(new RegExp(`(?<![\\w$])(?:[\\w$]+\\.)?(?:spawnSync|spawn|execFileSync|execFile)\\(\\s*(['"\`])${SHELLS}\\1\\s*,\\s*\\[([^\\]]*)\\]`, 'g'))) {
    for (const x of m[2].matchAll(/(['"`])-c\1\s*,\s*(['"`])((?:\\.|(?!\2)[\s\S])*)\2/g)) check(x[3], m.index);
  }
  return hits;
}
// The scanners see what they must (a scanner that sees nothing would make the census below green for nothing).
ok('(d) control: if git, while git, ! git, { git, exec git, command git, a backquote - each is seen; git "${TRUSTED_GIT[@]}" is not',
  ['if git -C "$W" status; then :; fi', 'while git -C x rev-parse HEAD >/dev/null; do :; done', '! git diff --quiet', '{ git status; }', 'exec git status',
    'command git status', 'x=`git rev-parse HEAD`', 'elif git status; then', 'time git status'].every((l) => shellGitLines(l).length === 1)
  && shellGitLines('if git "${TRUSTED_GIT[@]}" -C "$W" status; then :; fi').length === 0 && shellGitLines('# if git status').length === 0
  && shellGitLines('echo "a digit or a gitter"').length === 0);
ok('(e) control: execSync(\'git ...\'), exec(`cd x && git ...`), spawnSync(\'sh\', [\'-c\', \'... git ...\']), spawn(\'/bin/zsh\', [\'-c\', ...]) are seen; a shell line without git is not',
  jsShellGit("execSync('git -C x status')").length === 1 && jsShellGit('cp.exec(`cd ${w} && git status`, cb)').length === 1
  && jsShellGit("spawnSync('sh', ['-c', 'cd \"$1\" && git ls-files', 'x', w])").length === 1
  && jsShellGit("spawn('/bin/zsh', ['-c', 'if git status; then :; fi'])").length === 1
  && jsShellGit("spawnSync('zsh', ['-c', 'source \"$1\" || exit 2; slot_is_exclusive_guard \"$@\"', 'excl'])").length === 0
  && jsShellGit("// execSync('git status')").length === 0);

const shebangShell = (f) => /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/(?:usr\/)?bin\/)?(?:sh|zsh|bash)\b/.test(text(f).split('\n')[0]);
const shellFiles = files.filter((f) => isSh(f) || shebangShell(f));
ok('(d) the shell scan reads every shell script, scripts/git-hooks/pre-commit (#!/bin/sh, no extension) among them',
  ['scripts/git-hooks/pre-commit', 'scripts/wt-setup.sh', 'scripts/guards-all.sh', 'scripts/slots.zsh'].every((f) => shellFiles.includes(f)), shellFiles.join(' '));
const dHits = [];
for (const f of shellFiles) for (const h of shellGitLines(text(f))) dHits.push(`${f}:${h.n}: ${h.l.trim().slice(0, 160)}`);
ok('(d) no shell script calls git after if, while, !, {, exec, command or in a backquote without "${TRUSTED_GIT[@]}"', dHits.length === 0, dHits.join('\n         '));
const eHits = [];
for (const f of files.filter(isJs)) for (const n of jsShellGit(text(f))) eHits.push(`${f}:${n}`);
ok('(e) no JS hands a shell a command line that runs git (execSync, exec, sh/zsh/bash -c)', eHits.length === 0, eHits.join('\n         '));
done();
