import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openHarness} from './wasm-harness.mjs';

const spec = {generation: 'native-wasm', sampleRate: 48000, channels: 1, lengthFrames: 48000 * 3600 * 12, capacityFrames: 24000};
const sine = (length, hz = 440, start = 0) => Float32Array.from({length}, (_, index) => .5 * Math.sin(2 * Math.PI * hz * (index + start) / spec.sampleRate));
const energy = data => data.reduce((sum, value) => sum + value * value, 0) / data.length;

test('bounded page prefetch crosses a twelve-hour wrap without evicting imminent WASM input', async t => {
	const capacityFrames = 48000, pageFrames = 12000, durationFrames = 96000;
	const h = await openHarness({...spec, capacityFrames});
	const windows = [];
	let cursor = 0, requests = 0, peakOwnedBytes = 0;
	try {
		await h.send('command', {command: {id: 1, atFrame: 0, position: spec.lengthFrames - 24000,
			active: true, loop: {start: 0, end: spec.lengthFrames}}}, 'queued');
		for (let frame = 0; frame < durationFrames; frame += 128) {
			h.render();
			await h.flush(); // Native port FIFO barrier, not a timer or audio deadline model.
			if (frame > capacityFrames) {
				assert.equal(h.lastRender.observation.status, 'playing');
				assert.equal(h.lastRender.validFrom, 0);
				assert.equal(h.lastRender.validTo, 128);
			}
			for (const need of h.messages.slice(cursor).filter(message => message.type === 'need')) {
				assert.ok(need.range.end - need.range.start <= capacityFrames / 2);
				const length = Math.min(pageFrames, need.range.end - need.range.start);
				let resident = h.transport.source.residentFrames;
				const drop = [];
				for (const window of windows) {
					if (resident + length <= capacityFrames) break;
					if (need.retain.some(range => window.start < range.end && window.end > range.start)) continue;
					drop.push(window);
					resident -= window.end - window.start;
				}
				if (drop.length) {
					const released = await h.send('drop', {starts: drop.map(window => window.start)}, 'released');
					released.buffers.length = 0;
					for (const window of drop) windows.splice(windows.indexOf(window), 1);
				}
				peakOwnedBytes = Math.max(peakOwnedBytes, (resident + length) * Float32Array.BYTES_PER_ELEMENT);
				assert.ok(peakOwnedBytes <= capacityFrames * Float32Array.BYTES_PER_ELEMENT);
				const pcm = sine(length, 440, need.range.start);
				await h.send('window', {start: need.range.start, channels: [pcm]}, 'window-accepted', [pcm.buffer]);
				assert.equal(pcm.byteLength, 0);
				windows.push({start: need.range.start, end: need.range.start + length});
				++requests;
			}
			cursor = h.messages.length;
		}
		// A bounded page reader must not turn every render quantum into an I/O
		// request. Allow two extra cache loads around initialisation and wrap.
		assert.ok(requests <= Math.ceil(durationFrames / pageFrames) + 2 * capacityFrames / pageFrames,
			`${requests} page requests for ${durationFrames} source frames`);
		t.diagnostic(JSON.stringify({durationFrames, requests, peakOwnedBytes, residentFrames: h.transport.source.residentFrames}));
	} finally { h.close(); }
});

test('actual embedded WASM renders a repeated short loop and acknowledges controls only at their render quantum', async () => {
	const harness = await openHarness(spec);
	try {
		await harness.send('window', {start: 0, channels: [sine(12000)]}, 'window-accepted');
		await harness.send('command', {command: {id: 1, atFrame: 256, position: 0, active: true, loop: {start: 0, end: 6000}}}, 'queued');
		assert.equal(harness.messages.some(message => message.type === 'applied'), false);
		assert.equal(energy(harness.render()[0]), 0);
		assert.equal(energy(harness.render()[0]), 0);
		const applied = harness.wait(message => message.type === 'applied');
		harness.render();
		assert.equal((await applied).renderFrame, 256);
		const captured = [];
		for (let block = 0; block < 192; ++block) captured.push(...harness.render()[0]);
		assert.ok(energy(captured.slice(6000)) > .1);
		assert.ok(captured.every(Number.isFinite));
		assert.equal(harness.transport.source.residentFrames, 12000);
	} finally {
		harness.close();
	}
});

