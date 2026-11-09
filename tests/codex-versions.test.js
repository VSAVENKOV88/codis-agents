#!/usr/bin/env node
'use strict';
// The verified versions of codex (p-codex-v167, cells C2-C4 of its analysis and decisions Q1, Q2, G2 of its brief): one
// list, VERIFIED_CODEX_VERSIONS of scripts/commit-service.js (the probe of the commit channel's sandbox), which
// scripts/role-exec.js takes as the allowed list of `check` - the very same array, not a copy, so an update of codex
// that names one place cannot leave the other refusing. The list holds 0.166.0 and 0.167.0.
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const RE = require(path.join(ROOT, 'scripts', 'role-exec.js'));
const CS = require(path.join(ROOT, 'scripts', 'commit-service.js'));

ok('C3 role-exec.js exports DEFAULT_CODEX_VERSIONS', Array.isArray(RE.DEFAULT_CODEX_VERSIONS), String(RE.DEFAULT_CODEX_VERSIONS));
ok('C3 DEFAULT_CODEX_VERSIONS of role-exec.js is the same array as VERIFIED_CODEX_VERSIONS of commit-service.js (===)',
  RE.DEFAULT_CODEX_VERSIONS === CS.VERIFIED_CODEX_VERSIONS);
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'role-exec.js'), 'utf8');
const literal = src.split('\n').filter((l) => !/^\s*\/\//.test(l) && /['"]\d+\.\d+\.\d+['"]/.test(l));
ok('C3 role-exec.js has no version literal of its own', literal.length === 0, literal.join(' | '));
ok('C2/C4 the verified versions are 0.166.0 and 0.167.0', JSON.stringify(CS.VERIFIED_CODEX_VERSIONS) === JSON.stringify(['0.166.0', '0.167.0']), JSON.stringify(CS.VERIFIED_CODEX_VERSIONS));
done();
