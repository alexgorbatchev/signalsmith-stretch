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

Each generation represents a finite, immutable decoded media source, not an
appendable live stream. `lengthFrames` is either its exact positive integer PCM
length or `null` when the source owner has not established that length. The
initial specification remains immutable. Learned EOF is separate generation
state; observations and acceptance messages expose the effective `lengthFrames`.
Do not substitute an estimated duration, timestamp-derived approximation, or
sentinel length for an unknown end.

The supplied `MessagePort` connects directly to a source-fetching worker. Its
messages carry the source's `generation` and a caller-owned `requestId`.

| Worker message | Fields | Worklet response |
| --- | --- | --- |
| `window` | `start`, planar `channels: Float32Array[]`, optional `endFrame` | `window-accepted` with owned range, residency and effective `lengthFrames` |
| `eof` | exact exclusive `endFrame` | `eof-accepted` with exact `lengthFrames` |
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

The source owner establishes authoritative EOF. Send `endFrame` atomically with
the final nonempty PCM window; it must equal that window's exclusive end. Use
`eof` when no final PCM accompanies the observation, including an empty source
with `endFrame: 0`. EOF must be a nonnegative safe integer at least as large as
every accepted PCM window's end, including windows since released. Repeating the
same EOF is accepted; a conflicting EOF or stale generation is rejected. All
final-window PCM and EOF validation completes before either is admitted. Learning
EOF does not reset DSP history or discard delayed output.

Until EOF is known, absent samples at nonnegative source positions are missing
input, never end padding. Only an exact known end permits zero padding after
that end. An unknown source retains a scalar decoded-frame proof equal to the
greatest accepted window end, independent of eviction. Explicit seeks require
`ceil(position)` no greater than that proof; loops require `ceil(loop.end)` no
greater than it. Prime an endpoint window before submitting a distant seek or
loop. This proves the endpoint without retaining the entire intervening source.
Once EOF is known, these bounds use the exact length instead. Endpoint evidence
does not promise residency: missing loop interiors still require worker reads.

EOF also retires the outstanding need, and later requests are bounded by the
learned end. A speculative request may extend beyond that end; the worker must
retire its corresponding in-flight work and must not submit out-of-range PCM.
If a real underrun precedes EOF delivery, the normal drain/recovery rules apply.
The protocol does not establish decoder sample indexing: the source owner must
prove that each window's `start` and EOF share one exact absolute PCM lattice.
An empty random-seek response or `seek start + returned samples` is not sufficient
without that proof. The wrapper neither decodes files nor guarantees a decoder's
format, timestamp, resampling or priming behavior.

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
including a pending tail; it freezes after that tail.
Processing positions wrap inside the accepted loop, including analysis pre/post-roll
across either boundary and multiple wraps per quantum. Output positions retain the
loop of their delayed output segment, including after a different loop or loop exit
has been accepted. Natural end clips against each delayed
output segment's own rate and loop, rather than current processing settings, and
masks output after the source boundary.
`lengthFrames` remains `null` until exact EOF is known. `ended` is true when the
accepted active, nonlooped source position is at that known boundary. This includes
natural output completion, an explicit seek to the end and an empty source; it
does not prove that audio was emitted. Natural completion retains the `paused`
status value; `ended` distinguishes it from a user pause. An empty source emits no
valid source frame.

Each observation includes `outputSegments`, describing only valid source output
within that render quantum. A segment contains absolute AudioContext output-frame
bounds `fromFrame` (inclusive) and `toFrame` (exclusive), the source position at
`fromFrame`, its rate and its own loop bounds or `null`. Within that interval,
advance the source position by elapsed output frames times rate, wrapping in the
segment's loop. A quantum can contain more than one delayed segment; do not infer
its output loop or rate from current accepted settings. `renderedThroughFrame` is
the exclusive render-quantum boundary, not permission to extrapolate valid source
output into silence or beyond the listed segment bounds. Empty segments describe
no valid source output during pause, preparation, exhausted underrun or empty EOF.

The low-frequency `state` notifications are status observations, not a continuous
output clock. A source worker can send `observe-output` to request a snapshot at
the next native render quantum. The worklet replies `observation-queued`, then
`output-observation` with the same request identity and the quantum's observation.
Only one request can await rendering; another is rejected with
`observation_pending`. Rendering does not emit additional requested snapshots
until the worker requests another. This gives the consumer quantum-driven
backpressure without accumulating unsolicited per-quantum messages when it is
slow or throttled. Detaching rejects an awaiting request with `source_closed`.
The consumer must bound retained snapshots, discard stale generation data and
report unavailable clock coverage when the requested output frame is outside
retained valid segments. Neither accepted future commands nor latent DSP history
authorize a guessed future source position.

Output frames refer to the AudioContext render stream, not the physical device.
Device-clock mapping belongs to the consumer's `AudioContext.getOutputTimestamp()`
observation. A suspended/interrupted context does not render; the port cannot
acknowledge a command before rendering resumes. Browser output and lifecycle
qualification are distinct from the embedded-WASM Node tests.

## Bounded committed-output history

An attachment may opt into `outputHistory: {maxFrames, maxRecords,
maxReplyRecords}`. All bounds are safe integers: `maxFrames` is 1 through
4294967295, `maxRecords` is 1 through 4096, and `maxReplyRecords` is 1 through
`min(maxRecords, 256)`. Invalid bounds reject attachment before replacing an
existing generation. PCM residency remains separately bounded by
`capacityFrames`.