test('underrun drains bounded valid WASM output then freezes and reprimes after PCM arrives', async () => {
	const harness = await openHarness(spec);
	try {
		await harness.send('window', {start: 0, channels: [sine(12000)]}, 'window-accepted');
		await harness.send('command', {command: {id: 1, atFrame: 0, position: 4000, active: true}}, 'queued');
		for (let block = 0; block < 32; ++block) harness.render();
		const released = await harness.send('drop', {starts: [0]}, 'released');
		assert.equal(released.residentFrames, 0);
		const underrun = harness.wait(message => message.type === 'state' && message.status === 'underrun');
		const tail = [];
		for (let block = 0; block < 23; ++block) {
			tail.push(...harness.render()[0]);
			assert.equal(harness.lastRender.observation.status, "draining");
		}
		assert.ok(energy(tail.slice(0, 2048)) > .05);
		assert.equal(harness.lastRender.validTo, 64);
		assert.equal(energy(tail.slice(harness.wasm._outputLatency())), 0);
		assert.equal(energy(harness.render()[0]), 0);
		const frozen = await underrun;
		assert.equal(frozen.sourceFrame, null);
		assert.ok(frozen.nextSourceFrame > 4000);
		for (let block = 0; block < 24; ++block) assert.equal(energy(harness.render()[0]), 0);
		await harness.send('window', {start: 0, channels: [sine(24000)]}, 'window-accepted');
		const resumed = harness.wait(message => message.type === 'state' && message.status === 'playing');
		for (let block = 0; block < 24; ++block) harness.render();
		assert.equal((await resumed).sourceFrame, frozen.nextSourceFrame);
	} finally {
		harness.close();
	}
});

test('interrupted preparation preserves the frozen boundary instead of presenting unprimed DSP silence', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [sine(24000)]}, 'window-accepted');
		await h.send('command', {command: {id: 1, atFrame: 0, position: 4000, active: true}}, 'queued');
		for (let block = 0; block < 64; ++block) h.render();
		await h.send('drop', {starts: [0]}, 'released');
		for (let block = 0; block < 24; ++block) h.render();
		await h.flush();
		const frozen = h.messages.findLast(message => message.type === 'state').nextSourceFrame;
		const start = frozen + h.wasm._inputLatency() - h.history;
		await h.send('window', {start, channels: [sine(h.history + 1, 440, start)]}, 'window-accepted');
		assert.equal(energy(h.render()[0]), 0);
		await h.send('drop', {starts: [start]}, 'released');
		for (let block = 0; block < 25; ++block) {
			assert.equal(energy(h.render()[0]), 0);
			if (h.lastRender) assert.equal(h.lastRender.validFrom, h.lastRender.validTo);
		}
		await h.flush();
		assert.equal(h.messages.findLast(message => message.type === 'state').nextSourceFrame, frozen);
		await h.send('window', {start: 0, channels: [sine(24000)]}, 'window-accepted');
		const resumed = h.wait(message => message.type === 'state' && message.status === 'playing');
		for (let block = 0; block < 24; ++block) h.render();
		assert.equal((await resumed).sourceFrame, frozen);
		assert.ok(energy(h.render()[0]) > .05);
	} finally { h.close(); }
});

test('discontinuous seek resets the old source and reports only latency-prepared output coordinates', async () => {
	const harness = await openHarness({...spec, lengthFrames: 96000, capacityFrames: 96000});
	let seed = 23;
	const source = Float32Array.from({length: 96000}, () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return (seed / 4294967296 - .5) * .5;
	});
	const assertAligned = output => {
		const start = harness.lastRender.observation.sourceFrame;
		let best = -Infinity, bestOffset = null;
		for (let offset = -16; offset <= 16; ++offset) {
			let product = 0;
			for (let index = 0; index < output.length; ++index) product += output[index] * source[start + offset + index];
			if (product > best) { best = product; bestOffset = offset; }
		}
		assert.equal(bestOffset, 0);
		assert.ok(energy(output) > .005);
	};
	try {
		await harness.send('window', {start: 0, channels: [source]}, 'window-accepted');
		await harness.send('command', {command: {id: 1, atFrame: 0, position: 12000, active: true}}, 'queued');
		for (let block = 0; block < 64; ++block) harness.render();
		assertAligned(harness.render()[0]);
		await harness.send('command', {command: {id: 2, atFrame: 0, position: 50000}}, 'queued');
		for (let block = 0; block < 22; ++block) {
			assert.equal(energy(harness.render()[0]), 0);
			assert.equal(harness.lastRender.observation.sourceFrame, null);
		}
		const boundary = harness.render()[0];
		assert.equal(harness.lastRender.validFrom, 64);
		assert.equal(harness.lastRender.observation.sourceFrame, 50000);
		assert.equal(energy(boundary.slice(0, 64)), 0);
		for (let block = 0; block < 40; ++block) harness.render();
		assertAligned(harness.render()[0]);
	} finally {
		harness.close();
	}
});

