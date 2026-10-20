'use strict';
// Builds a fixture repository for scripts/detect.js from its description tests/fixtures/repos/<name>.json:
//   { files: {path: text}, ignored: {path: text | {bytes: N}}, git: {init, branch, commit, tags: [...],
//     origin: {head, url}, config: {key: value}} }
// A description, not a checked-in directory: a nested .git cannot be committed, and a real .claude/codis-agents.json,
// CLAUDE.md or .gitignore inside this repository would be picked up by the plugin's own scripts, hooks and git.
// The directory is named after the fixture (docker compose takes the project name from it). origin is recorded without
// any network: its remote-tracking branch and origin/HEAD are set the way a clone sets them.
// gitEnv(dir) - the environment for git in tests: no global or system config of the machine (core.excludesFile,
// core.hooksPath, init.defaultBranch would change the facts), no repository above `dir`.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPOS = path.join(__dirname, 'fixtures', 'repos');
const names = () => fs.readdirSync(REPOS).filter((f) => /^[a-z0-9-]+\.json$/.test(f) && !f.endsWith('.expected.json'))
  .map((f) => f.slice(0, -5)).sort();

function gitEnv(base) {
  const empty = path.join(base, '.gitconfig-empty');
  if (!fs.existsSync(empty)) fs.writeFileSync(empty, '');
  const env = Object.assign({}, process.env, {
    GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: base, GIT_CEILING_DIRECTORIES: base,
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
  });
  for (const k of Object.keys(env)) if (/^(COMPOSE_|DOCKER_DEFAULT_PLATFORM$|APP_PORT$|DETECT_FIXTURE_)/.test(k)) delete env[k];
  return env;
}

function write(dir, rel, content) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof content === 'string' ? content : Buffer.alloc(content.bytes, 0x61));
}

function build(name, base) {
  const d = JSON.parse(fs.readFileSync(path.join(REPOS, name + '.json'), 'utf8'));
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  const env = gitEnv(base);
  const git = (...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`fixture ${name}: git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  for (const [rel, c] of Object.entries(d.files || {})) write(dir, rel, c);
  const g = d.git || {};
  if (g.init) {
    git('init', '-q', '-b', g.branch);
    for (const [k, v] of Object.entries(g.config || {})) git('config', k, v);
    if (g.commit) {
      git('add', '-A');
      git('commit', '-q', '-m', 'fixture');
      for (const t of g.tags || []) git('tag', t);
      if (g.origin) {
        git('remote', 'add', 'origin', g.origin.url);
        git('update-ref', 'refs/remotes/origin/' + g.origin.head, 'HEAD');
        git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/' + g.origin.head);
      }
    }
  }
  for (const [rel, c] of Object.entries(d.ignored || {})) write(dir, rel, c);
  return dir;
}

const expected = (name) => JSON.parse(fs.readFileSync(path.join(REPOS, name + '.expected.json'), 'utf8'));
module.exports = { REPOS, names, build, gitEnv, expected };
