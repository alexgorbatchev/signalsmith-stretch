import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {MessageChannel} from 'node:worker_threads';
import {openHarness} from './wasm-harness.mjs';
import {openProcessor} from './worklet-harness.mjs';

const decode = runInNewContext(readFileSync(new URL('../output-history.js', import.meta.url), 'utf8')
	+ '\ndecodeOutputHistory', {Float64Array}, {filename: fileURLToPath(new URL('../output-history.js', import.meta.url))});
const spec = {generation: 'discontinuity', sampleRate: 48000, channels: 1, lengthFrames: 96000,
	capacityFrames: 48000, outputHistory: {maxFrames: 48000, maxRecords: 4096, maxReplyRecords: 256}};
const pcm = () => Float32Array.from({length: 48000}, (_, i) => .5 * Math.sin(i * .081));
async function playing(h, command = {}) {
	await h.send('window', {start: 0, channels: [pcm()]}, 'window-accepted');
	await h.send('command', {command: {id: 1, atFrame: 0, position: 4000, active: true, ...command}}, 'queued');
	for (let i = 0; i < 40; i++) h.render();
	assert.equal(h.lastRender.observation.status, 'playing');
}
const silent = output => assert.ok(output.every(channel => channel.every(value => value === 0)));

for (const outputHistory of [spec.outputHistory, undefined]) {
	test(`stale and overlapping native frames preserve real WASM state, history ${Boolean(outputHistory)}`, async () => {
		const h = await openHarness({...spec, outputHistory}), peer = await openHarness({...spec, outputHistory});
		try {
			await playing(h); await playing(peer);
			const frontier = h.frame;
			for (const frame of [frontier - 128, frontier - 64, frontier - 256]) {
				silent(h.render(frame, 128, .75));
				assert.equal(h.lastRender.skipped, true);
			}
			for (const frames of [64, 256, 128]) {
				const frame = peer.frame;
				assert.deepEqual(h.render(frame, frames), peer.render(frame, frames));
				assert.deepEqual(h.lastRender.observation, peer.lastRender.observation);
			}
		} finally { h.close(); peer.close(); }
	});
}

test('stale callback leaves native command, metronome and observation credits pending until a real new interval', async () => {
	const h = await openHarness(spec);
	try {
		await playing(h);
		const frontier = h.frame;
		await h.send('command', {command: {id: 2, atFrame: frontier - 128, active: false}}, 'queued');
		await h.send('metronome', {enabled: true, regions: []}, 'metronome-queued');
		await h.send('observe-history', {fromFrame: frontier}, 'history-queued');
		await h.send('observe-output', {}, 'observation-queued');
		await h.flush();
		const start = h.messages.length;
		silent(h.render(frontier - 128, 128, .75));
		await h.flush();
		assert.deepEqual(h.messages.slice(start).filter(message => message.type !== 'harness-barrier'), []);
		silent(h.render(frontier));
		await h.flush();
		for (const type of ['applied', 'metronome-accepted', 'output-observation', 'output-history']) {
			assert.equal(h.messages.slice(start).filter(message => message.type === type).length, 1);
		}
		assert.equal(h.messages.findLast(message => message.type === 'applied').renderFrame, frontier);
		assert.equal(decode(h.messages.findLast(message => message.type === 'output-history'))[0].status, 'paused');
	} finally { h.close(); }
});

for (const phase of ['playing', 'preparing', 'draining']) test(`forward native gap discards ${phase} tail and retains only truthful new history`, async () => {
	const h = await openHarness(spec);
	try {
		await playing(h, {rate: 1.5, semitones: 3, loop: {start: 4000, end: 9000}});
		if (phase === 'preparing') {
			await h.send('command', {command: {id: 2, atFrame: h.frame, position: 5000}}, 'queued');
			h.render();
		} else if (phase === 'draining') {
			await h.send('drop', {starts: [0]}, 'released');
			h.render();
		}
		assert.equal(h.lastRender.observation.status, phase);
		const anchor = h.lastRender.observation.nextSourceFrame, oldThrough = h.frame, gap = oldThrough + 1024;
		await h.send('observe-history', {fromFrame: oldThrough}, 'history-queued');
		silent(h.render(gap));
		await h.flush();
		const reply = h.messages.findLast(message => message.type === 'output-history');
		assert.equal(reply.generationStartFrame, 0);
		assert.equal(reply.truncatedBeforeFrame, gap);
		assert.equal(reply.oldestRetainedFrame, gap);
		assert.equal(reply.returnedThroughFrame, gap + 128);
		const records = decode(reply);
		assert.equal(records[0].fromFrame, gap);
		assert.equal(records[0].sourceFrame, null);
		if (phase === 'draining') await h.send('window', {start: 0, channels: [pcm()]}, 'window-accepted');
		let resumed = null;
		for (let i = 0; i < 40; i++) {
			h.render();
			if (h.lastRender?.observation.sourceFrame !== null && h.lastRender) { resumed = h.lastRender.observation; break; }
		}
		assert.ok(resumed);
		assert.equal(resumed.sourceFrame, anchor);
		assert.equal(resumed.outputRate, 1.5);
		assert.equal(resumed.acceptedSemitones, 3);
		assert.deepEqual(resumed.acceptedLoop, {start: 4000, end: 9000});
	} finally { h.close(); }
});

