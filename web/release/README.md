# Signalsmith Stretch Web

`@alexgorbatchev/signalsmith-stretch` provides Web Audio time stretching and pitch shifting with a bounded, windowed buffer transport. It retains Signalsmith Audio's MIT-licensed Signalsmith Stretch 1.3.2 WASM DSP. ESM and CommonJS imports resolve to callable factories with matching TypeScript declarations; the standalone `.js` artifact remains available for script loading.

The [windowed source protocol](WINDOWED-SOURCE.md) documents `attachSource()`, transferred PCM ownership, loop-aware analysis, command acknowledgements, and output-clock limitations. Live-input and append-only buffer operation are described below.

## Installation

```sh
npm install @alexgorbatchev/signalsmith-stretch@1.3.3-dev.1
```

```js
import SignalsmithStretch from '@alexgorbatchev/signalsmith-stretch';
```

CommonJS consumers use `const SignalsmithStretch = require('@alexgorbatchev/signalsmith-stretch')`.
Both entry points load without browser globals; creating a node requires a Web Audio context with AudioWorklet support in a secure browser context. The package includes its WASM payload and installs its worklet through a Blob URL unless `SignalsmithStretch.moduleUrl` specifies a separately hosted module.

The original license and exact upstream source boundary are included as [LICENSE.txt](LICENSE.txt) and [UPSTREAM.md](UPSTREAM.md). The wrapper does not decode media or fetch PCM; the source worker owns those operations and their memory budget.

## How to use it

Call `SignalsmithStretch(audioContext, ?channelOptions)` from the main thread.  This returns a Promise which resolves to an `AudioNode`, with extra methods attached to it.  The optional [`channelOptions` object](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode/AudioWorkletNode#options) can specify the number of inputs/outputs and channels.

It can operate either on live input (if connected to input audio), or on sample buffers you load into it (which can be added/removed dynamically, for streaming).  Either way, you need to call `.start()` (or equivalently `.schedule({active: true})`) for it to start processing audio.

### `stretch.inputTime`

The current input time, within the sample buffer.  You can change how often this is updated, with an optional callback function, using `stretch.setUpdateInterval(seconds, ?callback)`.

### `stretch.schedule({...})`

This adds a scheduled change, removing any scheduled changes occuring after this one.  The object properties are:

* `output` (seconds): audio context time for this change.  The node compensates for its own latency, but this means you might want to schedule some things ahead of time, otherwise you'll have a softer transition as it catches up.
* `active` (bool): processing audio
* `input` (seconds): position in input buffer
* `rate` (number): playback rate, e.g. 0.5 == half speed
* `semitones` (number): pitch shift
* `tonalityHz` (number): tonality limit (default 8000)
* `formantSemitones` (number) / `formantCompensation` (bool): formant shift/compensation
* `formantBaseHz` (number): rough fundamental used for formant analysis (e.g. 100 for low voice, 400 for high voice), or `0` to attempt pitch-tracking
* `loopStart` (seconds) / `loopEnd` (seconds): sets a section of the input buffer to auto-loop.  Disabled if both are set to the same value.

If the node is processing live input (not a buffer) then `input`/`rate`/`loopStart`/`loopEnd` are ignored.

### `stretch.start(?when)` / `stretch.stop(?when)`

Starts/stops playback or processing, immediately or at some future time.  These are convenience methods which call `.schedule(...)` under the hood.

`.start()` actually has more parameters, presenting a similar interface to [AudioBufferSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start).

### `stretch.addBuffers([...])`

This adds buffers to the end of the current input sample buffers.  Buffers should be typed arrays of equal length, one per channel.

It can be called multiple times, and the new buffers are inserted immediately after the existing ones, which lets you start playback before the entire audio is loaded.  It returns a Promise for the new sample buffer end time, in seconds.

### `stretch.dropBuffers()`

This drops all input buffers, and resets the input buffer end time to 0.

### `stretch.dropBuffers(toSeconds)`

This drops all input buffers before the given time, but doesn't change the end time.  It returns a Promise for an object with the current input buffer extent: `{start: ..., end: ...}`.

This can be useful when processing streams or very long audio files, letting the Stretch node release old buffers once that section of the input will no longer be played back.

### `stretch.latency()`

Returns the latency when used in "live input" mode, in seconds.  This is also how far ahead you might want to schedule things (`output` in `.schedule()`) to give the node enough time to fully compensate for its own latency.

### `stretch.configure({...})`

Optionally reconfigure, with the following fields:

* `blockMs`: block length in ms (e.g. 120ms)
* `intervalMs`: interval (default `blockMs/4`)
* `splitComputation`: spread computation more evenly across time (default `false`)

If you set `blockMs`  to `0` or `null`, it will check for a `preset` field (with the values `"default"`/`"cheaper"`).
