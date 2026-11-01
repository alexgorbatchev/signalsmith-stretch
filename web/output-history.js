// Fixed numeric storage; only freshly copied reply buffers cross the port.
function createOutputHistory(options) {
	const {maxFrames, maxRecords, maxReplyRecords} = options || {};
	if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 0xffffffff
		|| !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 4096
		|| !Number.isSafeInteger(maxReplyRecords) || maxReplyRecords < 1 || maxReplyRecords > Math.min(256, maxRecords)) {
		throw new RangeError('Invalid output history bounds');
	}
	const ring = new Float64Array(maxRecords * 8);
	let head = 0, count = 0, start = null, through = null;
	const at = index => ((head + index) % maxRecords) * 8;
	const clip = (record, frame) => {
		if (Number.isFinite(record[2])) {
			record[2] += (frame - record[0]) * record[3];
			if (Number.isFinite(record[4])) {
				const length = record[5] - record[4];
				record[2] = record[4] + ((record[2] - record[4]) % length + length) % length;
			}
		}
		record[0] = frame;
	};
	const append = record => {
		if (count === maxRecords) { head = (head + 1) % maxRecords; count--; }
		ring.set(record, at(count++));
		const cutoff = record[1] - maxFrames;
		while (count && ring[at(0) + 1] <= cutoff) { head = (head + 1) % maxRecords; count--; }
		if (count && ring[at(0)] < cutoff) clip(ring.subarray(at(0), at(0) + 8), cutoff);
	};
	return {
		get renderedThroughFrame() { return through; },
		append(observation, silenceStatus = observation.status) {
			const {renderFrame, renderedThroughFrame, outputSegments, status, ended} = observation;
			if (through !== null && renderFrame < through) throw new RangeError('Overlapping rendered output');
			// Retain one truthful contiguous suffix. A native frame gap is not
			// observed silence; existing truncation metadata exposes its absence.
			if (through !== null && renderFrame > through) head = count = 0;
			start ??= renderFrame;
			let cursor = renderFrame;
			const silence = end => {
				if (end <= cursor) return;
				const code = ended && end === renderedThroughFrame && cursor >= (outputSegments.at(-1)?.toFrame ?? renderFrame)
					? 6 : silenceStatus === 'source-error' ? 5 : silenceStatus === 'underrun' ? 4 : silenceStatus === 'paused' ? 2 : 3;
				append([cursor, end, NaN, NaN, NaN, NaN, code, code === 6 ? 1 : 0]);
				cursor = end;
			};
			for (const segment of outputSegments) {
				silence(segment.fromFrame);
				append([segment.fromFrame, segment.toFrame, segment.sourceFrame, segment.rate,
					segment.loop?.start ?? NaN, segment.loop?.end ?? NaN, status === 'draining' ? 1 : 0, 0]);
				cursor = segment.toFrame;
			}
			silence(renderedThroughFrame);
			through = renderedThroughFrame;
		},
		read(fromFrame) {
			if (!Number.isSafeInteger(fromFrame) || fromFrame < 0 || fromFrame > (through ?? 0)) {
				throw new RangeError('Invalid output history request');
			}
			const oldest = count ? ring[at(0)] : null;
			let first = 0;
			while (first < count && ring[at(first) + 1] <= fromFrame) first++;
			const records = new Float64Array(Math.min(count - first, maxReplyRecords) * 8);
			let copied = 0;
			for (let index = first; index < count && copied < maxReplyRecords; index++) {
				const offset = at(index);
				const record = records.subarray(copied * 8, ++copied * 8);
				record.set(ring.subarray(offset, offset + 8));
				if (record[0] < fromFrame) clip(record, fromFrame);
			}
			return {fromFrame, generationStartFrame: start, oldestRetainedFrame: oldest, renderedThroughFrame: through,
				returnedThroughFrame: copied ? records[(copied - 1) * 8 + 1] : start !== null && fromFrame >= start ? fromFrame : null,
				preGenerationThroughFrame: start !== null && fromFrame < start ? start : null,
				truncatedBeforeFrame: oldest !== null && oldest > Math.max(fromFrame, start) ? oldest : null,
				records};
		}
	};
}

