// Included in both release formats and serialized into the AudioWorklet module.
function createWindowedSource(spec) {
	const integer = value => Number.isSafeInteger(value) && value >= 0;
	if (!spec || typeof spec.generation !== 'string' || !spec.generation.length
		|| (spec.lengthFrames !== null && (!integer(spec.lengthFrames) || !spec.lengthFrames))
		|| !integer(spec.capacityFrames) || !spec.capacityFrames
		|| !Number.isInteger(spec.channels) || spec.channels < 1 || spec.channels > 32
		|| !Number.isFinite(spec.sampleRate) || spec.sampleRate <= 0) {
		throw new RangeError('Invalid source specification');
	}
	const description = Object.freeze({...spec});
	let windows = [], residentFrames = 0, lengthFrames = spec.lengthFrames, provenFrames = 0;
	const checkedEnd = (generation, endFrame, minimum = provenFrames) => {
		if (generation !== description.generation) throw new RangeError("Stale source generation");
		if (!integer(endFrame) || endFrame < minimum || (lengthFrames !== null && endFrame !== lengthFrames)) {
			throw new RangeError("Conflicting source EOF");
		}
	};
	const within = frame => frame >= 0 && (lengthFrames === null || frame < lengthFrames);
	const wrap = (frame, loop) => loop
		? loop.start + ((frame - loop.start) % (loop.end - loop.start) + loop.end - loop.start) % (loop.end - loop.start)
		: frame;
	const find = frame => {
		let low = 0, high = windows.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (windows[middle].start <= frame) low = middle + 1;
			else high = middle;
		}
		const window = windows[low - 1];
		return window && frame < window.end ? window : null;
	};
	return {
		description,
		starts() { return windows.map(window => window.start); },
		get residentFrames() { return residentFrames; },
		get lengthFrames() { return lengthFrames; },
		get provenFrames() { return provenFrames; },
		finish(generation, endFrame) {
			checkedEnd(generation, endFrame);
			lengthFrames = endFrame;
			return {lengthFrames};
		},
		ranges(start, length, loop = null) {
			if (loop && length >= loop.end - loop.start) return [{start: Math.floor(loop.start), end: Math.ceil(loop.end)}];
			start = wrap(start, loop);
			const end = Math.min(start + length, loop ? loop.end : lengthFrames ?? start + length);
			const ranges = [{start: Math.max(0, Math.floor(start)), end: Math.max(0, Math.ceil(end))}];
			if (loop && start + length > loop.end) ranges.push({start: Math.floor(loop.start), end: Math.ceil(loop.start + start + length - loop.end)});
			return ranges.filter(range => range.end > range.start);
		},
		missing(start, length, loop = null) {
			// Prefetch only a bounded contiguous range. The worker may round it to
			// its decode page size; no request spans a large loop's head and tail.
			if (loop && length >= loop.end - loop.start) {
				start = loop.start;
				length = loop.end - loop.start;
			}
			let remaining = length;
			while (remaining > 0) {
				const position = wrap(start, loop);
				const frame = Math.floor(position);
				const boundary = loop ? loop.end : lengthFrames ?? position + Math.max(1, Math.floor(description.capacityFrames / 2));
				if (position < 0) {
					const count = Math.min(remaining, -position);
					remaining -= count;
					start += count;
					continue;
				}
				if (lengthFrames !== null && frame >= lengthFrames) return null;
				const window = find(frame);
				if (!window) {
					const next = windows.find(candidate => candidate.start > frame);
					// The horizon decides whether to request a page, not its size.
					// A tiny advancing horizon otherwise creates one PCM window per
					// quantum. Never extend through an already owned window.
					return {start: frame, end: Math.min(Math.ceil(boundary),
						next ? next.start : boundary, frame + Math.max(1, Math.floor(description.capacityFrames / 2)))};
				}
				const count = Math.min(remaining, window.end - position, boundary - position);
				remaining -= count;
				start += count;
			}
			return null;
		},
		add(generation, start, channels, endFrame) {
			if (generation !== description.generation) throw new RangeError('Stale source generation');
			if (!integer(start) || !Array.isArray(channels) || channels.length !== description.channels
				|| !channels.every(channel => channel instanceof Float32Array && channel.length === channels[0].length
					&& channel.buffer instanceof ArrayBuffer && channel.byteOffset === 0 && channel.byteLength === channel.buffer.byteLength)
				|| !channels[0].length || !integer(start + channels[0].length)
				|| (lengthFrames !== null && start + channels[0].length > lengthFrames)) {
				throw new RangeError('Invalid PCM window');
			}
			const length = channels[0].length, end = start + length;
			if (endFrame !== undefined) {
				checkedEnd(generation, endFrame, Math.max(provenFrames, end));
				if (endFrame !== end) throw new RangeError("Final PCM window must end at EOF");
			}
			if (windows.length >= 256 || residentFrames + length > description.capacityFrames) {
				throw new RangeError('PCM capacity exceeded');
			}
			if (windows.some(window => start < window.end && end > window.start)) {
				throw new RangeError('Overlapping PCM window');
			}
			if (!channels.every(channel => channel.every(Number.isFinite))) throw new RangeError('Non-finite PCM');
			windows.push({start, end, channels});
			windows.sort((a, b) => a.start - b.start);
			residentFrames += length;
			provenFrames = Math.max(provenFrames, end);
			if (endFrame !== undefined) lengthFrames = endFrame;
			return {generation, start, end, residentFrames};
		},
		drop(generation, starts) {
			if (generation !== description.generation) throw new RangeError('Stale source generation');
			if (!Array.isArray(starts) || !starts.every(integer)) throw new RangeError('Invalid window release');
			const transfer = [];
			windows = windows.filter(window => {
				if (!starts.includes(window.start)) return true;
				residentFrames -= window.end - window.start;
				window.channels.forEach(channel => transfer.push(channel.buffer));
				return false;
			});
			return {value: {generation, residentFrames}, transfer: [...new Set(transfer)]};
		},
		read(start, output, loop = null) {
			if (!Number.isFinite(start) || output.length !== description.channels
				|| !output.every(channel => channel instanceof Float32Array && channel.length === output[0].length)
				|| (loop && (!Number.isFinite(loop.start) || !Number.isFinite(loop.end)
					|| loop.start < 0 || Math.ceil(loop.end) > (lengthFrames ?? provenFrames) || loop.end <= loop.start))) {
				throw new RangeError('Invalid analysis range');
			}
			let missingStart = null;
			for (let index = 0; index < output[0].length; ++index) {
				const position = wrap(start + index, loop);
				const first = Math.floor(position), fraction = position - first;
				const second = Math.floor(wrap(first + 1, loop));
				const left = within(first) ? find(first) : null;
				const right = fraction && within(second) ? find(second) : null;
				if ((!left && within(first))
					|| (fraction && !right && within(second))) {
					if (missingStart === null) missingStart = !left && within(first) ? first : second;
				}
				for (let channel = 0; channel < output.length; ++channel) {
					const a = left ? left.channels[channel][first - left.start] : 0;
					const b = right ? right.channels[channel][second - right.start] : 0;
					output[channel][index] = a + fraction * (b - a);
				}
			}
			if (missingStart !== null) {
				output.forEach(channel => channel.fill(0));
				const next = windows.find(window => window.start > missingStart);
				return {start: missingStart, end: Math.min(missingStart + output[0].length + 2,
					next ? next.start : missingStart + output[0].length + 2, lengthFrames ?? missingStart + output[0].length + 2)};
			}
			return null;
		}
	};
}
