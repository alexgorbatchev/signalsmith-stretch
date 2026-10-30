import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInThisContext} from 'node:vm';
import {test} from 'node:test';

const createSource = runInThisContext(readFileSync(new URL('../windowed-source.js', import.meta.url), 'utf8') + '\ncreateWindowedSource;');
const spec = {generation: 'track-1', sampleRate: 48000, channels: 1, lengthFrames: 48000 * 3600 * 12, capacityFrames: 32};

test('a twelve-hour source retains only explicitly admitted PCM and returns ownership on release', () => {
	const source = createSource(spec);
	const first = Float32Array.from({length: 16}, (_, i) => i);
	const last = Float32Array.from({length: 16}, (_, i) => 100 + i);
	source.add('track-1', 0, [first]);
	source.add('track-1', spec.lengthFrames - 16, [last]);
	assert.equal(source.residentFrames, 32);
	assert.throws(() => source.add('track-1', 1000, [new Float32Array(1)]), /capacity/);
	const released = source.drop('track-1', [0]);
	assert.deepEqual(released.transfer, [first.buffer]);
	source.add('track-1', 2000, [new Float32Array(16)]);
	assert.equal(source.residentFrames, 32);
});

test('analysis history wraps before the loop head and repeatedly across a short loop', () => {
	const source = createSource(spec);
	source.add('track-1', 10, [Float32Array.from([1, 2, 3, 4])]);
	const output = [new Float32Array(12)];
	assert.equal(source.read(7, output, {start: 10, end: 14}), null);
	assert.deepEqual(Array.from(output[0]), [2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1]);
});

test('fractional boundaries interpolate source frames and wrap the interpolation neighbour', () => {
	const source = createSource(spec);
	source.add('track-1', 10, [Float32Array.from([0, 10, 20, 30])]);
	const output = [new Float32Array(4)];
	assert.equal(source.read(12.5, output, {start: 10, end: 14}), null);
	assert.deepEqual(Array.from(output[0]), [25, 15, 5, 15]);
});

test('missing distant tail requests are bounded and never span the twelve-hour source', () => {
	const source = createSource(spec);
	source.add('track-1', 0, [new Float32Array(16)]);
	const output = [new Float32Array(8).fill(1)];
	assert.deepEqual(source.read(spec.lengthFrames - 4, output, {start: 0, end: spec.lengthFrames}),
		{start: spec.lengthFrames - 4, end: spec.lengthFrames});
	assert.deepEqual(Array.from(output[0]), new Array(8).fill(0));
});

test('source generation, overlapping windows and damaged PCM are rejected without corrupting admitted audio', () => {
	const source = createSource(spec);
	source.add('track-1', 10, [Float32Array.from([1, 2])]);
	assert.throws(() => source.add('old-track', 0, [new Float32Array(2)]), /Stale/);
	assert.throws(() => source.add('track-1', 11, [new Float32Array(2)]), /Overlapping/);
	assert.throws(() => source.add('track-1', 0, [Float32Array.from([NaN])]), /Non-finite/);
	assert.throws(() => source.add('track-1', 0, [new Float32Array(1000000).subarray(0, 2)]), /Invalid PCM/);
	const output = [new Float32Array(2)];
	assert.equal(source.read(10, output), null);
	assert.deepEqual(Array.from(output[0]), [1, 2]);
	assert.equal(source.residentFrames, 2);
});