function decodeOutputHistory(message) {
	const integer = value => Number.isSafeInteger(value) && value >= 0;
	const {fromFrame, generationStartFrame: start, oldestRetainedFrame: oldest,
		renderedThroughFrame: through, returnedThroughFrame: returned, records} = message || {};
	let backingBytes, viewBytes, viewOffset;
	try {
		const prototype = Object.getPrototypeOf(Float64Array.prototype);
		const buffer = Object.getOwnPropertyDescriptor(prototype, 'buffer').get.call(records);
		viewBytes = Object.getOwnPropertyDescriptor(prototype, 'byteLength').get.call(records);
		viewOffset = Object.getOwnPropertyDescriptor(prototype, 'byteOffset').get.call(records);
		backingBytes = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(buffer);
	} catch {
		throw new RangeError('Invalid output history backing buffer');
	}
	if (viewOffset !== 0 || backingBytes !== viewBytes || viewBytes > 256 * 8 * 8 || viewBytes % (8 * 8)) {
		throw new RangeError('Invalid output history backing buffer');
	}
	const length = viewBytes / 8;
	if (!integer(fromFrame) || !(records instanceof Float64Array)
		|| (start === null ? fromFrame !== 0 || oldest !== null || through !== null || returned !== null || length
			: !integer(start) || !integer(oldest) || !integer(through) || oldest < start || oldest >= through
				|| fromFrame > through || (returned !== null && (!integer(returned) || returned > through || returned < fromFrame)))
		|| message.preGenerationThroughFrame !== (start !== null && fromFrame < start ? start : null)
		|| message.truncatedBeforeFrame !== (oldest !== null && oldest > Math.max(fromFrame, start) ? oldest : null)) {
		throw new RangeError('Invalid output history envelope');
	}
	if (start !== null && !length && fromFrame !== through) throw new RangeError('Missing output history coverage');
	const result = [];
	let cursor = start === null ? null : Math.max(fromFrame, oldest);
	for (let offset = 0; offset < length; offset += 8) {
		const from = records[offset], to = records[offset + 1], position = records[offset + 2], rate = records[offset + 3];
		const loopStart = records[offset + 4], loopEnd = records[offset + 5], status = records[offset + 6], ended = records[offset + 7];
		const validSource = status === 0 || status === 1;
		if (!integer(from) || !integer(to) || from !== cursor || to <= from || to > through
			|| !Number.isInteger(status) || status < 0 || status > 6 || ended !== (status === 6 ? 1 : 0)
			|| (validSource ? !Number.isFinite(position) || position < 0 || !Number.isFinite(rate) || rate <= 0 || rate > 4
				|| !(Number.isNaN(loopStart) && Number.isNaN(loopEnd) || Number.isFinite(loopStart) && loopStart >= 0
					&& Number.isFinite(loopEnd) && loopEnd > loopStart && position >= loopStart && position < loopEnd)
				: ![position, rate, loopStart, loopEnd].every(Number.isNaN))) throw new RangeError('Invalid output history record');
		result.push({fromFrame: from, toFrame: to, sourceFrame: validSource ? position : null, rate: validSource ? rate : null,
			loop: Number.isNaN(loopStart) ? null : {start: loopStart, end: loopEnd},
			status: ['playing', 'draining', 'paused', 'preparing', 'underrun', 'source-error', 'ended'][status], ended: Boolean(ended)});
		cursor = to;
	}
	if (returned !== (result.length ? cursor : start !== null && fromFrame >= start ? fromFrame : null)) {
		throw new RangeError('Invalid output history watermark');
	}
	return result;
}
