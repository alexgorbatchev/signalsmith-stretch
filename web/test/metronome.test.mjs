import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openHarness} from './wasm-harness.mjs';
import {openProcessor} from './worklet-harness.mjs';
import {MessageChannel} from 'node:worker_threads';

const spec = {generation: 'metronome', sampleRate: 48000, channels: 1, lengthFrames: 48000, capacityFrames: 24000};
const regions = [{startFrame: 0, endFrame: 48000, firstBeatFrame: 100.25, framesPerBeat: 6000, firstBeatIndex: 0}];
const clickValue = (age, downbeat = true) => {
	const time = age / 48000, gain = downbeat ? .5 : .3;
	return gain * Math.exp(Math.log(.001 / gain) * time / .03) * Math.sin(2 * Math.PI * (downbeat ? 1760 : 1100) * time);
};
async function configure(h, data = {enabled: true, regions}) {
	await h.send('metronome', data, 'metronome-queued');
	const accepted = h.wait(message => message.type === 'metronome-accepted');
	const effective = h.frame;
	h.render();
	assert.equal((await accepted).effectiveOutputFrame, effective);
}

test('native WASM output mixes exact fractional beat crossings at the delayed rendered rate', async () => {
	for (const rate of [.5, 1, 1.5, 2]) {
		const h = await openHarness(spec);
		try {
			await h.send('window', {start: 0, channels: [new Float32Array(24000)]}, 'window-accepted');
			await configure(h);
			await h.send('command', {command: {id: 1, atFrame: h.frame, position: 0, active: true, rate}}, 'queued');
			let first = null, onset = null, samples = [];
			for (let block = 0; block < 90; ++block) {
				const frame = h.frame, output = h.render()[0];
				for (const segment of h.lastRender?.observation.outputSegments || []) {
					first ??= segment.fromFrame;
					if (onset === null && segment.sourceFrame <= 100.25 && segment.sourceFrame + (segment.toFrame - segment.fromFrame) * segment.rate > 100.25)
						onset = segment.fromFrame + Math.ceil((100.25 - segment.sourceFrame) / segment.rate);
				}
				samples.push(...output);
				if (frame > (first ?? Infinity) + 2000) break;
			}
			assert.notEqual(onset, null);
			const actual = onset - 128;
			assert.ok(actual >= 0);
			assert.ok(samples.slice(0, actual + 1).every(value => value === 0));
			for (let age = 1; age < 100; ++age) assert.ok(Math.abs(samples[actual + age] - clickValue(age)) < 2e-8, `${rate} sample ${age}`);
		} finally { h.close(); }
	}
});

test('disabled default leaves zero PCM unchanged; enabling without valid output never creates audio', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [new Float32Array(24000)]}, 'window-accepted');
		await h.send('command', {command: {id: 1, atFrame: 0, position: 0, active: true, loop: {start: 0, end: 6000}}}, 'queued');
		for (let block = 0; block < 80; ++block) assert.ok(h.render()[0].every(value => value === 0));
		await h.send('command', {command: {id: 2, atFrame: h.frame, active: false}}, 'queued');
		await configure(h);
		for (let block = 0; block < 16; ++block) assert.ok(h.render()[0].every(value => value === 0));
	} finally { h.close(); }
});

test('metronome validates bounded immutable regions and only one pending update', async () => {
	const h = await openHarness(spec);
	try {
		await assert.rejects(h.send('metronome', {enabled: true, regions: Array.from({length: 4097}, (_, index) => ({
			startFrame: index * 2, endFrame: index * 2 + 2, firstBeatFrame: index * 2 + 1,
			framesPerBeat: 1, firstBeatIndex: index,
		}))}, 'metronome-queued'), /invalid_metronome/);
		await assert.rejects(h.send('metronome', {enabled: true, regions: [{...regions[0], framesPerBeat: 0}]}, 'metronome-accepted'), /invalid_metronome/);
		await h.send('metronome', {enabled: true, regions}, 'metronome-queued');
		const accepted = h.wait(message => message.type === 'metronome-accepted');
		await assert.rejects(h.send('metronome', {enabled: false, regions: []}, 'metronome-accepted'), /invalid_metronome/);
		h.render();
		assert.equal((await accepted).enabled, true);
	} finally { h.close(); }
});

test('fractional loop wraps click at exact repeated output samples, independently of pitch transpose', async () => {
	for (const rate of [.5, 1, 1.5, 2]) {
		const h = await openHarness(spec);
		try {
			await h.send('window', {start: 0, channels: [new Float32Array(24000)]}, 'window-accepted');
			await configure(h);
			await h.send('command', {command: {id: 1, atFrame: h.frame, position: 100.25, active: true,
				rate, semitones: 7, loop: {start: 100.25, end: 6100.25}}}, 'queued');
			let first = null;
			for (let block = 0; block < 240; ++block) {
				const frame = h.frame, output = h.render()[0];
				first ??= h.lastRender?.observation.outputSegments[0]?.fromFrame ?? null;
				for (let index = 0; index < output.length; ++index) {
					const elapsed = frame + index - first;
					const age = elapsed % (6000 / rate);
					const expected = first !== null && elapsed >= 0 && age < 1440 ? clickValue(age) : 0;
					assert.ok(Math.abs(output[index] - expected) < 2e-8, `${rate} frame ${frame + index}`);
				}
			}
			assert.notEqual(first, null);
		} finally { h.close(); }
	}
});