test('continuous rate automation distinguishes accepted processing settings from delayed output settings', async () => {
	const harness = await openHarness(spec);
	try {
		await harness.send('window', {start: 0, channels: [sine(12000)]}, 'window-accepted');
		await harness.send('command', {command: {id: 1, atFrame: 0, active: true, loop: {start: 0, end: 6000}}}, 'queued');
		for (let block = 0; block < 64; ++block) harness.render();
		const processingFrame = harness.frame;
		await harness.send('command', {command: {id: 2, atFrame: processingFrame, rate: 1.5}}, 'queued');
		const applied = harness.wait(message => message.type === 'applied' && message.commandId === 2);
		harness.render();
		const receipt = await applied;
		assert.equal(receipt.effectiveOutputFrame, processingFrame + harness.wasm._outputLatency());
		assert.equal(receipt.acceptedRate, 1.5);
		assert.equal(receipt.outputRate, 1);
		assert.equal(receipt.status, 'playing');
		for (let block = 0; block < 24; ++block) harness.render();
		assert.equal(harness.lastRender.observation.outputRate, 1.5);
		assert.equal(harness.lastRender.validFrom, 0);
	} finally {
		harness.close();
	}
});

test('natural end drains valid source output and masks everything after the exact source boundary', async () => {
	const harness = await openHarness({...spec, lengthFrames: 12000});
	try {
		await harness.send('window', {start: 0, channels: [sine(12000)]}, 'window-accepted');
		await harness.send('command', {command: {id: 1, atFrame: 0, position: 4000, active: true}}, 'queued');
		const captured = [];
		for (let block = 0; block < 100; ++block) captured.push(...harness.render()[0]);
		const end = harness.wasm._outputLatency() + 8000;
		assert.ok(energy(captured.slice(end - 256, end)) > .05);
		assert.equal(energy(captured.slice(end)), 0);
	} finally {
		harness.close();
	}
});

test('starved worker requests remain bounded and a confirmed read failure requires explicit retry', async () => {
	const harness = await openHarness(spec);
	try {
		await harness.send('command', {command: {id: 1, atFrame: 0, position: 4000, active: true}}, 'queued');
		for (let block = 0; block < 256; ++block) assert.equal(energy(harness.render()[0]), 0);
		await harness.send('read-failed', {}, 'read-failed');
		assert.equal(harness.messages.filter(message => message.type === 'need').length, 1);
		for (let block = 0; block < 32; ++block) harness.render();
		await harness.send('retry', {}, 'retry-accepted');
		assert.equal(harness.messages.filter(message => message.type === 'need').length, 1);
		const needed = harness.wait(message => message.type === 'need');
		harness.render();
		const request = await needed;
		assert.ok(request.range.end - request.range.start <= harness.history + 2);
		assert.equal(request.required, true);
	} finally {
		harness.close();
	}
});

test("natural end clips delayed rate segments rather than the latest accepted rate", async () => {
 const harness = await openHarness({...spec, lengthFrames:12000});
 try {
  await harness.send("window",{start:0,channels:[sine(12000)]},"window-accepted");
  await harness.send("command",{command:{id:1,atFrame:0,position:4003,active:true}},"queued");
  const captured=[];
  for(let block=0;block<80;++block)captured.push(...harness.render()[0]);
  await harness.send("command",{command:{id:2,atFrame:harness.frame,rate:.5}},"queued");
  for(let block=0;block<16;++block){
   captured.push(...harness.render()[0]);
   if(harness.frame===10880)assert.equal(harness.lastRender.validTo,125);
  }
  const end=harness.wasm._outputLatency()+7997;
  assert.ok(energy(captured.slice(end-64,end))>.05);
  assert.equal(energy(captured.slice(end)),0);
 }finally{harness.close();}
});