The worklet retains actual committed render intervals in a preallocated numeric
ring of eight Float64 values per record: at most 256 KiB of numeric ring storage.
It prunes on every append, even without a requesting observer, by both frame
horizon and record capacity. These are numeric storage bounds, not a claim about
JavaScript engine heap overhead. A copied reply contains at most 256 records
(16 KiB numeric payload); transferring it never detaches the live ring.

Send `{type: 'observe-history', generation, requestId, fromFrame}` through the
source worker's port. `fromFrame` is the inclusive first requested output frame.
Use the previous reply's exclusive `returnedThroughFrame` for the next request.
Request IDs are nonempty strings or safe integers, so cancellation targets remain
stable across structured cloning. Use a unique ID for every outstanding request.
Negative, unsafe or future frames reject. A request behind committed output
returns immediately. A request at the committed boundary waits for the next
actual render; before the first render only frame zero is accepted. One waiting
history credit is allowed. A duplicate rejects with `observation_pending`.
`{type: 'cancel-observe-history', generation, requestId,
observationRequestId}` cancels that waiting request with `observation_cancelled`
and acknowledges with `history-cancelled`. Detach/replacement settles the waiting
credit with `source_closed`. A suspended context creates no history or fabricated
progress; its request can remain pending until resume, cancellation or closure.
Actual browser port delivery during suspension requires platform qualification.

An `output-history` reply contains:

- `generationStartFrame`: first actual committed render frame, null before one.
- `oldestRetainedFrame`: inclusive retained coverage boundary, null before render.
- `renderedThroughFrame`: exclusive boundary of all committed output.
- `returnedThroughFrame`: exclusive end of this bounded reply, which can precede
  `renderedThroughFrame`. An empty reply returns the requested frame only inside
  the committed generation domain; before the first render it is null.
- `preGenerationThroughFrame`: the generation start when the request precedes
  attachment's first render, otherwise null. No attachment-gap audio is invented.
- `truncatedBeforeFrame`: oldest retained frame if requested generation coverage
  was evicted, otherwise null. Eviction is unavailable coverage, never silence.
- `records`: an owned copied Float64Array, with stride eight:
  `[fromFrame, toFrame, sourceFrame, rate, loopStart, loopEnd, status, ended]`.

`SignalsmithStretch.decodeOutputHistory(reply)` validates the envelope, bounded
stride/count, ordered contiguous temporal ranges, status and NaN conventions,
and returns named records. Status codes are 0 playing, 1 draining, 2 paused,
3 preparing, 4 underrun, 5 source-error and 6 ended. Only playing/draining have
finite source position and rate; silence uses NaN for source/rate/loop fields.
Absent loop bounds are both NaN. All intervals are inclusive/exclusive.

Source records use their own delayed rate and loop, including when pruning or
reply clipping cuts through a fractional loop. Seek/pause reset DSP preparation
without erasing already committed history in the same generation. Draining
records remain valid source coverage until the actual copied tail ends, followed
by the observed silence reason. `ended` is false on every real audio record,
including the last one. Only known EOF silence is marked ended, beginning at the
exclusive end of the last real tail, or immediately for an accepted seek-to-end.
It does not reinterpret the existing accepted-position `IObservation.ended`.

Consumers must cap their own retained records/frame horizon and treat
pre-generation, evicted and future output as unavailable. Correlate only retained
committed ranges with `getOutputTimestamp()`; do not extrapolate. History source
and embedded-WASM tests do not establish browser/device continuity qualification.

## Render-thread grid metronome

The source-fetching worker can send `{type: 'metronome', generation, requestId,
enabled, regions}` through its existing source port. The default is disabled.
Configuration is validated and copied atomically; at most one update can wait
for a render quantum. `metronome-queued` acknowledges acceptance into that queue.
`metronome-accepted` reports the actual `effectiveOutputFrame` of the render
quantum that applies it and the accepted `enabled` value. Suspension does not
invent an effective frame. Source closure rejects a pending update. Generation
identity is checked by the same owner as every other source message.

`regions` contains at most 4096 ordered, nonoverlapping tempo regions. Each has
inclusive `startFrame`, exclusive `endFrame`, `firstBeatFrame` inside that range,
finite `framesPerBeat` of at least one source sample, and safe-integer
`firstBeatIndex`. Frame bounds are finite, nonnegative and no greater than
`Number.MAX_SAFE_INTEGER`; the region's beat indices must also remain safe
integers. Beats start at `firstBeatFrame` and continue by `framesPerBeat` until
the exclusive end. Gaps contain no beats. An index divisible by four accents
the downbeat. Invalid or oversized data rejects without changing configuration;
there is no silent truncation. Compact tempo regions represent long regular
grids without allocating one entry for every beat.

The wrapper mixes clicks after copying and clipping actual WASM output. Beat
crossings use each committed output segment's delayed source position, rate
and loop, including a still-audible old loop after an accepted loop exit. The
first output sample at or beyond a crossed beat starts a click; multiple beats
crossed within one output sample coalesce into the first crossing. Clicks use
a 30 ms sine with exponential gain decay to 0.001: 1760 Hz and initial gain 0.5
on downbeats, otherwise 1100 Hz and gain 0.3. Pitch transposition does not
transpose the click. The same click signal is added to each output channel.

Pause, discontinuous seek, disabling or replacing the grid cuts its existing
click tail. Valid delayed drain samples can still click. Preparation, starvation,
source failure after valid drain, and EOF silence cannot create or sustain a
click. No independent context, timer, future history extrapolation or
main-thread scheduling deadline is involved. Native render tests qualify sample
alignment; actual browser transport integration remains a separate gate.
