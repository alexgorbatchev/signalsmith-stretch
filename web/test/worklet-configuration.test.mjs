import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MessageChannel} from 'node:worker_threads';
import {openProcessor} from './worklet-harness.mjs';

test('initial render quanta are silent while WASM initializes and the processor remains live', async () => {
	const output = [[new Float32Array(128).fill(1), new Float32Array(128).fill(-1)]];
	let keptAlive;
	const host = await openProcessor({beforeReady(processor) {
		keptAlive = processor.process([], output);
	}});
	try {
		assert.equal(keptAlive, true);
		for (const channel of output[0]) assert.ok(channel.every(value => value === 0));
		assert.ok(await host.call('latency') > 0);
	} finally {
		host.close();
	}
});

test('zero-input source nodes remain silent before attach, while paused, and after detach', async () => {
	const host = await openProcessor();
	const {port1, port2} = new MessageChannel();
	const renderSilent = () => {
		const output = new Float32Array(128).fill(1);
		assert.equal(host.processor.process([], [[output]], {}), true);
		assert.ok(output.every(value => value === 0));
	};
	try {
		renderSilent();
		await host.call('attachSource', [{generation: 'zero-input', sampleRate: 48000,
			channels: 1, lengthFrames: 48000, capacityFrames: 12000}, port1], [port1]);
		renderSilent();
		await host.call('detachSource');
		renderSilent();
	} finally { host.close(); port2.close(); }
});

test('attached source configuration is immutable until detach and rejected changes are atomic', async () => {
	const host = await openProcessor();
	const {port1, port2} = new MessageChannel();
	try {
		await host.call('attachSource', [{generation: 'configuration', sampleRate: 48000,
			channels: 1, lengthFrames: 48000, capacityFrames: 12000}, port1], [port1]);
		const original = host.processor.bufferLength;
		await assert.rejects(host.call('configure', [{blockMs: 500}]), {name: 'InvalidStateError'});
		assert.equal(host.processor.bufferLength, original);
		assert.equal(host.processor.config.blockMs, undefined);
		assert.equal(host.processor.windowedTransport.source.description.generation, 'configuration');
		await host.call('detachSource');
		await host.call('configure', [{blockMs: 500}]);
		assert.ok(host.processor.bufferLength > original);
	} finally { host.close(); port2.close(); }
});

test('changed output channel count closes the incompatible generation and silences that quantum', async () => {
	const host = await openProcessor();
	const {port1, port2} = new MessageChannel();
	try {
		await host.call('attachSource', [{generation: 'channels', sampleRate: 48000,
			channels: 1, lengthFrames: 48000, capacityFrames: 12000}, port1], [port1]);
		const closed = new Promise(resolve => {
			port2.on('message', message => { if (message.type === 'source-closed') resolve(message); });
		});
		const output = [new Float32Array(128).fill(1), new Float32Array(128).fill(1)];
		assert.equal(host.processor.process([[]], [output], {}), true);
		assert.equal(host.processor.windowedTransport, null);
		assert.ok(output.every(channel => channel.every(value => value === 0)));
		assert.equal((await closed).reason, 'output_channels_changed');
		assert.equal(host.processor.channels, 2);
	} finally { host.close(); port2.close(); }
});
