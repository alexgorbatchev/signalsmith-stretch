import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openHarness} from './wasm-harness.mjs';

const spec = {generation: 'rendered-clock', sampleRate: 48000, channels: 1, lengthFrames: 48000, capacityFrames: 24000};

async function observe(h) {
	await h.send('observe-output', {}, 'observation-queued');
	const pending = h.wait(message => message.type === 'output-observation');
	const output = h.render()[0];
	return {observation: await pending, output};
}

function assertCoverage(observation) {
	const {renderFrame, validFrom, validTo, outputSegments} = observation;
	assert.equal(outputSegments.reduce((length, segment) => length + segment.toFrame - segment.fromFrame, 0),
		Math.max(0, validTo - validFrom));
	if (outputSegments.length) {
		assert.equal(outputSegments[0].fromFrame, renderFrame + validFrom);
		assert.equal(outputSegments.at(-1).toFrame, renderFrame + validTo);
	}
	for (let index = 1; index < outputSegments.length; index++) {
		assert.equal(outputSegments[index - 1].toFrame, outputSegments[index].fromFrame);
	}
	for (const segment of outputSegments) {
		assert.ok(segment.fromFrame >= renderFrame);
		assert.ok(segment.toFrame <= observation.renderedThroughFrame);
	}
}

test('rendered output segments retain delayed loop bounds after accepted loop exit', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [Float32Array.from({length: 24000}, (_, i) => .5 * Math.sin(2 * Math.PI * 440 * i / spec.sampleRate))]}, 'window-accepted');
		await h.send('command', {command: {id: 1, atFrame: 0, position: 0, active: true, loop: {start: 0, end: 6000}}}, 'queued');
		for (let block = 0; block < 200; block++) {
			h.render();
			if (h.lastRender?.observation.sourceFrame > 5800) break;
		}
		await h.send('command', {command: {id: 2, atFrame: h.frame, loop: null}}, 'queued');
		h.render();
		const observation = h.lastRender.observation;
		assert.equal(observation.acceptedLoop, null);
		assert.equal(observation.sourceFrame, 5952);
		assert.equal(observation.nextSourceFrame, 80);
		assert.ok(Array.isArray(observation.outputSegments), 'public observation must describe the actual delayed output segment');
		assert.deepEqual(observation.outputSegments, [{
			fromFrame: 8832, toFrame: 8896, sourceFrame: 5952, rate: 1, loop: {start: 0, end: 6000},
		}, {
			fromFrame: 8896, toFrame: 8960, sourceFrame: 16, rate: 1, loop: {start: 0, end: 6000},
		}]);
	} finally { h.close(); }
});

test('fractional subquantum loops reconstruct every rendered sample through multiple wraps', async () => {
	const h = await openHarness(spec);
	const loop = {start: 100.25, end: 117.75}, rate = 2;
	try {
		await h.send('window', {start: 0, channels: [new Float32Array(24000).fill(.25)]}, 'window-accepted');
		await h.send('command', {command: {id: 1, atFrame: 0, position: loop.start, rate, active: true, loop}}, 'queued');
		let samples = 0;
		for (let block = 0; block < 64; block++) {
			const {observation} = await observe(h);
			assertCoverage(observation);
			for (const segment of observation.outputSegments) {
				assert.deepEqual(segment.loop, loop);
				for (let frame = segment.fromFrame; frame < segment.toFrame; frame++) {
					const expected = loop.start + ((frame - h.wasm._outputLatency()) * rate) % (loop.end - loop.start);
					const actual = loop.start + (segment.sourceFrame - loop.start + (frame - segment.fromFrame) * segment.rate) % (loop.end - loop.start);
					assert.equal(actual, expected);
					samples++;
				}
			}
		}
		assert.ok(samples > 5000);
	} finally { h.close(); }
});

test('output observation requests have one pending credit and return a fresh completed quantum', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [new Float32Array(24000).fill(.25)]}, 'window-accepted');
		await h.send('command', {command: {id: 1, atFrame: 0, active: true, loop: {start: 0, end: 6000}}}, 'queued');
		await h.send('observe-output', {}, 'observation-queued');
		await assert.rejects(h.send('observe-output', {}, 'observation-queued'), /observation_pending/);
		const first = h.wait(message => message.type === 'output-observation');
		for (let block = 0; block < 64; block++) h.render();
		const firstObservation = await first;
		assert.equal(firstObservation.renderFrame, 0);
		assert.equal(firstObservation.renderedThroughFrame, 128);
		assert.deepEqual(firstObservation.outputSegments, []);
		await h.flush();
		assert.equal(h.messages.filter(message => message.type === 'output-observation').length, 1,
			'a throttled consumer must not accumulate unsolicited quantum snapshots');
		await h.send('observe-output', {}, 'observation-queued');
		const next = h.wait(message => message.type === 'output-observation');
		const expectedFrame = h.frame;
		h.render();
		const observation = await next;
		assert.equal(observation.renderFrame, expectedFrame);
		assert.equal(observation.renderedThroughFrame, h.frame);
		assert.equal(observation.outputSegments[0].fromFrame, expectedFrame);
		assert.equal(observation.outputSegments.at(-1).toFrame, h.frame);
		for (const segment of observation.outputSegments) {
			assert.ok(segment.fromFrame >= expectedFrame);
			assert.ok(segment.toFrame <= observation.renderedThroughFrame);
			assert.ok(segment.toFrame > segment.fromFrame);
		}
		await h.send('observe-output', {}, 'observation-queued');
		const closed = h.wait(message => message.type === 'rejected' && message.code === 'source_closed');
		h.transport.close();
		await closed;
	} finally { h.close(); }
});

