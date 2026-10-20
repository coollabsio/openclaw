#!/usr/bin/env node
/**
 * Docker CLI entrypoint for the gateway image.
 *
 * OpenClaw sandboxing shells out to `docker` and creates sibling containers
 * on the host daemon. Managed workspace mounts are translated from gateway
 * paths to host paths by inspecting this container. That translation accepts
 * bind mounts only. A named volume such as `openclaw-data:/data` is the same
 * files on the host (its mountpoint under /var/lib/docker/volumes), but
 * inspect reports Type "volume", so OpenClaw refuses it.
 *
 * This wrapper runs the real client at /usr/local/libexec/openclaw-docker.
 * When it inspects the gateway container, a local named volume with an
 * absolute host Source is reported as a bind. Every other command and every
 * other container is passed through unchanged.
 *
 * Set OPENCLAW_DOCKER_VOLUME_AS_BIND=0 to disable the rewrite.
 */

const fs = require('fs');
const { spawnSync } = require('child_process');

const REAL_DOCKER = '/usr/local/libexec/openclaw-docker';
const INSPECT_MAX_BUFFER = 16 * 1024 * 1024;

const GLOBAL_VALUE_FLAGS = new Set([
  '--config',
  '-c',
  '--context',
  '--host',
  '-H',
  '--log-level',
  '-l',
  '--tlscacert',
  '--tlscert',
  '--tlskey',
]);

function volumeAsBindEnabled(env) {
  const raw = env.OPENCLAW_DOCKER_VOLUME_AS_BIND;
  if (raw == null || String(raw).trim() === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function findDockerCommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      const name = argv[i + 1];
      return name ? { name, index: i + 1 } : null;
    }
    if (arg.startsWith('-')) {
      if (GLOBAL_VALUE_FLAGS.has(arg.split('=')[0])) {
        if (!arg.includes('=')) i += 1;
      }
      continue;
    }
    return { name: arg, index: i };
  }
  return null;
}

function readSelfContainerIds(sources) {
  const ids = [];
  const cgroup = sources.cgroup || '';
  // A fresh regex each call. A shared /g pattern keeps lastIndex and skips ids.
  const containerIdInCgroup = /(?:\/docker\/|docker-)([a-f0-9]{64})(?:\/|\.scope|$)/gim;
  for (const match of cgroup.matchAll(containerIdInCgroup)) {
    if (match[1]) ids.push(match[1]);
  }
  const mountinfo = sources.mountinfo || '';
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' ');
    if (!/^\/etc\/(?:hosts|hostname|resolv\.conf)$/.test(fields[4] || '')) continue;
    const id = (fields[3] || '').match(
      /\/containers\/([a-f0-9]{64})\/(?:hosts|hostname|resolv\.conf)$/i,
    );
    if (id && id[1]) ids.push(id[1]);
  }
  const inContainer = sources.inContainer === true;
  const hostname = String(sources.hostname || '').trim().toLowerCase();
  if ((inContainer || ids.length > 0) && /^[a-f0-9]{12,64}$/.test(hostname)) {
    ids.push(hostname);
  }
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

function loadSelfContainerIds() {
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  return readSelfContainerIds({
    cgroup: read('/proc/self/cgroup'),
    mountinfo: read('/proc/self/mountinfo'),
    hostname: read('/etc/hostname'),
    inContainer: fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv'),
  });
}

function selfIdsFromEnv(env) {
  if (env.OPENCLAW_DOCKER_SELF_IDS == null || String(env.OPENCLAW_DOCKER_SELF_IDS).trim() === '') {
    return null;
  }
  return String(env.OPENCLAW_DOCKER_SELF_IDS)
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => /^[a-f0-9]{12,64}$/.test(id));
}

function containerIdMatches(containerId, selfIds) {
  if (typeof containerId !== 'string') return false;
  const id = containerId.toLowerCase();
  if (!/^[a-f0-9]{12,64}$/.test(id)) return false;
  return selfIds.some((self) => id === self || id.startsWith(self) || self.startsWith(id));
}

function rewriteVolumeMount(mount) {
  if (!mount || typeof mount !== 'object' || Array.isArray(mount)) return mount;
  if (mount.Type !== 'volume') return mount;
  if (typeof mount.Source !== 'string' || !mount.Source.startsWith('/')) return mount;
  return { ...mount, Type: 'bind' };
}

function rewriteContainerRecord(record, selfIds) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  if (!Array.isArray(record.Mounts)) return record;
  if (!containerIdMatches(record.Id, selfIds)) return record;
  let changed = false;
  const mounts = record.Mounts.map((mount) => {
    const next = rewriteVolumeMount(mount);
    if (next !== mount) changed = true;
    return next;
  });
  if (!changed) return record;
  return { ...record, Mounts: mounts };
}

function rewriteInspectValue(value, selfIds) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const rewritten = rewriteContainerRecord(item, selfIds);
      if (rewritten !== item) changed = true;
      return rewritten;
    });
    return changed ? next : value;
  }
  return rewriteContainerRecord(value, selfIds);
}

function rewriteInspectStdout(stdout, selfIds) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout ?? '');
  if (!selfIds || selfIds.length === 0) return text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const rewritten = rewriteInspectValue(parsed, selfIds);
  if (rewritten === parsed) return text;
  return JSON.stringify(rewritten);
}

function realDockerPath(env) {
  return env.OPENCLAW_DOCKER_CLI || REAL_DOCKER;
}

function main() {
  const args = process.argv.slice(2);
  const real = realDockerPath(process.env);
  const command = findDockerCommand(args);
  const rewrite = Boolean(command && command.name === 'inspect' && volumeAsBindEnabled(process.env));
  const result = spawnSync(real, args, {
    stdio: rewrite ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: INSPECT_MAX_BUFFER,
    encoding: rewrite ? 'buffer' : undefined,
  });
  if (result.error) {
    const missing = result.error.code === 'ENOENT';
    process.stderr.write(
      missing
        ? `docker: client binary not found at ${real}\n`
        : `docker: ${result.error.message}\n`,
    );
    process.exit(missing ? 127 : 1);
  }
  if (!rewrite) {
    process.exit(result.status == null ? 1 : result.status);
  }
  if (result.stderr && result.stderr.length) process.stderr.write(result.stderr);
  const status = result.status == null ? 1 : result.status;
  if (status !== 0) {
    if (result.stdout && result.stdout.length) process.stdout.write(result.stdout);
    process.exit(status);
  }
  const selfIds = selfIdsFromEnv(process.env) || loadSelfContainerIds();
  process.stdout.write(rewriteInspectStdout(result.stdout || '', selfIds));
  process.exit(0);
}

module.exports = {
  findDockerCommand,
  readSelfContainerIds,
  containerIdMatches,
  rewriteInspectValue,
  rewriteInspectStdout,
  volumeAsBindEnabled,
  REAL_DOCKER,
};

if (require.main === module) {
  main();
}