test('seek and pause cut an existing click tail instead of leaking old-source metronome audio', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [new Float32Array(24000)]}, 'window-accepted');
		await configure(h);
		await h.send('command', {command: {id: 1, atFrame: h.frame, position: 0, active: true}}, 'queued');
		let heard = false;
		for (let block = 0; block < 40; ++block) if (h.render()[0].some(value => Math.abs(value) > .1)) { heard = true; break; }
		assert.equal(heard, true);
		await h.send('command', {command: {id: 2, atFrame: h.frame, position: 3000}}, 'queued');
		for (let block = 0; block < 30; ++block) assert.ok(h.render()[0].every(value => value === 0));
		await h.send('command', {command: {id: 3, atFrame: h.frame, position: 0}}, 'queued');
		heard = false;
		for (let block = 0; block < 40; ++block) if (h.render()[0].some(value => Math.abs(value) > .1)) { heard = true; break; }
		assert.equal(heard, true);
		await h.send('command', {command: {id: 4, atFrame: h.frame, active: false}}, 'queued');
		for (let block = 0; block < 32; ++block) assert.ok(h.render()[0].every(value => value === 0));
	} finally { h.close(); }
});

test('actual delayed drain can click, starvation cannot, and recovered preparation stays silent', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [new Float32Array(12000)]}, 'window-accepted');
		await configure(h, {enabled: true, regions: [{...regions[0], firstBeatFrame: 6000.25}]});
		await h.send('command', {command: {id: 1, atFrame: h.frame, position: 4000, active: true}}, 'queued');
		for (let block = 0; block < 32; ++block) h.render();
		await h.send('drop', {starts: [0]}, 'released');
		let nonzero = 0;
		for (let block = 0; block < 23; ++block) {
			const output = h.render()[0];
			assert.equal(h.lastRender.observation.status, 'draining');
			nonzero += output.filter(value => Math.abs(value) > .1).length;
			assert.ok(output.slice(h.lastRender.validTo).every(value => value === 0));
		}
		assert.ok(nonzero > 100);
		for (let block = 0; block < 24; ++block) assert.ok(h.render()[0].every(value => value === 0));
		await h.send('window', {start: 0, channels: [new Float32Array(24000)]}, 'window-accepted');
		for (let block = 0; block < 20; ++block) assert.ok(h.render()[0].every(value => value === 0));
	} finally { h.close(); }
});

test('loop exit continues clicking against the old audible loop until its delayed output transition', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [new Float32Array(24000)]}, 'window-accepted');
		await configure(h);
		await h.send('command', {command: {id: 1, atFrame: h.frame, position: 100.25, active: true,
			loop: {start: 100.25, end: 6100.25}}}, 'queued');
		let first = null;
		for (let block = 0; block < 100; ++block) {
			h.render();
			first ??= h.lastRender?.observation.outputSegments[0]?.fromFrame ?? null;
			if (h.lastRender?.observation.sourceFrame > 5800) break;
		}
		assert.notEqual(first, null);
		await h.send('command', {command: {id: 2, atFrame: h.frame, loop: null}}, 'queued');
		for (let block = 0; block < 20; ++block) {
			const frame = h.frame, output = h.render()[0];
			assert.equal(h.lastRender.observation.acceptedLoop, null);
			assert.ok(h.lastRender.observation.outputSegments.every(segment => segment.loop !== null));
			for (let index = 0; index < output.length; ++index) {
				const age = (frame + index - first) % 6000;
				assert.ok(Math.abs(output[index] - (age < 1440 ? clickValue(age) : 0)) < 2e-8);
			}
		}
	} finally { h.close(); }
});

test('finite EOF clips a click tail and never turns the EOF boundary into an extra beat', async () => {
	const h = await openHarness({...spec, lengthFrames: 12000});
	try {
		await h.send('window', {start: 0, channels: [new Float32Array(12000)]}, 'window-accepted');
		await configure(h, {enabled: true, regions: [{startFrame: 0, endFrame: 24000,
			firstBeatFrame: 11900.25, framesPerBeat: 99.5, firstBeatIndex: 0}]});
		await h.send('command', {command: {id: 1, atFrame: h.frame, position: 11000, active: true}}, 'queued');
		let heard = false, ended = false;
		for (let block = 0; block < 80; ++block) {
			const output = h.render()[0];
			if (output.some(value => Math.abs(value) > .1)) heard = true;
			if (ended) assert.ok(output.every(value => value === 0));
			if (h.lastRender?.observation.ended) {
				assert.ok(output.slice(h.lastRender.validTo).every(value => value === 0));
				ended = true;
			}
		}
		assert.equal(heard, true);
		assert.equal(ended, true);
	} finally { h.close(); }
});

test('the actual zero-input AudioWorklet wrapper mixes after copying its embedded WASM output', async () => {
	const host = await openProcessor(), {port1, port2} = new MessageChannel();
	let id = 0;
	const send = (type, data, response) => {
		const requestId = ++id;
		const result = new Promise(resolve => {
			const listener = message => {
				if (message.requestId === requestId && message.type === response) { port2.off('message', listener); resolve(message); }
			};
			port2.on('message', listener);
		});
		port2.postMessage({type, generation: spec.generation, requestId, ...data});
		return result;
	};
	try {
		await host.call('attachSource', [spec, port1], [port1]);
		await send('window', {start: 0, channels: [new Float32Array(24000)]}, 'window-accepted');
		await send('metronome', {enabled: true, regions}, 'metronome-queued');
		await send('command', {command: {id: 1, atFrame: 0, position: 0, active: true}}, 'queued');
		let heard = false;
		for (let block = 0; block < 64; ++block) {
			const output = new Float32Array(128);
			assert.equal(host.processor.process([], [[output]], {}), true);
			host.advance();
			if (output.some(value => Math.abs(value) > .1)) heard = true;
		}
		assert.equal(heard, true);
	} finally { host.close(); port2.close(); }
});
