// Included in both release formats and serialized into the AudioWorklet module.
function createWindowedSource(spec) {
	const integer = value => Number.isSafeInteger(value) && value >= 0;
	if (!spec || typeof spec.generation !== 'string' || !spec.generation.length
		|| !integer(spec.lengthFrames) || !spec.lengthFrames
		|| !integer(spec.capacityFrames) || !spec.capacityFrames
		|| !Number.isInteger(spec.channels) || spec.channels < 1 || spec.channels > 32
		|| !Number.isFinite(spec.sampleRate) || spec.sampleRate <= 0) {
		throw new RangeError('Invalid source specification');
	}
	const description = Object.freeze({...spec});
	let windows = [], residentFrames = 0;
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
		ranges(start, length, loop = null) {
			if (loop && length >= loop.end - loop.start) return [{start: Math.floor(loop.start), end: Math.ceil(loop.end)}];
			start = wrap(start, loop);
			const end = Math.min(start + length, loop ? loop.end : description.lengthFrames);
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
				const boundary = Math.min(description.lengthFrames, loop ? loop.end : description.lengthFrames);
				if (position < 0) {
					const count = Math.min(remaining, -position);
					remaining -= count;
					start += count;
					continue;
				}
				if (frame >= description.lengthFrames) return null;
				const window = find(frame);
				if (!window) {
					const next = windows.find(candidate => candidate.start > frame);
					// The horizon decides whether to request a page, not its size.
					// A tiny advancing horizon otherwise creates one PCM window per
					// quantum. Never extend through an already owned window.
					return {start: frame, end: Math.min(Math.ceil(boundary),
						next ? next.start : description.lengthFrames, frame + Math.max(1, Math.floor(description.capacityFrames / 2)))};
				}
				const count = Math.min(remaining, window.end - position, boundary - position);
				remaining -= count;
				start += count;
			}
			return null;
		},
		add(generation, start, channels) {
			if (generation !== description.generation) throw new RangeError('Stale source generation');
			if (!integer(start) || !Array.isArray(channels) || channels.length !== description.channels
				|| !channels.every(channel => channel instanceof Float32Array && channel.length === channels[0].length
					&& channel.buffer instanceof ArrayBuffer && channel.byteOffset === 0 && channel.byteLength === channel.buffer.byteLength)
				|| !channels[0].length || start + channels[0].length > description.lengthFrames) {
				throw new RangeError('Invalid PCM window');
			}
			const length = channels[0].length, end = start + length;
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
					|| loop.start < 0 || loop.end > description.lengthFrames || loop.end <= loop.start))) {
				throw new RangeError('Invalid analysis range');
			}
			let missingStart = null;
			for (let index = 0; index < output[0].length; ++index) {
				const position = wrap(start + index, loop);
				const first = Math.floor(position), fraction = position - first;
				const second = Math.floor(wrap(first + 1, loop));
				const left = first >= 0 && first < description.lengthFrames ? find(first) : null;
				const right = fraction && second >= 0 && second < description.lengthFrames ? find(second) : null;
				if ((!left && first >= 0 && first < description.lengthFrames)
					|| (fraction && !right && second >= 0 && second < description.lengthFrames)) {
					if (missingStart === null) missingStart = !left && first >= 0 && first < description.lengthFrames ? first : second;
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
					next ? next.start : description.lengthFrames, description.lengthFrames)};
			}
			return null;
		}
	};
}
