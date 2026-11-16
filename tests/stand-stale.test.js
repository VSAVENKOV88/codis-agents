#!/usr/bin/env node
'use strict';
// tests:quiet - real stand ticket and medium queue transitions
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const fixture = require('./stand-stale-fixture');
const { has, skip, done } = require('./lib');
if (!has('zsh')) { skip('stand freshness integration', 'zsh not found'); done(); }
(async () => {
  const f = fixture(); let count = 0;
  const check = (name, yes, detail = '') => { assert(yes, name + ': ' + detail); console.log('ok ' + name); count++; };
  const status = target => f.st('status', ...(target ? ['--target', target] : []));
  try {
    // The old config is valid on the unfixed plugin: red means missing behaviour, not a schema rejection.
    check('C13 legacy status says unchecked', /unchecked/.test(status(f.task).text), status(f.task).text);
    f.probe();
    let r = status(f.task);
    check('C7 inherited image change is stale, full SHAs and path', /stand stale/.test(r.text) && r.text.includes(f.base) && r.text.includes(f.task) && r.text.includes('Dockerfile'), r.text);
    check('C24 no target is unchecked', /unchecked.*target not specified/.test(status().text));
    r = f.st('take');
    check('C17 stale refuses before reset, no ticket or queue', r.status === 69 && /stand stale/.test(r.text) && !f.log() && !fs.existsSync(path.join(f.slots, 'stand.lock.who')), r.text);
    for (const value of ['bad SECRET\n', f.base + '\nSECRET\n', ' ' + f.base, f.base + '\n\n', 'f'.repeat(40)]) {
      f.put(f.baseFile, value); r = f.st('take');
      check('C14/C15 unknown probe refuses without leaking output', r.status === 69 && /stand unknown/.test(r.text) && !r.text.includes('SECRET') && !f.log(), r.text);
    }
    f.config.stand.imageBase = 'echo SECRET >&2; exit 7'; f.save(); r = status(f.task);
    check('C14 nonzero probe is unknown, rc only', /unknown.*7/.test(r.text) && !/SECRET/.test(r.text), r.text);
    f.probe(); f.put(f.baseFile, f.base);
    const oldHolder = f.take(f.worktree('old-holder', f.base));
    await f.wait(() => /ticket taken by/.test(oldHolder.text));
    const staleWaiter = f.take(); await f.wait(() => staleWaiter.ended || /waiting for the stand ticket/.test(staleWaiter.text));
    check('C17 stale refuses before entering an occupied queue', staleWaiter.ended && staleWaiter.rc === 69 && /stand stale/.test(staleWaiter.text), staleWaiter.text);
    await f.stop(staleWaiter); await f.stop(oldHolder);
    f.probe(); f.put(f.baseFile, f.target + '\n');
    check('C9 different commit, same image files is fresh', /stand fresh/.test(status(f.task).text));
    check('C28 missing explicit target is unknown', /stand unknown/.test(status('refs/heads/missing').text));
    f.config.stand.imageFiles = []; f.save();
    check('C16 empty imageFiles is unchecked with reason', /unchecked.*no image files configured/.test(status(f.task).text));
    f.config.stand.imageFiles = ['Dockerfile']; f.save();
    f.put(path.join(f.root, 'down'), '');
    check('C16 down is separate', /down/.test(status(f.task).text) && !/stand fresh/.test(status(f.task).text));
    fs.unlinkSync(path.join(f.root, 'down'));
    // A foreign worktree config must never redirect the pinned probe or its cwd.
    fs.mkdirSync(path.join(f.wt, '.claude'));
    f.put(path.join(f.wt, '.claude/codis-agents.json'), JSON.stringify({ ...f.config, stand: { ...f.config.stand, imageBase: 'echo SECRET' } }));
    const holder = f.take(); await f.wait(() => /ticket taken by/.test(holder.text) || holder.ended);
    check('C21/C22 valid live holder on compatible base', !holder.ended && /ticket taken by/.test(holder.text), holder.text);
    const before = f.log();
    for (const value of [f.base, 'invalid']) {
      f.put(f.baseFile, value); r = f.st('deploy', f.wt);
      check('C21 deploy refuses stale/unknown with live holder', r.status === 69 && /stand (stale|unknown)/.test(r.text) && !holder.ended && f.log() === before, r.text);
    }
    f.put(f.baseFile, f.target); f.put(path.join(f.root, 'deploy-fail'), ''); r = f.st('deploy');
    check('C23 project deploy failure preserved', r.status !== 0 && f.log().includes('deploy'), r.text);
    fs.unlinkSync(path.join(f.root, 'deploy-fail'));
    // Hold all medium slots with real flock, then change either input after deploy has queued.
    for (const changed of ['base', 'head']) {
      f.git(f.wt, 'reset', '--hard', f.task); f.put(f.baseFile, f.target);
      const blocker = f.start('zsh', ['-c', `source '${f.S}/slots.zsh'; for i in {1..3}; do : >> ${f.slots}/medium.$i.lock; zsystem flock -f fd ${f.slots}/medium.$i.lock || exit 1; done; print blocked; while true; do sleep 0.1; done`]);
      await f.wait(() => blocker.text.includes('blocked'));
      const deploy = f.start('zsh', [path.join(f.S, 'stand.sh'), 'deploy', f.wt]);
      await f.wait(() => /waiting/.test(deploy.text) || deploy.ended);
      check('C29 deploy actually waits in medium queue', !deploy.ended && /waiting/.test(deploy.text), deploy.text);
      const log = f.log();
      if (changed === 'base') f.put(f.baseFile, f.base); else f.git(f.wt, 'reset', '--hard', f.base);
      await f.stop(blocker); await f.wait(() => deploy.ended);
      check('C29 re-read ' + changed + ' inside slot before deploy', deploy.rc === 69 && /stand stale/.test(deploy.text) && log === f.log() && !holder.ended, deploy.text);
    }
    f.git(f.wt, 'reset', '--hard', f.task); f.put(f.baseFile, f.target);
    await f.stop(holder);
    for (const changed of ['arc', 'base', 'head']) {
      f.git(f.wt, 'reset', '--hard', f.task); f.put(f.baseFile, f.target);
      const first = f.take(); await f.wait(() => /ticket taken by/.test(first.text));
      const other = f.worktree('wait-' + changed, f.task), waiter = f.take(other);
      await f.wait(() => /waiting for the stand ticket/.test(waiter.text));
      const log = f.log();
      if (changed === 'arc') f.git(f.repo, 'update-ref', 'refs/heads/arc', f.target);
      if (changed === 'base') f.put(f.baseFile, f.base);
      if (changed === 'head') f.git(other, 'reset', '--hard', f.base);
      await f.stop(first); await f.wait(() => /ticket taken by/.test(waiter.text) || waiter.ended);
      check('C18/C27 queued take rechecks ' + changed, changed === 'arc' ? !waiter.ended && /ticket taken by/.test(waiter.text) : waiter.rc === 69 && /stand stale/.test(waiter.text) && f.log() === log && !fs.existsSync(path.join(f.slots, 'stand.lock.who')), waiter.text);
      await f.stop(waiter);
    }
    // Divergent histories, deletion/addition and revert compare trees, not merge-base or SHA inequality.
    const old = f.worktree('divergent', f.base);
    const diverged = f.commit(old, 'app.js', 'other history');
    f.put(f.baseFile, diverged);
    check('C10 divergent image trees stale', /stand stale/.test(status(f.task).text));
    const reverted = f.commit(f.wt, 'Dockerfile', 'FROM base\n');
    check('C9 revert to same image is fresh', /stand fresh/.test(status(reverted).text));
    f.git(f.wt, 'rm', 'Dockerfile'); f.git(f.wt, 'commit', '-qm', 'delete image file');
    const deleted = f.git(f.wt, 'rev-parse', 'HEAD');
    check('C10 deletion stale', /stand stale/.test(status(deleted).text));
    f.put(f.baseFile, deleted);
    check('C10 addition stale', /stand stale/.test(status(f.task).text));
    // A git failure must not become an empty diff/fresh result.
    f.put(f.baseFile, f.base); fs.mkdirSync(path.join(f.repo, '.git/info'), { recursive: true });
    f.put(path.join(f.repo, '.git/info/attributes'), 'Dockerfile diff=broken\n');
    f.git(f.repo, 'config', 'diff.broken.command', '/nonexistent-diff');
    // --name-only should not execute external diff drivers; unknown objects are tested above.
    check('C15 image comparison does not execute diff drivers', /stand stale/.test(status(f.task).text));
    const realGit = f.run('which', ['git']).stdout.trim();
    const fakeGit = path.join(f.root, 'bin/git');
    f.put(fakeGit, `#!/bin/zsh\nfor a in "$@"; do [[ $a == diff ]] && { print SECRET >&2; exit 42; }; done\nexec '${realGit}' "$@"\n`);
    fs.chmodSync(fakeGit, 0o755); r = status(f.task);
    check('C15 git diff failure is unknown without diagnostics', /stand unknown.*cannot compare/.test(r.text) && !/SECRET/.test(r.text), r.text);
    console.log(`${count} passed, 0 failed`);
  } finally { await f.cleanup(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