test('forward gap applies a queued explicit seek after resetting to the last presented source frame', async () => {
	const h = await openHarness(spec);
	try {
		await playing(h);
		const gap = h.frame + 2048;
		await h.send('command', {command: {id: 2, atFrame: h.frame, position: 12000}}, 'queued');
		h.render(gap);
		for (let i = 0; i < 40 && h.lastRender?.observation.sourceFrame === null; i++) h.render();
		assert.equal(h.lastRender.observation.sourceFrame, 12000);
		await h.flush();
		assert.equal(h.messages.findLast(message => message.type === 'applied').renderFrame, gap);
	} finally { h.close(); }
});

test('stale callback preserves an already audible metronome tail without advancing or replaying its beat', async () => {
	const h = await openHarness(spec), peer = await openHarness(spec);
	try {
		for (const target of [h, peer]) {
			await target.send('window', {start: 0, channels: [new Float32Array(48000)]}, 'window-accepted');
			await target.send('metronome', {enabled: true, regions: [{startFrame: 0, endFrame: 96000,
				firstBeatFrame: 0, framesPerBeat: 6000, firstBeatIndex: 0}]}, 'metronome-queued');
			await target.send('command', {command: {id: 1, atFrame: 0, position: 0, active: true}}, 'queued');
		}
		let heard = false;
		for (let i = 0; i < 40; i++) {
			const output = peer.render();
			assert.deepEqual(h.render(), output);
			if (output[0].some(value => Math.abs(value) > .1)) { heard = true; break; }
		}
		assert.equal(heard, true);
		const frontier = h.frame;
		silent(h.render(frontier - 128, 128, .75));
		const expected = peer.render();
		assert.ok(expected[0].some(value => value !== 0), 'peer still contains the actual click tail');
		assert.deepEqual(h.render(frontier), expected);
		for (let i = 0; i < 12; i++) assert.deepEqual(h.render(), peer.render());
		const gap = h.frame + 1024;
		silent(h.render(gap));
		assert.equal(h.lastRender.observation.sourceFrame, null);
	} finally { h.close(); peer.close(); }
});

test('forward gap with a nonseek control keeps the last audible anchor rather than its old processing snapshot', async () => {
	const h = await openHarness(spec);
	try {
		await playing(h);
		const anchor = h.lastRender.observation.nextSourceFrame;
		await h.send('command', {command: {id: 2, atFrame: h.frame, rate: .5}}, 'queued');
		h.render(h.frame + 1024);
		assert.equal(h.lastRender.observation.processingSourceFrame, anchor);
		for (let i = 0; i < 40 && h.lastRender.observation.sourceFrame === null; i++) h.render();
		assert.equal(h.lastRender.observation.sourceFrame, anchor);
		assert.equal(h.lastRender.observation.outputRate, .5);
	} finally { h.close(); }
});

test('native discontinuities preserve the outstanding PCM request until its real window response arrives', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('command', {command: {id: 1, atFrame: 0, active: true, position: 4000}}, 'queued');
		h.render(); await h.flush();
		const need = h.messages.find(message => message.type === 'need');
		assert.ok(need);
		silent(h.render(0, 128, .75));
		silent(h.render(1024));
		for (let i = 0; i < 4; i++) h.render();
		await h.flush();
		assert.equal(h.messages.filter(message => message.type === 'need').length, 1);
		assert.equal(h.transport.source.residentFrames, 0);
		await h.send('window', {start: 0, channels: [pcm()]}, 'window-accepted');
		for (let i = 0; i < 40 && h.lastRender?.observation.status !== 'playing'; i++) h.render();
		assert.equal(h.lastRender.observation.sourceFrame, 4000);
		assert.equal(h.transport.source.residentFrames, 48000);
	} finally { h.close(); }
});

