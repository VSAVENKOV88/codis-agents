#!/usr/bin/env node
'use strict';
// A stand-in adapter for tests/heavy-channel.test.js (cells B'24, B'25): opens the heavy channel service of
// scripts/heavy-service.js with the options given as JSON in argv[2] and lives until it is killed. It prints "ready"
// once the service is open. No model, no codex: the options carry the test's executor (inject.executorArgv).
const path = require('path');
const { openHeavyService } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'heavy-service.js'));
const o = JSON.parse(process.argv[2]);
const exe = o.executorArgv;
delete o.executorArgv;
o.inject = { probe: async () => ({}), executor: (spec) => Object.assign({}, spec, { bin: exe[0], args: exe.slice(1).concat(spec.inner) }) };
openHeavyService(o);
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
