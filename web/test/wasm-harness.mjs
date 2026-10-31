import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {runInThisContext} from 'node:vm';
import {MessageChannel} from 'node:worker_threads';

const moduleFactory = runInThisContext(readFileSync(new URL('../emscripten/main.js', import.meta.url), 'utf8') + '\nSignalsmithStretch', {filename: fileURLToPath(new URL("../emscripten/main.js", import.meta.url))});
const createSource = runInThisContext(readFileSync(new URL('../windowed-source.js', import.meta.url), 'utf8') + '\ncreateWindowedSource', {filename: fileURLToPath(new URL("../windowed-source.js", import.meta.url))});
const createTransport = runInThisContext(readFileSync(new URL('../windowed-transport.js', import.meta.url), 'utf8') + '\ncreateWindowedTransport', {filename: fileURLToPath(new URL("../windowed-transport.js", import.meta.url))});

export async function openHarness(spec) {
	const wasm = await moduleFactory();
	wasm._main();
	wasm._presetDefault(spec.channels, spec.sampleRate);
	const history = wasm._inputLatency() + wasm._outputLatency();
	const pointer = wasm._setBuffers(spec.channels, history);
	const memory = () => wasm.exports ? wasm.exports.memory.buffer : wasm.HEAP8.buffer;
	const input = Array.from({length: spec.channels}, (_, channel) => new Float32Array(memory(), pointer + history * channel * 4, history));
	const {port1, port2} = new MessageChannel();
	const messages = [], waits = [];
	port2.on('message', message => {
		messages.push(message);
		for (const wait of waits.splice(0)) {
			if (wait.match(message)) wait.resolve(message);
			else waits.push(wait);
		}
	});
	let transport;
	try {
		transport = createTransport(createSource, spec, port1);
	} catch (error) {
		port1.close();
		port2.close();
		throw error;
	}
	let request = 0, frame = 0, lastRender = null;
	const wait = match => new Promise(resolve => waits.push({match, resolve}));
	return {
		wasm, messages, transport, input, history,
		get lastRender() { return lastRender; },
		get frame() { return frame; },
		async send(type, data, reply, transfer = []) {
			const requestId = ++request;
			const response = wait(message => message.requestId === requestId && (message.type === reply || message.type === "rejected"));
			port2.postMessage({type, generation: spec.generation, requestId, ...data}, transfer);
			const result = await response;
			if (result.type === "rejected") throw new Error(result.code);
			return result;
		},
		render() {
			const output = Array.from({length: spec.channels}, () => new Float32Array(128));
			const rendered = transport.render(frame, output, input, wasm, wasm._inputLatency(), wasm._outputLatency());
			lastRender = rendered;
			if (rendered) output.forEach((channel, index) => {
				channel.set(rendered.samples ? rendered.samples[index] : new Float32Array(memory(), pointer + history * (index + spec.channels) * 4, 128));
				channel.fill(0, 0, rendered.validFrom);
				channel.fill(0, rendered.validTo);
			});
			frame += 128;
			return output;
		},
		async flush() {
			const requestId = ++request;
			const response = wait(message => message.type === "harness-barrier" && message.requestId === requestId);
			port1.postMessage({type: "harness-barrier", requestId});
			await response;
		},
		wait,
		close() { transport.close(); port2.close(); }
	};
}
