import assert from 'node:assert/strict';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = join(root, '.tmp');
mkdirSync(temporary, {recursive: true});

function fixture(source = 'export function value() { return 42; }\n') {
	const directory = mkdtempSync(join(temporary, 'coverage-gate-'));
	mkdirSync(join(directory, 'scripts'));
	mkdirSync(join(directory, 'web'));
	copyFileSync(join(root, 'scripts/coverage.config.mjs'), join(directory, 'scripts/coverage.config.mjs'));
	writeFileSync(join(directory, 'web/source.js'), source);
	writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
	writeFileSync(join(directory, 'case.mjs'), "import assert from 'node:assert/strict';\nimport {value} from './web/source.js';\nassert.equal(value(), 42);\n");
	return directory;
}

function run(directory) {
	const env = {...process.env};
	// Start an independent CLI invocation, outside this runner's child context.
	delete env.NODE_TEST_CONTEXT;
	delete env.NODE_V8_COVERAGE;
	const result = spawnSync(process.execPath, [join(root, 'node_modules/monocart-coverage-reports/lib/cli.js'),
		'--config', 'scripts/coverage.config.mjs', 'test', 'case.mjs'],
	{cwd: directory, env, encoding: 'utf8', timeout: 30000});
	assert.ifError(result.error);
	assert.equal(result.signal, null);
	return {status: result.status, output: result.stdout + result.stderr};
}

test('coverage command admits exercised sources and rejects a newly added unexecuted source', () => {
	const directory = fixture();
	const passed = run(directory);
	assert.equal(passed.status, 0, passed.output);
	writeFileSync(join(directory, 'web/forgotten.js'), 'export function forgotten() { return 7; }\n');
	const rejected = run(directory);
	assert.notEqual(rejected.status, 0, rejected.output);
	assert.match(rejected.output, /web\/forgotten.js functions: 0%, required 90%/);
	const report = JSON.parse(readFileSync(join(directory, '.tmp/coverage/coverage-report.json'), 'utf8'));
	assert.equal(report.files.find(file => file.sourcePath === 'web/forgotten.js').summary.lines.pct, 0);
});

test('coverage command enforces function coverage even when line coverage passes', () => {
	const directory = fixture('export function value() {\n let result = 22;\n' +
		' result += 1;\n'.repeat(20) + ' return result;\n}\nexport function unused() { return 0; }\n');
	const rejected = run(directory);
	assert.notEqual(rejected.status, 0, rejected.output);
	assert.match(rejected.output, /web\/source.js functions: 50%, required 90%/);
	assert.doesNotMatch(rejected.output, /web\/source.js lines: .*required 90%/);
});

test('coverage command enforces line coverage even when every function executes', () => {
	const directory = fixture('export function value() {\n if (false) {\n' +
		Array.from({length: 20}, (_, index) => `  console.log(${index});`).join('\n') + '\n }\n return 42;\n}\n');
	const rejected = run(directory);
	assert.notEqual(rejected.status, 0, rejected.output);
	assert.match(rejected.output, /web\/source.js lines: .*required 90%/);
	assert.doesNotMatch(rejected.output, /web\/source.js functions: .*required 90%/);
});

test('coverage command preserves a failed child test with fully covered source', () => {
	const directory = fixture();
	writeFileSync(join(directory, 'case.mjs'), "import {value} from './web/source.js';\nvalue();\nthrow new Error('intentional child failure');\n");
	const rejected = run(directory);
	assert.notEqual(rejected.status, 0, rejected.output);
	assert.match(rejected.output, /intentional child failure/);
});

test('coverage command cannot satisfy a new run with an old passing report', () => {
	const directory = fixture();
	const passed = run(directory);
	assert.equal(passed.status, 0, passed.output);
	writeFileSync(join(directory, 'case.mjs'), '// No package source executed in this run.\n');
	const rejected = run(directory);
	assert.notEqual(rejected.status, 0, rejected.output);
	assert.match(rejected.output, /web\/source.js lines: 0%, required 90%/);
});
