import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createContext, runInContext} from 'node:vm';
import {MessageChannel, MessagePort} from 'node:worker_threads';

// Supply the platform's node/processor registration boundary; both sides execute
// the actual wrapper, MessagePorts, and embedded WASM.
function openContext() {
	let Processor;
	const processors = [], ports = [], modules = [];
	const worklet = createContext({Float32Array, ArrayBuffer, MessagePort, sampleRate: 48000,
		currentFrame: 0, currentTime: 0,
		AudioWorkletProcessor: class { constructor() { this.port = ports.shift(); } },
		registerProcessor(_name, value) { Processor = value; }
	});
	const load = context => {
		for (const path of ['emscripten/main.js', 'windowed-source.js', 'output-history.js', 'windowed-transport.js', 'web-wrapper.js']) {
			const url = new URL('../' + path, import.meta.url);
			runInContext(readFileSync(url, 'utf8'), context, {filename: fileURLToPath(url)});
		}
	};
	const main = createContext({Float32Array, ArrayBuffer, MessagePort, URL, Blob,
		AudioWorkletNode: class {
			constructor(_context, name, options) {
				assert.equal(name, 'signalsmith-stretch');
				if (!Processor) throw new Error('Processor is not registered');
				const {port1, port2} = new MessageChannel();
				ports.push(port1);
				this.port = port2;
				processors.push({processor: new Processor(options), port1, port2});
			}
		}
	});
	load(main);
	const context = {audioWorklet: {async addModule(url) { modules.push(url); load(worklet); }}};
	return {factory: main.SignalsmithStretch, context, modules, processors,
		close() { processors.forEach(({processor, port1, port2}) => {
			processor.windowedTransport?.close(); port1.close(); port2.close();
		}); modules.filter(url => url.startsWith('blob:')).forEach(url => URL.revokeObjectURL(url)); }
	};
}

test('factory registers lazily and native RPC transfers ownership, updates time, and rejects errors', async () => {
	const host = openContext();
	try {
		const node = await host.factory(host.context);
		assert.equal(host.modules.length, 1);
		assert.ok(host.modules[0].startsWith('blob:'));
		assert.equal(host.processors[0].processor.channels, 2);
		assert.ok(await node.latency() > 0);
		let observedTime;
		await node.setUpdateInterval(0.01, value => { observedTime = value; });
		const pcm = new Float32Array(480);
		assert.equal(await node.addBuffers([pcm], [pcm.buffer]), 0.01);
		assert.equal(pcm.byteLength, 0);
		await node.start({input: 0.125, output: 0});
		assert.equal(node.inputTime, 0.125);
		assert.equal(observedTime, 0.125);
		await assert.rejects(node.attachSource({sampleRate: 44100, channels: 2}), {name: 'RangeError'});
		assert.deepEqual(await node.dropBuffers(), {start: 0, end: 0});
		const second = await host.factory(host.context, {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]});
		assert.ok(await second.latency() > 0);
		assert.equal(host.modules.length, 1, 'registered contexts reuse their processor');
	} finally { host.close(); }
});

test('factory honors an explicit worklet module URL', async () => {
	const host = openContext();
	try {
		host.factory.moduleUrl = 'https://example.invalid/SignalsmithStretch.mjs';
		const node = await host.factory(host.context);
		assert.equal(host.modules[0], host.factory.moduleUrl);
		assert.ok(await node.latency() > 0);
	} finally { host.close(); }
});
