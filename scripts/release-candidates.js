#!/usr/bin/env node

/**
 * Select the OpenClaw releases that the automated image workflow should track.
 *
 * GitHub's /releases/latest endpoint excludes prereleases. The scheduled build
 * needs both channels, while a manual build should select only the requested
 * release.
 */

function normalizeVersion(tag) {
  if (typeof tag !== 'string') return null;

  const version = tag.replace(/^v/, '').trim();
  return version || null;
}

function toCandidate(release) {
  if (!release || release.draft === true) return null;

  const version = normalizeVersion(release.tag_name);
  if (!version) return null;

  return {
    version,
    prerelease: release.prerelease === true,
  };
}

function selectReleaseCandidates(releases, requestedVersion = '') {
  const releaseList = Array.isArray(releases) ? releases : [releases];
  const candidates = releaseList.map(toCandidate).filter(Boolean);
  const requested = normalizeVersion(requestedVersion);

  if (requested) {
    const match = candidates.find(({ version }) => version === requested);
    if (!match) {
      throw new Error(`OpenClaw release v${requested} was not found`);
    }
    return [match];
  }

  const stable = candidates.find(({ prerelease }) => !prerelease);
  const prerelease = candidates.find((candidate) => candidate.prerelease);

  return [stable, prerelease].filter(Boolean);
}

async function run() {
  const requestedIndex = process.argv.indexOf('--requested');
  const requestedVersion = requestedIndex === -1
    ? ''
    : process.argv[requestedIndex + 1];

  if (requestedIndex !== -1 && !requestedVersion) {
    throw new Error('--requested requires a version');
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(JSON.stringify(
    selectReleaseCandidates(input, requestedVersion)
  ));
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  normalizeVersion,
  selectReleaseCandidates,
};
