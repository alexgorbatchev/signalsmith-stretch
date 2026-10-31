// Buffer transport for one immutable source generation. All methods run in the
// AudioWorklet; the supplied MessagePort belongs to the source-fetching worker.
function createWindowedTransport(createSource, spec, port, createHistory) {
	const history = spec.outputHistory ? createHistory(spec.outputHistory) : null;
	const source = createSource(spec);
	spec = source.description;
	let state = {position: 0, rate: 1, semitones: 0, active: false, loop: null};
	let commands = [], lastCommandId = -1, status = 'paused', needKey = '', closed = false, lastObservation = -Infinity;
	let outputTimeline = [], presentedPosition = 0, sourceFailed = false, drain = null;
	let outputObserver = null;
	let historyObserver = null;
	const wrap = (position, loop) => loop
		? loop.start + ((position - loop.start) % (loop.end - loop.start) + loop.end - loop.start) % (loop.end - loop.start)
		: position;
	const outputPosition = frame => {
		while (outputTimeline.length > 1 && outputTimeline[1].frame <= frame) outputTimeline.shift();
		const segment = outputTimeline[0];
		return segment && segment.frame <= frame
			? wrap(segment.position + (frame - segment.frame) * segment.rate, segment.loop) : null;
	};
	const present = (frame, length, validFrom, segments) => {
		let validTo = length;
		let cursor = frame + validFrom;
		const end = frame + length;
		while (cursor < end) {
			const current = outputPosition(cursor);
			const segment = outputTimeline[0];
			const until = Math.min(end, outputTimeline[1]?.frame ?? end);
			if (!segment.loop && source.lengthFrames !== null && current + (until - cursor) * segment.rate >= source.lengthFrames) {
				validTo = Math.max(validFrom, Math.ceil(cursor - frame + (source.lengthFrames - current) / segment.rate));
				if (frame + validTo > cursor) segments.push({fromFrame: cursor, toFrame: frame + validTo,
					sourceFrame: current, rate: segment.rate, loop: null});
				presentedPosition = source.lengthFrames;
				break;
			}
			segments.push({fromFrame: cursor, toFrame: until, sourceFrame: current, rate: segment.rate,
				loop: segment.loop ? {...segment.loop} : null});
			cursor = until;
			presentedPosition = outputPosition(cursor);
		}
		return validTo;
	};
	const send = (type, data, transfer = []) => port.postMessage({type, generation: spec.generation, ...data}, transfer);
	const reject = (message, code) => send('rejected', {requestId: message.requestId, code});
	const validRequestId = value => typeof value === 'string' && value.length > 0 || Number.isSafeInteger(value);
	const replyHistory = (message, reply = history.read(message.fromFrame)) => {
		send('output-history', {requestId: message.requestId, ...reply}, [reply.records.buffer]);
	};
	const checkedCommand = message => {
		const command = message.command;
		if (!command || !Number.isSafeInteger(command.id) || command.id <= lastCommandId
			|| !Number.isSafeInteger(command.atFrame) || command.atFrame < 0 || commands.length >= 64) {
			throw new RangeError('Invalid command identity or schedule');
		}
		const next = {...(commands.at(-1)?.state || state), ...command};
		const limit = source.lengthFrames ?? source.provenFrames;
		if (!Number.isFinite(next.position) || (Object.hasOwn(command, "position") && (next.position < 0 || Math.ceil(next.position) > limit))
			|| !Number.isFinite(next.rate) || next.rate <= 0 || next.rate > 4
			|| !Number.isFinite(next.semitones) || Math.abs(next.semitones) > 48
			|| typeof next.active !== 'boolean'
			|| (next.loop !== null && (!Number.isFinite(next.loop?.start) || !Number.isFinite(next.loop?.end)
				|| next.loop.start < 0 || Math.ceil(next.loop.end) > limit || next.loop.end <= next.loop.start))
			|| (commands.length && command.atFrame < commands.at(-1).atFrame)) {
			throw new RangeError('Invalid transport state');
		}
		lastCommandId = command.id;
		commands.push({id: command.id, atFrame: command.atFrame, requestId: message.requestId, state: next,
			seek: Object.hasOwn(command, 'position')});
		send('queued', {requestId: message.requestId, commandId: command.id});
	};
	port.onmessage = event => {
		const message = event.data;
		if (closed || !message || message.generation !== spec.generation) {
			if (!closed) reject(message || {}, 'stale_generation');
			return;
		}
		try {
			if (message.type === 'window') {
				const receipt = source.add(message.generation, message.start, message.channels, message.endFrame);
				needKey = '';
				send('window-accepted', {requestId: message.requestId, ...receipt, lengthFrames: source.lengthFrames});
			} else if (message.type === 'eof') {
				const receipt = source.finish(message.generation, message.endFrame);
				needKey = '';
				send('eof-accepted', {requestId: message.requestId, ...receipt});
			} else if (message.type === 'drop') {
				const released = source.drop(message.generation, message.starts);
				send('released', {requestId: message.requestId, ...released.value, buffers: released.transfer}, released.transfer);
			} else if (message.type === 'command') {
				checkedCommand(message);
			} else if (message.type === 'read-failed') {
				sourceFailed = true;
				needKey = '';
				send('read-failed', {requestId: message.requestId, code: 'source_read_failed'});
			} else if (message.type === 'retry') {
				sourceFailed = false;
				needKey = '';
				send('retry-accepted', {requestId: message.requestId});
			} else if (message.type === 'observe-history') {
				if (!history || !validRequestId(message.requestId)) throw new RangeError('History unavailable or invalid request identity');
				const reply = history.read(message.fromFrame);
				if (historyObserver) reject(message, 'observation_pending');
				else if (message.fromFrame < history.renderedThroughFrame) replyHistory(message, reply);
				else {
					historyObserver = {requestId: message.requestId, fromFrame: message.fromFrame};
					send('history-queued', {requestId: message.requestId});
				}
			} else if (message.type === 'cancel-observe-history') {
				if (!validRequestId(message.requestId) || !historyObserver || historyObserver.requestId !== message.observationRequestId) throw new RangeError('Unknown history observation');
				reject(historyObserver, 'observation_cancelled');
				historyObserver = null;
				send('history-cancelled', {requestId: message.requestId});
			} else if (message.type === 'observe-output') {
				if (outputObserver) {
					reject(message, 'observation_pending');
				} else {
					outputObserver = {requestId: message.requestId};
					send('observation-queued', outputObserver);
				}
			} else {
				reject(message, 'unknown_message');
			}
		} catch (error) {
			reject(message, 'invalid_' + message.type);
		}
	};
	port.start();
	send('source-ready', {description: source.description});
	return {
		source,
		close(reason = 'detached') {
			closed = true;
			drain = null;
			outputTimeline = [];
			commands.forEach(command => reject(command, 'source_closed'));
			commands = [];
			if (outputObserver) reject(outputObserver, 'source_closed');
			outputObserver = null;
			if (historyObserver) reject(historyObserver, 'source_closed');
			historyObserver = null;
			const released = source.drop(spec.generation, source.starts());
			send('source-closed', {reason, buffers: released.transfer}, released.transfer);
			port.close();
		},
		render(frame, output, input, wasm, inputLatency, outputLatency) {
			if (closed) return;
			const applied = [];
			while (commands.length && commands[0].atFrame <= frame) {
				const command = commands.shift();
				const position = command.seek ? command.state.position
					: !command.state.active ? presentedPosition : state.position;
				state = {...command.state, position};
				if (command.seek || !state.active) {
					wasm._reset();
					outputTimeline = [];
					drain = null;
					presentedPosition = position;
				}
				applied.push(command);
			}
			const loop = state.loop;
			const position = wrap(state.position, loop);
			const active = state.active && (loop || source.lengthFrames === null || presentedPosition < source.lengthFrames);
			const missing = active && !drain ? source.read(position + inputLatency - input[0].length, input, loop) : null;
			let nextStatus = !active ? 'paused' : missing ? sourceFailed ? 'source-error' : 'underrun' : 'preparing';
			const silenceStatus = !active ? 'paused' : missing || drain ? sourceFailed ? 'source-error' : 'underrun' : 'preparing';
			let validFrom = output[0].length;
			let validTo = output[0].length;
			let sourceFrame = null;
			let outputRate = null;
			const outputSegments = [];
			let samples = null, processed = false;
			// An interrupted preparation has no valid native tail yet: flushing
			// it would label unprimed zeros as source progress. Only drain DSP
			// history after this generation has reached audible output.
			if (missing && !drain && outputTimeline.length && status === 'playing') {
				// Flush once: the native flush resets DSP history after exporting its tail.
				wasm._flush(outputLatency);
				const memory = wasm.exports ? wasm.exports.memory.buffer : wasm.HEAP8.buffer;
				const base = input[0].byteOffset + input[0].length * spec.channels * 4;
				drain = {offset: 0, channels: Array.from({length: spec.channels}, (_, channel) =>
					new Float32Array(new Float32Array(memory, base + input[0].length * channel * 4, outputLatency)))};
			}
			if (active && drain) {
				const count = Math.min(output[0].length, outputLatency - drain.offset);
				samples = output;
				output.forEach((channel, index) => {
					channel.fill(0);
					channel.set(drain.channels[index].subarray(drain.offset, drain.offset + count));
				});
				validFrom = Math.max(0, Math.min(count, outputTimeline[0].frame - frame));
				sourceFrame = validFrom < count ? outputPosition(frame + validFrom) : null;
				outputRate = sourceFrame === null ? null : outputTimeline[0].rate;
				validTo = present(frame, count, validFrom, outputSegments);
				nextStatus = "draining";
				drain.offset += count;
				if (drain.offset === outputLatency) {
					drain = null;
					outputTimeline = [];
					state.position = presentedPosition;
				}
			} else if (!active || missing) {
				output.forEach(channel => channel.fill(0));
				if (status === 'playing' || status === 'preparing') wasm._reset();
				state.position = presentedPosition;
				outputTimeline = [];
			} else {
				wasm._setTransposeSemitones(state.semitones, 8000 / spec.sampleRate);
				wasm._seek(input[0].length, state.rate);
				wasm._process(0, output[0].length);
				processed = true;
				outputTimeline.push({frame: frame + outputLatency, position, rate: state.rate, loop});
				validFrom = Math.max(0, Math.min(output[0].length, outputTimeline[0].frame - frame));
				sourceFrame = validFrom < output[0].length ? outputPosition(frame + validFrom) : null;
				outputRate = sourceFrame === null ? null : outputTimeline[0].rate;
				if (validFrom < output[0].length) {
					nextStatus = 'playing';
					validTo = present(frame, output[0].length, validFrom, outputSegments);
				}
				state.position = position + output[0].length * state.rate;
			}
			// Leave room for a complete incoming page as well as mandatory
			// analysis history. Filling the entire remaining horizon causes
			// distant speculative pages to repeatedly evict imminent input.
			const needed = missing || (active ? source.missing(position + inputLatency,
				Math.max(1, Math.min(spec.sampleRate, Math.floor((spec.capacityFrames - input[0].length - 2) / 2))), loop) : null);
			if (needed && !sourceFailed) {
				const key = needed.start + ':' + needed.end;
				if (!needKey) {
					needKey = key;
					send('need', {range: needed, renderFrame: frame, processingSourceFrame: position,
						required: Boolean(missing), retain: source.ranges(position + inputLatency - input[0].length, input[0].length + 1, loop)});
				}
			}
			const observation = {renderFrame: frame, renderedThroughFrame: frame + output[0].length,
				validFrom, validTo, sourceFrame, nextSourceFrame: presentedPosition,
				processingSourceFrame: position,
				acceptedRate: state.rate, acceptedSemitones: state.semitones, acceptedLoop: loop,
				outputRate, outputSegments,
				active: state.active, status: nextStatus, lengthFrames: source.lengthFrames,
				ended: Boolean(state.active && !loop && source.lengthFrames !== null && presentedPosition >= source.lengthFrames),
				inputLatencyFrames: inputLatency, outputLatencyFrames: outputLatency};
			history?.append(observation, silenceStatus);
			if (historyObserver) {
				replyHistory(historyObserver);
				historyObserver = null;
			}
			if (outputObserver) {
				send('output-observation', {...outputObserver, ...observation});
				outputObserver = null;
			}
			applied.forEach((command, index) => send('applied', {requestId: command.requestId, commandId: command.id,
				superseded: index < applied.length - 1,
				effectiveOutputFrame: index < applied.length - 1 ? null
					: !command.state.active ? frame : processed ? frame + outputLatency : null, ...observation}));
			if (nextStatus !== status || applied.length || frame - lastObservation >= spec.sampleRate / 10) {
				send('state', observation);
				lastObservation = frame;
			}
			status = nextStatus;
			return samples || (active && !missing) ? {validFrom, validTo, observation, samples} : null;
		}
	};
}
