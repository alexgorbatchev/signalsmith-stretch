# Windowed buffer transport

`attachSource(spec, port, [port])` selects a source-generation-specific buffer
transport. `detachSource()` releases its owned PCM, rejects queued controls and
closes the port. Existing live-input and append-only buffer methods remain
available when no windowed source is attached.

DSP configuration is immutable while a source is attached: `configure()` rejects
with `InvalidStateError` before changing configuration or buffers. Detach before
reconfiguring, then attach a compatible generation. If the host changes output
channel count, the worklet closes the attached generation with
`reason: "output_channels_changed"`, releases its PCM, reconfigures, and emits
silence for that quantum. The consumer must explicitly attach a matching source.

The source specification contains `generation` (nonempty string), `sampleRate`,
`channels`, `lengthFrames` and `capacityFrames`. Frames are source-sample frames,
not interleaved samples or seconds. Source and AudioContext rates/channel counts
must match. The capacity must hold at least the configured analysis history plus
two frames. The worklet holds at most 256 nonoverlapping windows and at most
`capacityFrames * channels * 4` PCM bytes. The source can be larger than memory.
The configured WASM analysis/output buffers are additional bounded DSP storage.
During starvation, a single pending output tail additionally holds at most
`outputLatencyFrames * channels * 4` bytes until drained.

The supplied `MessagePort` connects directly to a source-fetching worker. Its
messages carry the source's `generation` and a caller-owned `requestId`.

| Worker message | Fields | Worklet response |
| --- | --- | --- |
| `window` | `start`, planar `channels: Float32Array[]` | `window-accepted` with owned range and residency |
| `drop` | `starts: number[]` | `released` with transferred buffers |
| `command` | `command` | `queued`, then `applied` at a render quantum |
| `read-failed` | none | `read-failed` with `source_read_failed` |
| `retry` | none | `retry-accepted` |

Transfer every channel's whole `ArrayBuffer` when sending a window. Subarray
backing storage, shared buffers, non-finite samples, overlapping ranges, stale
generations and capacity overflow are rejected. Release windows before replacing
their ranges. Returned buffers can be reused by the worker. Decoded data,
in-flight transfers and the worker's own fetch/decode buffers require a separate
worker-side budget.

The worklet emits `need` with a bounded `range`, the current analysis `retain`
ranges and `required`. At most one request remains outstanding until a window
arrives or the worker reports failure. A worker must preserve `retain`, bound its
decode/read concurrency and release other windows before admitting replacements.
`retain` is the mandatory analysis minimum, not an instruction to discard all
other pages: keep useful future pages until capacity pressure requires eviction.
The speculative horizon uses half of the capacity remaining after analysis
history. A missing page may extend beyond that horizon, bounded by half the source
capacity, the next admitted window and the source/loop boundary. This leaves room
for incoming pages without repeatedly replacing imminent audio with distant
prefetch. Workers may supply a smaller contiguous prefix of the requested gap;
they must not extend it through an admitted window. Account for resident and
in-flight buffers together before allocating or transferring the next page.
An outstanding speculative request still requires a response or explicit failure;
silently declining it prevents subsequent mandatory requests from progressing.
The worklet does not fetch URLs, decode media or retain the full source. On an
unfulfilled required range it stops processing new input and calls the native
DSP flush once. The resulting bounded pending output continues in `draining`
state, with its original delayed source/rate mapping, for no more than the
configured output latency. Then the last valid emitted source boundary freezes
and output is silent. Recovery reprimes from that boundary after the tail drains;
new PCM arriving during the drain does not mix new processing into the old tail.
A seek or pause deliberately discards any pending tail immediately. Explicit
retry permits another request after a confirmed failure.
If input disappears during preparation before valid output begins, discard that
unprimed DSP history and preserve the frozen source boundary. It has no valid tail
to drain; native flush silence must not be reported as consumed source audio.

A command contains increasing integer `id`, nonnegative integer `atFrame` in
AudioContext frames, and any of `position`, `active`, `rate`, `semitones`, `loop`.
`position` and loop `start`/`end` use source frames and permit fractional values.
`loop: null` exits looping. Rate must be positive and no greater than 4;
semitones must be finite and within -48 to 48. Queued commands must have
nondecreasing `atFrame`; at most 64 can be queued. Invalid input receives
`rejected` without changing the accepted state.

`applied` acknowledges the processing quantum and accepted settings. Its
`effectiveOutputFrame` is the current render frame for a pause's immediate output
cut. For active controls it maps the processing quantum through DSP output latency
only when that quantum processes new input. It is `null` during missing-input or
drain quanta, which establish no new output boundary. Subsequent `state` messages
observe actual prepared output after recovery. Commands overtaken by another due
command in the same quantum have `superseded: true` and a null effective frame;
their observation describes the quantum's final accepted state. Spectral
automation has a finite analysis window; an effective frame is not an
instantaneous hard pitch/rate switch. Discontinuous seeks reset and reprime the
DSP; no old-source output is presented during preparation. Continuous loops and
rate changes retain DSP history.

`state` distinguishes `processingSourceFrame`, `acceptedRate`, and
`acceptedSemitones` from the output's `sourceFrame`, `outputRate`, `validFrom` and
`validTo`. An unavailable `sourceFrame` is `null`. `nextSourceFrame` is the last
valid emitted source boundary and advances only while valid output is emitted,
including a pending tail; it freezes after that tail. Positions
wrap inside the accepted loop, including analysis pre/post-roll across either
boundary and multiple wraps per quantum. Natural end clips against each delayed
output segment's own rate and loop, rather than current processing settings, and
masks output after the source boundary.

Output frames refer to the AudioContext render stream, not the physical device.
Device-clock mapping belongs to the consumer's `AudioContext.getOutputTimestamp()`
observation. A suspended/interrupted context does not render; the port cannot
acknowledge a command before rendering resumes. Browser output and lifecycle
qualification are distinct from the embedded-WASM Node tests.
