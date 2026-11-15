#!/usr/bin/env node
'use strict';
// tests:quiet - real train dispatch and watch transitions with isolated slots
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const fixture = require('./stand-stale-fixture');
(async () => {
  const f = fixture(); let count = 0;
  const check = (name, yes, detail = '') => { assert(yes, name + ': ' + detail); console.log('ok ' + name); count++; };
  const last = r => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return {}; } };
  const train = (name, base, head = f.task) => {
    const e = f.tr('enqueue', '--task', name, '--branch', 'main', '--head', head, '--base', base);
    assert.equal(e.status, 0, e.text);
    const r = f.tr('run'); assert.equal(r.status, 0, r.text); return last(r);
  };
  try {
    f.probe();
    for (const [name, checkedOut] of [['cas', false], ['ff', true]]) {
      f.git(f.repo, 'branch', name, f.base);
      const w = checkedOut ? f.worktree('arc-' + name, name) : null;
      if (w) f.git(w, 'checkout', name);
      const r = train('task-' + name, name);
      const log = fs.readFileSync(r.log, 'utf8');
      check('C1/C2 green ' + name + ' reports actual stale arc', r.verdict === 'green' && /stand stale/.test(log) && log.includes(f.base) && log.includes('refs/heads/' + name) && log.includes(f.git(f.repo, 'rev-parse', name)) && log.includes('Dockerfile'), log);
      if (w) check('C2 checked-out tree moved', f.git(w, 'rev-parse', 'HEAD') === f.git(f.repo, 'rev-parse', name));
    }
    f.git(f.repo, 'branch', 'dirty', f.base); const dirty = f.worktree('dirty-wt', 'dirty'); f.git(dirty, 'checkout', 'dirty');
    f.put(path.join(dirty, 'Dockerfile'), 'dirty');
    let r = train('unmerged', 'dirty');
    check('C4 unmerged does not report completed stand transition', r.verdict === 'green-unmerged' && !/stand stale/.test(fs.readFileSync(r.log, 'utf8')));
    f.config.guardCommand = 'false'; f.save(); f.git(f.repo, 'branch', 'red-arc', f.base);
    r = train('red', 'red-arc');
    check('C5 red does not report completed stand transition', r.verdict !== 'green' && !/stand stale/.test(fs.readFileSync(r.log, 'utf8')));
    f.config.guardCommand = 'true'; f.save();
    f.tr('resume');
    // Status/watch use the explicit ref even with no train history for it.
    f.git(f.repo, 'update-ref', 'refs/heads/manual', f.task);
    let s = f.tr('status', '--target', 'refs/heads/manual');
    check('C6/C24 manual merge status uses ref and full SHA', /stand stale/.test(s.text) && s.text.includes('refs/heads/manual') && s.text.includes(f.task), s.text);
    check('C24 train status without target unchecked', /unchecked.*target not specified/.test(f.tr('status').text));
    let w = f.watch('--target', 'refs/heads/manual'); await f.wait(() => w.ended);
    check('C25 watch detects already stale target immediately', /"stand"/.test(w.text) && /stale/.test(w.text), w.text);
    w = f.watch('--target', 'refs/heads/manual');
    await new Promise(resolve => setTimeout(resolve, 800));
    check('C26 identical event is not repeated', !w.ended, w.text);
    f.put(f.baseFile, f.target);
    await f.wait(() => {
      const d = path.join(f.config.sharedDir, 'train');
      return fs.readdirSync(d).filter(n => /stand/.test(n)).some(n => {
        try { return /fresh/.test(fs.readFileSync(path.join(d, n), 'utf8')); } catch { return false; }
      });
    });
    f.put(f.baseFile, f.base); await f.wait(() => w.ended);
    check('C8/C25 fresh observation rearms stale event', /stale/.test(w.text), w.text);
    // Independent targets have independent event keys, and a full SHA pins its snapshot.
    const w2 = f.watch('--target', f.task); await f.wait(() => w2.ended);
    check('C26 different target has its own event', /stale/.test(w2.text));
    f.put(f.baseFile, f.base); f.git(f.repo, 'update-ref', 'refs/heads/moving', f.base);
    w = f.watch('--target', 'refs/heads/moving');
    await new Promise(resolve => setTimeout(resolve, 700));
    check('C28 fresh ref watch keeps waiting', !w.ended, w.text);
    f.git(f.repo, 'update-ref', 'refs/heads/moving', f.task); await f.wait(() => w.ended);
    check('C28 ref resolves anew to full SHA', w.text.includes(f.task) && /stale/.test(w.text), w.text);
    check('C28 full SHA remains fixed', /stand fresh/.test(f.tr('status', '--target', f.base).text));
    f.put(f.baseFile, f.target);
    s = f.tr('status', '--target', 'refs/heads/manual');
    check('C8 status clears stale after rebuild', /stand fresh/.test(s.text) && !/stand stale/.test(s.text));
    f.git(f.repo, 'branch', 'fresh-arc', f.target); r = train('fresh', 'fresh-arc');
    check('C3 code-only train fresh', r.verdict === 'green' && /stand fresh/.test(fs.readFileSync(r.log, 'utf8')) && !/stand stale/.test(fs.readFileSync(r.log, 'utf8')));
    delete f.config.stand; f.save();
    check('C12 no stand means no probe or stand diagnostic', !/stand (fresh|stale|unknown|unchecked)/.test(f.tr('status', '--target', f.task).text));
    check('no project mutating commands from train/status/watch', f.log() === '', f.log());
    console.log(`${count} passed, 0 failed`);
  } finally { await f.cleanup(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
