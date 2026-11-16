#!/usr/bin/env node
'use strict';
// The project side of the shared stand (scripts/stand.sh holds the ticket): reads the section "stand" of the project
// config, fills the placeholders of its commands and tells whether a task's commits touch the stand's image files.
// The plugin knows nothing about what the commands do; they are the project's.
//
// usage: stand.js check                     -> exit 0 when the config validates and has a stand section, else the
//                                              error text on stderr and exit 78
//        stand.js cmd <up|deploy|reset|status|down> [--wt <dir>]
//                                           -> the command with {project} {port} {ports} {repo} {wt} filled in
//                                              (each value shell-quoted); deploy needs --wt
//        stand.js freshness [--target <ref-or-sha> | --wt <dir>] [--gate]
//                                           -> read-only snapshot; gate exits 69 on stale/unknown/down
//        stand.js get <key>                 -> one value of the section (arrays space-separated); get cwd gives
//                                              stand.cwd, or repoDir when it is not set
//        stand.js image-diff --base <ref> [--wt <dir>]
//                                           -> files changed by the commits of the worktree since <ref>
//                                              (git diff --no-renames <ref>...HEAD: committed work only) that match
//                                              stand.imageFiles; exit 0 none (the stand fits), 1 some (the task builds
//                                              its own stack), 2 the diff could not be taken
// A glob of imageFiles without "/" matches the file name at any depth; with "/" it matches the path from the
// repository root; * and ? stay within one path segment, ** crosses segments.
const path = require('path');
const { spawnSync } = require('child_process');
const TG = require('./trusted-git');
const cfg = require('./config');

const CMDS = ['up', 'deploy', 'reset', 'status', 'down'];
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function loadStand(env = process.env) {
  const f = cfg.find(process.cwd(), env);
  if (!f) return { error: 'no project config (.claude/codis-agents.json) found' };
  const { config, errors } = cfg.load(f);
  if (errors.length) return { error: `the project config ${f} does not validate:\n` + errors.map((e) => 'codis-agents config: ' + e).join('\n') };
  if (!config.stand) return { error: `no stand section in the project config ${f}: the project has no shared stand` };
  return { config, stand: config.stand };
}

function fill(cmd, config, wt) {
  const s = config.stand;
  const v = { project: s.project, port: s.ports.length ? String(s.ports[0]) : '', ports: s.ports.join(' '), repo: config.repoDir, wt };
  return cmd.replace(/\{(project|port|ports|repo|wt)\}/g, (m, k) => (k === 'ports' ? s.ports.map(String).map(q).join(' ') : v[k] === undefined ? m : q(v[k])));
}

// Glob -> RegExp by the rule above.
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') { re = re.slice(0, -2) + '(?:.*/)?'; i++; } }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matches = (globs, file) => globs.some((g) => (g.includes('/') ? globRe(g).test(file) : globRe(g).test(path.posix.basename(file))));

