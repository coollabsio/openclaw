#!/usr/bin/env node
/**
 * Tests for scripts/docker-cli.js.
 * No test framework — run with: node scripts/docker-cli.test.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  findDockerCommand,
  readSelfContainerIds,
  rewriteInspectStdout,
  volumeAsBindEnabled,
} = require('./docker-cli');

const ROOT = path.join(__dirname, '..');
const SELF = '0939478785af80fcf4e3fcd5fd16de70cd6f33e4506d354121afe9d445bd1e74';
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function eq(actual, expected, label) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

console.log('findDockerCommand');
eq(findDockerCommand(['inspect', '--type', 'container', 'abc']).name, 'inspect', 'inspect is the command');
eq(findDockerCommand(['--host', 'unix:///var/run/docker.sock', 'inspect', 'abc']).name, 'inspect', 'host flag is global');
eq(findDockerCommand(['--host=unix:///var/run/docker.sock', 'version']).name, 'version', 'host equals form does not consume the command');
eq(findDockerCommand(['create', '--name', 'sbx']).name, 'create', 'create is not inspect');
eq(findDockerCommand(['--version']), null, 'version flag is not the inspect command');

console.log('volumeAsBindEnabled');
assert(volumeAsBindEnabled({}), 'default is on');
assert(volumeAsBindEnabled({ OPENCLAW_DOCKER_VOLUME_AS_BIND: '' }), 'empty stays on');
assert(!volumeAsBindEnabled({ OPENCLAW_DOCKER_VOLUME_AS_BIND: '0' }), '0 disables');
assert(!volumeAsBindEnabled({ OPENCLAW_DOCKER_VOLUME_AS_BIND: 'false' }), 'false disables');
assert(!volumeAsBindEnabled({ OPENCLAW_DOCKER_VOLUME_AS_BIND: 'off' }), 'off disables');
assert(volumeAsBindEnabled({ OPENCLAW_DOCKER_VOLUME_AS_BIND: '1' }), '1 keeps the rewrite');

console.log('readSelfContainerIds');
const mountinfo = [
  '294 285 254:32 /var/lib/docker/containers/' + SELF + '/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/vdc rw',
  '296 285 254:32 /var/lib/docker/containers/' + SELF + '/hosts /etc/hosts rw,relatime - ext4 /dev/vdc rw',
].join('\n');
const ids = readSelfContainerIds({
  cgroup: '0::/\n',
  mountinfo,
  hostname: SELF.slice(0, 12),
  inContainer: true,
});
assert(ids.includes(SELF), 'mountinfo container id is kept');
assert(ids.includes(SELF.slice(0, 12)), 'short hostname is kept inside a container');
eq(
  readSelfContainerIds({ cgroup: '', mountinfo: '', hostname: SELF.slice(0, 12), inContainer: false }),
  [],
  'a hex hostname outside a container is not a self id',
);
const cgroupIds = readSelfContainerIds({
  cgroup: '0::/docker/' + SELF + '\n',
  mountinfo: '',
  hostname: 'ignored',
  inContainer: false,
});
assert(cgroupIds.includes(SELF), 'cgroup docker id is kept');

console.log('rewriteInspectStdout');
const volumeInspect = JSON.stringify({
  Id: SELF,
  Mounts: [{
    Type: 'volume',
    Name: 'openclaw-data',
    Source: '/var/lib/docker/volumes/openclaw-data/_data',
    Destination: '/data',
    Driver: 'local',
    Mode: 'z',
    RW: true,
    Propagation: '',
  }, {
    Type: 'bind',
    Source: '/var/run/docker.sock',
    Destination: '/var/run/docker.sock',
    Mode: '',
    RW: true,
    Propagation: 'rprivate',
  }],
  Tmpfs: null,
});
const rewritten = JSON.parse(rewriteInspectStdout(volumeInspect, [SELF.slice(0, 12)]));
eq(rewritten.Mounts[0].Type, 'bind', 'named volume on this container becomes a bind');
eq(rewritten.Mounts[0].Source, '/var/lib/docker/volumes/openclaw-data/_data', 'host mountpoint is preserved');
eq(rewritten.Mounts[0].Destination, '/data', 'container destination is preserved');
eq(rewritten.Mounts[0].RW, true, 'writable flag is preserved');
eq(rewritten.Mounts[1].Type, 'bind', 'socket bind is unchanged');
eq(rewritten.Tmpfs, null, 'tmpfs field is preserved');

const pretty = '{\n  "Id": "' + OTHER + '",\n  "Mounts": [{"Type": "volume", "Source": "/var/lib/docker/volumes/other/_data", "Destination": "/data", "RW": true}]\n}\n';
eq(rewriteInspectStdout(pretty, [SELF]), pretty, 'another container is not reformatted');

const relative = JSON.stringify({
  Id: SELF,
  Mounts: [{ Type: 'volume', Source: 'openclaw-data', Destination: '/data', RW: true }],
});
eq(rewriteInspectStdout(relative, [SELF]), relative, 'a volume without an absolute host source is left alone');
eq(rewriteInspectStdout('not-json', [SELF]), 'not-json', 'non-json inspect output is unchanged');
eq(rewriteInspectStdout(volumeInspect, []), volumeInspect, 'no self id means no rewrite');

const list = JSON.stringify([
  { Id: SELF, Mounts: [{ Type: 'volume', Source: '/var/lib/docker/volumes/openclaw-data/_data', Destination: '/data', RW: true }] },
  { Id: OTHER, Mounts: [{ Type: 'volume', Source: '/var/lib/docker/volumes/other/_data', Destination: '/var', RW: true }] },
]);
const rewrittenList = JSON.parse(rewriteInspectStdout(list, [SELF]));
eq(rewrittenList[0].Mounts[0].Type, 'bind', 'list inspect rewrites only this container');
eq(rewrittenList[1].Mounts[0].Type, 'volume', 'list inspect leaves the other container');

console.log('wrapper process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-cli-'));
const mock = path.join(dir, 'docker-mock.sh');
const script = path.join(__dirname, 'docker-cli.js');
fs.writeFileSync(mock, `#!/bin/sh
printf '%s' "\${MOCK_STDERR}" >&2
if [ "\${MOCK_EXIT:-0}" != 0 ]; then
  printf '%s' "\${MOCK_STDOUT}"
  exit "\${MOCK_EXIT}"
fi
printf '%s' "\${MOCK_STDOUT}"
exit 0
`);
fs.chmodSync(mock, 0o755);

function runWrapper(args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, OPENCLAW_DOCKER_CLI: mock, ...env },
    encoding: 'utf8',
  });
}

const version = runWrapper(['version'], { MOCK_STDOUT: 'docker-mock 29\n', MOCK_STDERR: '' });
eq(version.status, 0, 'version exits 0');
eq(version.stdout, 'docker-mock 29\n', 'non-inspect output is passed through');

const inspect = runWrapper(
  ['--host', 'unix:///var/run/docker.sock', 'inspect', '--format', '{{json .Mounts}}', SELF.slice(0, 12)],
  {
    MOCK_STDOUT: volumeInspect,
    MOCK_STDERR: '',
    OPENCLAW_DOCKER_SELF_IDS: SELF,
  },
);
eq(inspect.status, 0, 'inspect exits 0');
eq(JSON.parse(inspect.stdout).Mounts[0].Type, 'bind', 'wrapper rewrites a self inspect');

const optedOut = runWrapper(['inspect', SELF], {
  MOCK_STDOUT: volumeInspect,
  MOCK_STDERR: '',
  OPENCLAW_DOCKER_SELF_IDS: SELF,
  OPENCLAW_DOCKER_VOLUME_AS_BIND: '0',
});
eq(optedOut.stdout, volumeInspect, 'opt-out leaves inspect bytes unchanged');

const failedInspect = runWrapper(['inspect', 'missing'], {
  MOCK_STDOUT: '[]',
  MOCK_STDERR: 'Error: No such object: missing\n',
  MOCK_EXIT: '1',
  OPENCLAW_DOCKER_SELF_IDS: SELF,
});
eq(failedInspect.status, 1, 'inspect failure status is preserved');
eq(failedInspect.stdout, '[]', 'failed inspect stdout is not rewritten');
assert(failedInspect.stderr.includes('No such object'), 'inspect stderr is preserved');

const missing = runWrapper(['version'], { OPENCLAW_DOCKER_CLI: path.join(dir, 'missing-docker') });
eq(missing.status, 127, 'missing client exits 127');
assert(missing.stderr.includes('client binary not found'), 'missing client explains the path');

console.log('image wiring');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
assert(dockerfile.includes('DOCKER_CLI_VERSION='), 'Dockerfile pins a Docker CLI version');
assert(dockerfile.includes('docker/docker'), 'Dockerfile extracts only the client from the static tarball');
assert(dockerfile.includes('/usr/local/libexec/openclaw-docker'), 'real client is off PATH');
assert(dockerfile.includes('ln -sf /app/scripts/docker-cli.js /usr/local/bin/docker'), 'PATH docker is the wrapper');
assert(!dockerfile.includes('dockerd'), 'Dockerfile does not install the daemon');

const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
assert(compose.includes('# - /var/run/docker.sock:/var/run/docker.sock'), 'compose documents the socket as a comment');
assert(
  !compose.split('\n').some((line) => /^\s*-\s*['"]?\/var\/run\/docker\.sock:/.test(line)),
  'compose does not mount the socket',
);

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
assert(readme.includes('## Agent sandbox'), 'README has an agent sandbox section');
assert(/gives this container root on the host/i.test(readme), 'README states the socket is root on the host');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
