#!/usr/bin/env node
'use strict';
// p-codex-D1b, P4 (owner 2026-11-05, answer 2: no second Codex manifest, a test forbids it): Codex CLI 0.166.0 installs
// this repository from `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json`, the one place of the name and
// the version. Measured: `.codex-plugin/plugin.json` overrides the version, `.agents/plugins/marketplace.json` and
// `.agents/plugins/api_marketplace.json` override the marketplace name; a root `plugin.json` is not read by 0.166.0 but
// is the portable manifest of the Codex docs. None of them may exist, tracked or not. `.cursor-plugin/*` overrides
// nothing in Codex and is not forbidden here.
// D-1: README "Install" tells how to install under Codex and names the trust check; "What is inside" lists the script.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const FORBIDDEN = ['.codex-plugin', 'plugin.json', '.agents/plugins/marketplace.json', '.agents/plugins/api_marketplace.json'];
const files = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
for (const f of FORBIDDEN) {
  const tracked = files.filter((x) => x === f || x.startsWith(f + '/'));
  ok(`P4 no ${f} in the repository`, !fs.existsSync(path.join(ROOT, f)) && !tracked.length, tracked.join(', ') || f);
}
ok('P4 the one manifest pair is .claude-plugin/', fs.existsSync(path.join(ROOT, '.claude-plugin', 'plugin.json')) && fs.existsSync(path.join(ROOT, '.claude-plugin', 'marketplace.json')));

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const section = (h) => { const m = readme.match(new RegExp(`^## ${h}\\s*$[\\s\\S]*?(?=^## )`, 'm')); return m ? m[0] : ''; };
const install = section('Install');
ok('D-1 README Install has a Codex CLI part with CODEX_HOME, /hooks, the check and the update', /codex plugin marketplace add/.test(install)
  && /codex plugin add codis-agents@codis-agents/.test(install) && /CODEX_HOME=/.test(install) && /\/hooks/.test(install)
  && /scripts\/codex-hooks-check\.js --codex-home/.test(install) && /marketplace upgrade/.test(install), install.slice(0, 200));
ok('D-1 README "What is inside" lists scripts/codex-hooks-check.js', /\| `scripts\/codex-hooks-check\.js` \|/.test(section('What is inside')));
const scripts = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => fs.statSync(path.join(ROOT, 'scripts', f)).isFile()).length;
const tests = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => /\.test\.(js|sh)$/.test(f)).length;
const inside = section("What's inside");
ok(`D-1 README "What's inside" counts ${scripts} scripts and ${tests} test files`, inside.includes(`${scripts} scripts`) && inside.includes(`${tests} test files`), inside.match(/\d+ scripts|\d+ test files/g));
done();
