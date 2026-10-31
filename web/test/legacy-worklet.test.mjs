import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openProcessor} from './worklet-harness.mjs';

const energy = samples => samples.reduce((sum, sample) => sum + sample * sample, 0);
const sine = length => Float32Array.from({length}, (_, index) => 0.25 * Math.sin(index * 440 * 2 * Math.PI / 48000));

test('native live-input processing carries audio, stops, and reconfigures channels and presets', async () => {
	const host = await openProcessor();
	try {
		assert.ok(await host.call('latency') > 0);
		await host.call('configure', [{preset: 'cheaper'}]);
		await host.call('setUpdateInterval', [0.01]);
		await host.call('start', [{input: 0, output: 0}]);
		let total = 0;
		for (let index = 0; index < 100; ++index) {
			const output = new Float32Array(128);
			assert.equal(host.processor.process([[sine(128)]], [[output]], {}), true);
			total += energy(output);
			host.advance();
		}
		assert.ok(total > 1, 'actual DSP must emit live input');
		await host.call('stop');
		for (let index = 0; index < 100; ++index) {
			const output = new Float32Array(128);
			host.processor.process([], [[output]], {});
			host.advance();
			if (index === 99) assert.equal(energy(output), 0);
		}
		assert.equal(host.processor.process([], [], {}), false);
		const stereo = [new Float32Array(128), new Float32Array(128)];
		assert.equal(host.processor.process([], [stereo], {}), true);
		assert.equal(host.processor.channels, 2);
	} finally { host.close(); }
});

test('native stored-buffer playback loops, schedules rate transitions, and returns dropped ownership', async () => {
	const host = await openProcessor();
	try {
		const first = sine(12000), second = sine(12000);
		assert.equal(await host.call('addBuffers', [[first]], [first.buffer]), 0.25);
		assert.equal(first.byteLength, 0);
		assert.equal(await host.call('addBuffers', [[second]], [second.buffer]), 0.5);
		await host.call('start', [0, 0, undefined, 1, 0]);
		await host.call('schedule', [{outputTime: 0.1, input: 0.1, loopStart: 0, loopEnd: 0.125}, true]);
		let total = 0;
		for (let index = 0; index < 200; ++index) {
			const output = new Float32Array(128);
			host.processor.process([], [[output]], {});
			host.advance();
			total += energy(output);
		}
		assert.ok(total > 1, 'stored PCM must traverse actual WASM');
		assert.ok(host.processor.timeMap[0].input < 0.1, 'loop wraps the source mapping');
		assert.deepEqual(await host.call('dropBuffers', [0.2]), {start: 0, end: 0.5});
		assert.deepEqual(await host.call('dropBuffers', [0.3]), {start: 0.25, end: 0.5});
		assert.equal(host.processor.audioBuffers.length, 1);
		assert.deepEqual(await host.call('dropBuffers'), {start: 0, end: 0});
		assert.equal(host.processor.audioBuffers.length, 0);
		await host.call('start', [host.context.currentTime, 0, 0.1, 0.5, 2]);
		assert.equal(host.processor.timeMap.at(-1).active, false);
	} finally { host.close(); }
});
