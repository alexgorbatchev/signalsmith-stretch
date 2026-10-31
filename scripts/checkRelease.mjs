import assert from 'node:assert/strict';
import {appendFileSync, readFileSync} from 'node:fs';

const {version} = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const {release} = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
assert.equal(release.tag_name, `v${version}`, 'GitHub release tag must match package.json version');
assert.equal(release.draft, false, 'Draft releases cannot publish');
const isPrerelease = version.split('+')[0].includes('-');
assert.equal(release.prerelease, isPrerelease, 'GitHub prerelease status must match package.json version');
appendFileSync(process.env.GITHUB_OUTPUT, `tag=${isPrerelease ? 'next' : 'latest'}\n`);
