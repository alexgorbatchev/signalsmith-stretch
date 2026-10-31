import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

function checkRelease(version, release) {
  const directory = mkdtempSync(join(tmpdir(), 'stretch-release-'));
  try {
    mkdirSync(join(directory, 'scripts'));
    copyFileSync(new URL('./checkRelease.mjs', import.meta.url), join(directory, 'scripts/checkRelease.mjs'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({version}));
    writeFileSync(join(directory, 'event.json'), JSON.stringify({release}));
    writeFileSync(join(directory, 'output'), '');
    const result = spawnSync(process.execPath, [join(directory, 'scripts/checkRelease.mjs')], {
      env: {...process.env, GITHUB_EVENT_PATH: join(directory, 'event.json'), GITHUB_OUTPUT: join(directory, 'output')},
      encoding: 'utf8'
    });
    return {...result, output: readFileSync(join(directory, 'output'), 'utf8')};
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

test('stable releases publish to latest', () => {
  const result = checkRelease('1.3.3', {tag_name: 'v1.3.3', prerelease: false, draft: false});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'tag=latest\n');
});

test('prereleases publish to next', () => {
  const result = checkRelease('1.3.3-dev.2', {tag_name: 'v1.3.3-dev.2', prerelease: true, draft: false});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'tag=next\n');
});

test('mismatched versions, prerelease status, and drafts cannot select a publishing tag', () => {
  for (const release of [
    {tag_name: 'v1.3.4', prerelease: false, draft: false},
    {tag_name: 'v1.3.3', prerelease: true, draft: false},
    {tag_name: 'v1.3.3', prerelease: false, draft: true}
  ]) {
    const result = checkRelease('1.3.3', release);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
  }
  const result = checkRelease('1.3.3-dev.2', {tag_name: 'v1.3.3-dev.2', prerelease: false, draft: false});
  assert.notEqual(result.status, 0);
  assert.equal(result.output, '');
});