test('a quantum spanning delayed rate acceptance reports both actual output segments', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [new Float32Array(24000).fill(.25)]}, 'window-accepted');
		await h.send('command', {command: {id: 1, atFrame: 0, active: true, loop: {start: 0, end: 6000}}}, 'queued');
		for (let block = 0; block < 64; block++) h.render();
		await h.send('command', {command: {id: 2, atFrame: h.frame, rate: 1.5}}, 'queued');
		const applied = h.wait(message => message.type === 'applied' && message.commandId === 2);
		h.render();
		const acceptance = await applied;
		assert.equal(acceptance.acceptedRate, 1.5);
		assert.equal(acceptance.outputRate, 1);
		let transition;
		for (let block = 0; block < 32; block++) {
			h.render();
			const segments = h.lastRender.observation.outputSegments;
			if (segments.length === 2 && segments[0].rate !== segments[1].rate) {
				transition = segments;
				break;
			}
		}
		assert.ok(transition, 'the actual delayed transition must remain visible within its native quantum');
		assert.equal(transition[0].rate, 1);
		assert.equal(transition[1].rate, 1.5);
		assert.equal(transition[0].toFrame, acceptance.effectiveOutputFrame);
		assert.equal(transition[1].fromFrame, acceptance.effectiveOutputFrame);
	} finally { h.close(); }
});

test('pause and seek invalidate prior output evidence until newly rendered source exists', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [new Float32Array(24000).fill(.25)]}, 'window-accepted');
		await h.send('command', {command: {id: 1, atFrame: 0, active: true}}, 'queued');
		for (let block = 0; block < 40; block++) h.render();
		assert.ok((await observe(h)).observation.outputSegments.length);
		await h.send('command', {command: {id: 2, atFrame: h.frame, active: false}}, 'queued');
		const paused = await observe(h);
		assert.deepEqual(paused.observation.outputSegments, []);
		assert.ok(paused.output.every(value => value === 0));
		await h.send('command', {command: {id: 3, atFrame: h.frame, position: 12000.25, active: true}}, 'queued');
		let first;
		for (let block = 0; block < 24; block++) {
			const result = await observe(h);
			assertCoverage(result.observation);
			if (result.observation.outputSegments.length) { first = result.observation; break; }
			assert.ok(result.output.every(value => value === 0));
		}
		assert.equal(first.outputSegments[0].sourceFrame, 12000.25);
		assert.equal(first.outputSegments[0].fromFrame, first.renderFrame + 64);
	} finally { h.close(); }
});

test('starvation observations cover only the drained tail and become unavailable until reprime', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [new Float32Array(12000).fill(.25)]}, 'window-accepted');
		await h.send('command', {command: {id: 1, atFrame: 0, position: 4000, active: true}}, 'queued');
		for (let block = 0; block < 32; block++) h.render();
		await h.send('drop', {starts: [0]}, 'released');
		let frames = 0;
		for (let block = 0; block < 23; block++) {
			const {observation} = await observe(h);
			assert.equal(observation.status, 'draining');
			assertCoverage(observation);
			frames += observation.outputSegments.reduce((count, segment) => count + segment.toFrame - segment.fromFrame, 0);
		}
		assert.equal(frames, h.wasm._outputLatency());
		for (let block = 0; block < 4; block++) {
			const {observation, output} = await observe(h);
			assert.equal(observation.status, 'underrun');
			assert.deepEqual(observation.outputSegments, []);
			assert.ok(output.every(value => value === 0));
		}
		await h.send('window', {start: 0, channels: [new Float32Array(24000).fill(.25)]}, 'window-accepted');
		for (let block = 0; block < 22; block++) assert.deepEqual((await observe(h)).observation.outputSegments, []);
		assert.ok((await observe(h)).observation.outputSegments.length);
	} finally { h.close(); }
});

for (const rate of [.5, 1, 1.5, 2]) test('fractional finite end clips rendered coverage at rate ' + rate, async () => {
	const h = await openHarness({...spec, lengthFrames: 12000});
	try {
		await h.send('window', {start: 0, channels: [new Float32Array(12000).fill(.25)]}, 'window-accepted');
		await h.send('command', {command: {id: 1, atFrame: 0, position: 10000.25, rate, active: true}}, 'queued');
		let frames = 0, lastEnd;
		for (let block = 0; block < 64; block++) {
			const {observation, output} = await observe(h);
			assertCoverage(observation);
			for (const segment of observation.outputSegments) {
				assert.equal(segment.loop, null);
				assert.ok(segment.sourceFrame < 12000);
				frames += segment.toFrame - segment.fromFrame;
				lastEnd = segment.toFrame;
			}
			assert.ok(output.slice(observation.validTo).every(value => value === 0));
		}
		assert.equal(frames, Math.ceil((12000 - 10000.25) / rate));
		assert.equal(lastEnd, h.wasm._outputLatency() + frames);
	} finally { h.close(); }
});
