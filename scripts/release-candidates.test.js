#!/usr/bin/env node

const {
  normalizeVersion,
  selectReleaseCandidates,
} = require('./release-candidates');

let passed = 0;
let failed = 0;

function eq(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson === expectedJson) {
    passed++;
  } else {
    failed++;
    console.error(
      `  FAIL: ${label}\n` +
      `    expected: ${expectedJson}\n` +
      `    actual:   ${actualJson}`
    );
  }
}

function throws(fn, expectedMessage, label) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${label} (expected throw, got none)`);
  } catch (error) {
    if (error.message === expectedMessage) {
      passed++;
    } else {
      failed++;
      console.error(
        `  FAIL: ${label}\n` +
        `    expected: ${expectedMessage}\n` +
        `    actual:   ${error.message}`
      );
    }
  }
}

console.log('normalizeVersion');

eq(normalizeVersion('v2026.7.1'), '2026.7.1', 'strips a leading v');
eq(
  normalizeVersion('v2026.7.2-beta.3'),
  '2026.7.2-beta.3',
  'preserves a beta suffix'
);
eq(normalizeVersion('2026.7.1'), '2026.7.1', 'accepts an unprefixed version');
eq(normalizeVersion(''), null, 'rejects an empty version');
eq(normalizeVersion(null), null, 'rejects a non-string version');

console.log('selectReleaseCandidates (scheduled)');

const releases = [
  {
    tag_name: 'v2026.7.2-beta.3',
    prerelease: true,
    draft: false,
  },
  {
    tag_name: 'v2026.7.2-beta.2',
    prerelease: true,
    draft: false,
  },
  {
    tag_name: 'v2026.7.1',
    prerelease: false,
    draft: false,
  },
  {
    tag_name: 'v2026.6.11',
    prerelease: false,
    draft: false,
  },
];

eq(
  selectReleaseCandidates(releases),
  [
    { version: '2026.7.1', prerelease: false },
    { version: '2026.7.2-beta.3', prerelease: true },
  ],
  'selects the newest stable and prerelease'
);

eq(
  selectReleaseCandidates([
    {
      tag_name: 'v2026.8.1-beta.1',
      prerelease: true,
      draft: true,
    },
    ...releases,
  ]),
  [
    { version: '2026.7.1', prerelease: false },
    { version: '2026.7.2-beta.3', prerelease: true },
  ],
  'ignores draft releases'
);

eq(
  selectReleaseCandidates([
    { tag_name: 'v2026.7.1', prerelease: false, draft: false },
  ]),
  [{ version: '2026.7.1', prerelease: false }],
  'works when no prerelease exists'
);

eq(
  selectReleaseCandidates([
    { tag_name: 'v2026.7.2-beta.3', prerelease: true, draft: false },
  ]),
  [{ version: '2026.7.2-beta.3', prerelease: true }],
  'works when no stable release exists'
);

console.log('selectReleaseCandidates (manual)');

eq(
  selectReleaseCandidates(releases, '2026.7.2-beta.2'),
  [{ version: '2026.7.2-beta.2', prerelease: true }],
  'selects an exact beta release'
);

eq(
  selectReleaseCandidates(releases, 'v2026.7.1'),
  [{ version: '2026.7.1', prerelease: false }],
  'selects an exact stable release with a leading v'
);

throws(
  () => selectReleaseCandidates(releases, '2026.1.1'),
  'OpenClaw release v2026.1.1 was not found',
  'rejects an unknown requested release'
);

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n${passed} passed`);
