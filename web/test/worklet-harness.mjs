import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, runInContext} from 'node:vm';
import {MessageChannel, MessagePort} from 'node:worker_threads';

// Host only the AudioWorklet class/registration API. DSP, ports, and RPC dispatch
// are the real published wrapper and embedded WASM, not substitute algorithms.
export async function openProcessor() {
	const {port1, port2} = new MessageChannel();
	let Processor;
	const context = createContext({
		Float32Array, ArrayBuffer, MessagePort, sampleRate: 48000, currentFrame: 0, currentTime: 0,
		AudioWorkletProcessor: class { constructor() { this.port = port1; } },
		registerProcessor(_name, value) { Processor = value; }
	});
	for (const path of ['emscripten/main.js', 'windowed-source.js', 'windowed-transport.js', 'web-wrapper.js']) {
		const url = new URL('../' + path, import.meta.url);
		runInContext(readFileSync(url, 'utf8'), context, {filename: fileURLToPath(url)});
	}
	const ready = new Promise(resolve => port2.once('message', resolve));
	const processor = new Processor({numberOfOutputs: 1, outputChannelCount: [1]});
	assert.equal((await ready)[0], 'ready');
	let id = 0;
	return {
		processor, context,
		advance() { context.currentFrame += 128; context.currentTime = context.currentFrame / 48000; },
		async call(method, args = [], transfer = []) {
			const request = ++id;
			const response = new Promise(resolve => {
				const onMessage = message => { if (message[0] === request) { port2.off('message', onMessage); resolve(message); } };
				port2.on('message', onMessage);
			});
			port2.postMessage([request, method, ...args], transfer);
			const result = await response;
			assert.equal(result[0], request);
			if (result[2]) throw Object.assign(new Error(result[2].message), {name: result[2].name});
			return result[1];
		},
		close() { processor.windowedTransport?.close(); port1.close(); port2.close(); }
	};
}