test("pause cuts output in its current quantum without leaking delayed source audio", async () => {
 const h=await openHarness(spec);
 try {
  await h.send("window",{start:0,channels:[sine(12000)]},"window-accepted");
  await h.send("command",{command:{id:1,atFrame:0,active:true,loop:{start:0,end:6000}}},"queued");
  for(let i=0;i<64;i++)h.render();
  assert.ok(energy(h.render()[0])>.05);
  const frame=h.frame;
  await h.send("command",{command:{id:2,atFrame:frame,active:false}},"queued");
  const applied=h.wait(m=>m.type==="applied"&&m.commandId===2);
  for(let i=0;i<32;i++)assert.equal(energy(h.render()[0]),0);
  assert.equal((await applied).effectiveOutputFrame,frame);
 }finally{h.close();}
});

test('active controls without PCM do not claim an effective future output frame', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('command', {command: {id: 1, atFrame: 0, active: true}}, 'queued');
		const applied = h.wait(message => message.type === 'applied');
		assert.equal(energy(h.render()[0]), 0);
		const receipt = await applied;
		assert.equal(receipt.effectiveOutputFrame, null);
		assert.equal(receipt.sourceFrame, null);
		assert.equal(receipt.status, 'underrun');
	} finally { h.close(); }
});

test('commands superseded in the same render quantum claim no intermediate audible state', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [sine(12000)]}, 'window-accepted');
		await h.send('command', {command: {id: 1, atFrame: 0, active: true}}, 'queued');
		await h.send('command', {command: {id: 2, atFrame: 0, active: false}}, 'queued');
		const first = h.wait(message => message.type === 'applied' && message.commandId === 1);
		const second = h.wait(message => message.type === 'applied' && message.commandId === 2);
		assert.equal(energy(h.render()[0]), 0);
		assert.equal((await first).superseded, true);
		assert.equal((await first).effectiveOutputFrame, null);
		assert.equal((await second).superseded, false);
		assert.equal((await second).effectiveOutputFrame, 0);
	} finally { h.close(); }
});

test('control during a drain acknowledges acceptance without inventing an output boundary', async () => {
	const h = await openHarness(spec);
	try {
		await h.send('window', {start: 0, channels: [sine(12000)]}, 'window-accepted');
		await h.send('command', {command: {id: 1, atFrame: 0, position: 4000, active: true}}, 'queued');
		for (let block = 0; block < 32; ++block) h.render();
		await h.send('drop', {starts: [0]}, 'released');
		assert.ok(energy(h.render()[0]) > .05);
		await h.send('command', {command: {id: 2, atFrame: h.frame, rate: 1.5}}, 'queued');
		const applied = h.wait(message => message.type === 'applied' && message.commandId === 2);
		h.render();
		const receipt = await applied;
		assert.equal(receipt.effectiveOutputFrame, null);
		assert.equal(receipt.acceptedRate, 1.5);
		assert.equal(receipt.outputRate, 1);
		assert.equal(receipt.status, 'draining');
		for (let block = 0; block < 32; ++block) h.render();
		await h.send('window', {start: 0, channels: [sine(24000)]}, 'window-accepted');
		const resumed = h.wait(message => message.type === 'state' && message.status === 'playing');
		for (let block = 0; block < 24; ++block) h.render();
		assert.equal((await resumed).outputRate, 1.5);
	} finally { h.close(); }
});

test('native port transfers retain bounded PCM ownership and reject stale generations', async () => {
	const h = await openHarness({...spec, capacityFrames: 12000});
	try {
		const owned = sine(12000);
		await h.send('window', {start: 0, channels: [owned]}, 'window-accepted', [owned.buffer]);
		assert.equal(owned.byteLength, 0);
		assert.equal(h.transport.source.residentFrames, 12000);
		await assert.rejects(h.send('window', {start: 12000, channels: [sine(128)]}, 'window-accepted'), /invalid_window/);
		await assert.rejects(h.send('drop', {generation: 'retired', starts: [0]}, 'released'), /stale_generation/);
		assert.equal(h.transport.source.residentFrames, 12000);
		const released = await h.send('drop', {starts: [0]}, 'released');
		assert.equal(released.residentFrames, 0);
		assert.equal(released.buffers[0].byteLength, 12000 * 4);
		const reused = new Float32Array(released.buffers[0]);
		assert.ok(energy(reused) > .1);
		await h.send('window', {start: 48000, channels: [reused]}, 'window-accepted', [reused.buffer]);
		assert.equal(reused.byteLength, 0);
		assert.equal(h.transport.source.residentFrames, 12000);
	} finally { h.close(); }
});