test('real AudioWorklet processor keeps returning true and silences a duplicate host frame before recovering', async () => {
	const host = await openProcessor();
	try {
		// attachSource accepts a native transferred MessagePort; use the same
		// actual transport protocol as the standalone embedded-WASM harness.
		const {port1, port2} = new MessageChannel();
		try {
			await host.call('attachSource', [spec, port1], [port1]);
			const send = (requestId, type, data, expected) => new Promise(resolve => {
				const listener = message => {
					if (message.requestId === requestId && message.type === expected) { port2.off('message', listener); resolve(message); }
				};
				port2.on('message', listener);
				port2.postMessage({type, generation: spec.generation, requestId, ...data});
			});
			await send(1, 'window', {start: 0, channels: [pcm()]}, 'window-accepted');
			await send(2, 'command', {command: {id: 1, atFrame: 0, active: true}}, 'queued');
			for (let i = 0; i < 40; i++) {
				assert.equal(host.processor.process([], [[new Float32Array(128)]], {}), true);
				host.advance();
			}
			const frontier = host.context.currentFrame;
			host.context.currentFrame -= 128;
			host.context.currentTime = host.context.currentFrame / spec.sampleRate;
			const stale = new Float32Array(128).fill(.75);
			assert.equal(host.processor.process([], [[stale]], {}), true);
			silent([stale]);
			host.context.currentFrame = frontier;
			host.context.currentTime = frontier / spec.sampleRate;
			const recovered = new Float32Array(128);
			assert.equal(host.processor.process([], [[recovered]], {}), true);
			assert.ok(recovered.some(value => Math.abs(value) > .1));
		} finally { port2.close(); }
	} finally { host.close(); }
});

test('history drops its old ring on every forward gap while decoding only the bounded real suffix', () => {
	const {createOutputHistory, decodeOutputHistory} = runInNewContext(readFileSync(new URL('../output-history.js', import.meta.url), 'utf8')
		+ '\n({createOutputHistory, decodeOutputHistory})', {Float64Array});
	const history = createOutputHistory({maxFrames: 512, maxRecords: 2, maxReplyRecords: 1});
	for (const frame of [0, 128, 256, 1024, 1152, 2048]) {
		history.append({renderFrame: frame, renderedThroughFrame: frame + 128, status: 'paused', ended: false, outputSegments: []});
	}
	const reply = history.read(0);
	assert.equal(reply.generationStartFrame, 0);
	assert.equal(reply.truncatedBeforeFrame, 2048);
	assert.equal(reply.returnedThroughFrame, 2176);
	assert.equal(decodeOutputHistory(reply)[0].fromFrame, 2048);
	assert.throws(() => history.append({renderFrame: 2100, renderedThroughFrame: 2228}), /Overlapping/);
	assert.deepEqual(history.read(0), reply);
});

test('a pause queued across a forward gap freezes at the last presented boundary and acknowledges the actual interval', async () => {
	const h = await openHarness(spec);
	try {
		await playing(h);
		const anchor = h.lastRender.observation.nextSourceFrame, gap = h.frame + 1024;
		await h.send('command', {command: {id: 2, atFrame: h.frame, active: false}}, 'queued');
		silent(h.render(gap));
		await h.flush();
		const ack = h.messages.findLast(message => message.type === 'applied');
		assert.equal(ack.commandId, 2);
		assert.equal(ack.renderFrame, gap);
		assert.equal(ack.effectiveOutputFrame, gap);
		assert.equal(ack.nextSourceFrame, anchor);
		assert.equal(ack.sourceFrame, null);
		assert.equal(ack.status, 'paused');
		const reply = await h.send('observe-history', {fromFrame: 0}, 'output-history');
		assert.equal(reply.truncatedBeforeFrame, gap);
		assert.equal(decode(reply)[0].status, 'paused');
	} finally { h.close(); }
});

test('same-quantum pause seek and rate controls across a native gap retain order and only the final effective output boundary', async () => {
	const h = await openHarness(spec);
	try {
		await playing(h);
		const atFrame = h.frame, gap = atFrame + 2048;
		await h.send('command', {command: {id: 2, atFrame, active: false}}, 'queued');
		await h.send('command', {command: {id: 3, atFrame, position: 12000}}, 'queued');
		await h.send('command', {command: {id: 4, atFrame, active: true, rate: .5}}, 'queued');
		silent(h.render(gap));
		await h.flush();
		const acks = h.messages.filter(message => message.type === 'applied' && message.commandId > 1);
		assert.deepEqual(acks.map(message => message.commandId), [2, 3, 4]);
		assert.deepEqual(acks.map(message => message.superseded), [true, true, false]);
		assert.deepEqual(acks.map(message => message.effectiveOutputFrame), [null, null, gap + h.wasm._outputLatency()]);
		assert.ok(acks.every(message => message.renderFrame === gap));
		for (let i = 0; i < 40 && h.lastRender.observation.sourceFrame === null; i++) h.render();
		assert.equal(h.lastRender.observation.sourceFrame, 12000);
		assert.equal(h.lastRender.observation.outputRate, .5);
	} finally { h.close(); }
});