// Freshness is a snapshot of two committed trees, never a comparison of commit identities or merge bases.
// The probe is project-owned; only its validated SHA may leave this boundary, never its raw diagnostics.
function freshness(config, { target, wt, env = process.env } = {}) {
  const stand = config.stand;
  if (!stand) return null;
  const result = { project: stand.project, target: wt ? 'HEAD' : target || null, targetSha: null, imageBase: null, files: [] };
  const state = (name, reason) => Object.assign(result, { state: name, ...(reason ? { reason } : {}) });
  if (!wt && !target) return state('unchecked', 'target not specified');
  if (!stand.imageBase) return state('unchecked', 'imageBase not configured');
  if (!stand.imageFiles.length) return state('unchecked', 'no image files configured');
  const cwd = wt || config.repoDir;
  const git = args => TG.run(['-C', cwd, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  const ref = git(['rev-parse', '--verify', '--end-of-options', `${wt ? 'HEAD' : target}^{commit}`]);
  if (ref.status !== 0 || !/^[a-f0-9]{40}\n?$/.test(ref.stdout || '')) return state('unknown', 'cannot resolve target commit');
  result.targetSha = ref.stdout.trim();
  const run = command => spawnSync('zsh', ['-c', fill(command, config, wt)], {
    cwd: stand.cwd || config.repoDir, env: { ...env, CODIS_AGENTS_CONFIG: config.configPath || env.CODIS_AGENTS_CONFIG }, encoding: 'utf8',
  });
  const up = run(stand.status);
  if (up.status !== 0) return state('down', `status exit ${up.status === null ? 'unavailable' : up.status}`);
  const probe = run(stand.imageBase);
  if (probe.status !== 0) return state('unknown', `imageBase exit ${probe.status === null ? 'unavailable' : probe.status}`);
  if (!/^[a-fA-F0-9]{40}\n?$/.test(probe.stdout || '')) return state('unknown', 'imageBase must return one full commit SHA');
  result.imageBase = probe.stdout.trim().toLowerCase();
  const base = git(['cat-file', '-t', result.imageBase]);
  if (base.status !== 0 || base.stdout.trim() !== 'commit') return state('unknown', 'imageBase commit unavailable');
  const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', result.imageBase, result.targetSha, '--']);
  if (diff.status !== 0) return state('unknown', 'cannot compare image trees');
  result.files = diff.stdout.split('\0').filter(f => f && matches(stand.imageFiles, f));
  return state(result.files.length ? 'stale' : 'fresh');
}

function freshnessText(r) {
  const target = !r.target ? '' : /^[a-fA-F0-9]{40}$/.test(r.target)
    ? `; target SHA ${r.targetSha || r.target}` : `; target ref ${r.target} @ ${r.targetSha || 'unresolved'}`;
  return `stand ${r.state}: ${r.project}${r.reason ? ': ' + r.reason : ''}${r.imageBase ? '; base ' + r.imageBase : ''}${target}${r.files.length ? '; files ' + r.files.map(f => JSON.stringify(f)).join(', ') : ''}`;
}

module.exports = { loadStand, fill, globRe, matches, CMDS, freshness, freshnessText };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const die = (msg, code) => { console.error(msg); process.exit(code); };
  const L = loadStand();
  if (L.error) die('stand: refused - ' + L.error, 78);
  const { config, stand } = L;
  const cmd = a[0];
  if (cmd === 'check') process.exit(0);
  if (cmd === 'freshness') {
    const r = freshness(config, { target: opt('--target'), wt: opt('--wt') });
    console.log(freshnessText(r));
    process.exit(a.includes('--gate') && ['stale', 'unknown', 'down'].includes(r.state) ? 69 : 0);
  } else if (cmd === 'cmd') {
    const name = a[1], wt = opt('--wt');
    if (!CMDS.includes(name)) die(`usage: stand.js cmd <${CMDS.join('|')}> [--wt <dir>]`, 64);
    if (name === 'deploy' && !wt) die('stand.js cmd deploy: --wt <dir> is required', 64);
    console.log(fill(stand[name], config, wt));
  } else if (cmd === 'get') {
    const v = a[1] === 'cwd' ? stand.cwd || config.repoDir : stand[a[1]];
    if (v === undefined) process.exit(1);
    console.log(Array.isArray(v) ? v.join(' ') : v === null ? '' : String(v));
  } else if (cmd === 'image-diff') {
    const base = opt('--base'), wt = path.resolve(opt('--wt') || process.cwd());
    if (!base) die('usage: stand.js image-diff --base <ref> [--wt <dir>]', 64);
    const top = TG.run(['-C', wt, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (top.status !== 0) die(`stand image-diff: ${wt} is not a git worktree: ${top.stderr.trim()}`, 2);
    const d = TG.run(['-C', top.stdout.trim(), 'diff', '--no-renames', '--name-only', `${base}...HEAD`], { encoding: 'utf8' });
    if (d.status !== 0) die(`stand image-diff: cannot diff ${base}...HEAD in ${wt}: ${d.stderr.trim()}`, 2);
    const files = d.stdout.split('\n').filter(Boolean);
    const hit = files.filter((f) => matches(stand.imageFiles, f));
    if (!hit.length) { console.log(`stand ${stand.project}: no image files changed since ${base} (${files.length} files changed) - the stand fits`); process.exit(0); }
    console.log(`stand ${stand.project}: the task changes files of the stand's image since ${base} - it builds its own stack:\n` + hit.map((f) => '  ' + f).join('\n'));
    process.exit(1);
  } else die('usage: stand.js check | cmd <name> [--wt <dir>] | get <key> | image-diff --base <ref> [--wt <dir>]', 64);
}
