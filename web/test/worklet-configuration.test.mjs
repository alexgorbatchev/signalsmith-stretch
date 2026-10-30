import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createContext, runInContext} from 'node:vm';
import {MessageChannel, MessagePort} from 'node:worker_threads';

// Host only the AudioWorklet class/registration API. DSP, ports, and RPC dispatch
// are the real published wrapper and embedded WASM, not substitute algorithms.
async function openProcessor() {
	const {port1, port2} = new MessageChannel();
	let Processor;
	const context = createContext({
		Float32Array, ArrayBuffer, MessagePort, sampleRate: 48000, currentFrame: 0, currentTime: 0,
		AudioWorkletProcessor: class { constructor() { this.port = port1; } },
		registerProcessor(_name, value) { Processor = value; }
	});
	const source = ['emscripten/main.js', 'windowed-source.js', 'windowed-transport.js', 'web-wrapper.js']
		.map(path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')).join('\n');
	runInContext(source, context);
	const ready = new Promise(resolve => port2.once('message', resolve));
	const processor = new Processor({numberOfOutputs: 1, outputChannelCount: [1]});
	assert.equal((await ready)[0], 'ready');
	let id = 0;
	return {
		processor,
		async call(method, args = [], transfer = []) {
			const request = ++id;
			const response = new Promise(resolve => port2.once('message', resolve));
			port2.postMessage([request, method, ...args], transfer);
			const result = await response;
			assert.equal(result[0], request);
			if (result[2]) throw Object.assign(new Error(result[2].message), {name: result[2].name});
			return result[1];
		},
		close() { processor.windowedTransport?.close(); port1.close(); port2.close(); }
	};
}

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
