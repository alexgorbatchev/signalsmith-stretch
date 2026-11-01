`@alexgorbatchev/signalsmith-stretch` provides browser audio pitch shifting and time stretching with an embedded WASM engine and TypeScript declarations. This fork of Signalsmith Audio's library adds bounded, windowed PCM transport for long or streamed sources.

# What It Does

- **Independent pitch and speed:** Change pitch without changing playback speed, or stretch buffered audio without changing pitch.
- **Live and buffered audio:** Process a connected Web Audio source, append sample buffers, or attach a worker-managed windowed source.
- **Bounded source memory:** Transfer PCM windows through a MessagePort with explicit ownership, loop handling, and end-of-source reporting.
- **Module support:** Import a callable factory through ESM or CommonJS, with declarations for both.

# How It Works

1. Create an AudioContext and pass it to the factory.
2. Connect an input node or provide PCM buffers, then connect the stretch node to an output.
3. Start processing and schedule pitch or playback changes.

# How it Really Works

1. The asynchronous factory installs an AudioWorklet and initializes the included WASM payload. No separate WASM download is required. Importing the package does not require browser globals; creating a node does.
2. The default worklet installation uses a Blob URL. If your Content Security Policy disallows this, serve the exported `SignalsmithStretch.js` asset and set `SignalsmithStretch.moduleUrl` to its URL before creating the first node on a context.
3. Audio processing introduces latency. Use `await stretch.latency()` when planning live playback. Buffered time stretching sounds best for modest speed changes, approximately 0.75×–1.5×.
4. The wrapper does not fetch or decode media. With a windowed source, your worker owns decoding, fetching, and its memory budget. PCM must match the context sample rate and configured channel count.

# Prerequisites

- A browser with [AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet) and WebAssembly support, served over HTTPS or localhost.
- A user interaction to resume audio when required by browser autoplay policy.

# Installation

The scoped package must have a stable release published to npm before this command is available:

```sh
npm install @alexgorbatchev/signalsmith-stretch
```

Stable releases use the `latest` npm tag, which npm installs by default. Use `@next` only to opt into an explicitly published prerelease.

# Quick Start

In a browser application with npm module bundling, this creates a button that plays a pitch-shifted tone for one second:

```js
import SignalsmithStretch from '@alexgorbatchev/signalsmith-stretch';

const button = document.createElement('button');
button.textContent = 'Play shifted tone';
document.body.append(button);

button.addEventListener('click', async () => {
  const context = new AudioContext();
  await context.resume();
  const stretch = await SignalsmithStretch(context);
  const oscillator = new OscillatorNode(context, {frequency: 220});
  const volume = new GainNode(context, {gain: 0.1});
  oscillator.connect(stretch).connect(volume).connect(context.destination);
  await stretch.start({semitones: 7});
  oscillator.start();
  oscillator.stop(context.currentTime + 1);
  oscillator.addEventListener('ended', async () => {
    const latency = await stretch.latency();
    setTimeout(() => { void context.close(); }, (latency + 0.1) * 1000);
  });
});
```

CommonJS consumers use `const SignalsmithStretch = require('@alexgorbatchev/signalsmith-stretch')`. This module format does not provide a Node.js audio backend.

# API

| API | Purpose |
| :--- | :--- |
| `SignalsmithStretch(context, channelOptions?)` | Resolve an AudioWorkletNode with the methods below. |
| `start(options?)`, `stop(when?)` | Start or stop processing. |
| `schedule(options)` | Schedule active state, pitch, rate, input position, or looping. |
| `addBuffers(channels)` | Append equal-length Float32Array PCM buffers, one per channel. |
| `dropBuffers(toSeconds?)` | Release buffered audio. |
| `latency()` | Resolve live-input latency in seconds. |
| `configure(options)` | Configure the DSP before attaching a windowed source. |
| `attachSource(description, port, transfer?)` | Attach worker-managed PCM transport. |
| `detachSource()` | Detach and reset windowed transport. |

See the [Web Audio API reference](web/API.md) for scheduling and buffer operations, and the [windowed source protocol](web/WINDOWED-SOURCE.md) for worker messages, transfers, acknowledgements, loops, and output-clock limitations. Live input ignores playback rate and buffered-input positions.

# Configuration

| Option | Default | Purpose |
| :--- | :--- | :--- |
| `preset` | `"default"` | Select `"default"` or `"cheaper"` processing. |
| `blockMs` | Preset-dependent | Override the processing block length. |
| `intervalMs` | `blockMs / 4` | Set the processing interval with a custom block length. |
| `splitComputation` | `false` | Spread computation across render calls. |

# Upstream

The embedded DSP comes from Signalsmith Stretch 1.3.2; see [upstream provenance](UPSTREAM.md) for the exact boundary and validation limitations. The [C++ API guide](https://github.com/alexgorbatchev/signalsmith-stretch/blob/HEAD/CPP.md) covers native use. Development and release instructions are in [CONTRIBUTING.md](https://github.com/alexgorbatchev/signalsmith-stretch/blob/HEAD/CONTRIBUTING.md).

# Versioning

Versions track the adopted upstream web/DSP baseline's major and minor numbers. The patch number advances independently for fork releases: for example, `1.3.3`, `1.3.4`, and `1.3.5` all belong to the upstream `1.3` line. The exact upstream version and commit are recorded in [UPSTREAM.md](UPSTREAM.md); the fork patch number does not identify an upstream patch.

This scheme identifies upstream lineage and fork releases; it does not encode the compatibility of fork API changes as strict Semantic Versioning would. Pin dependencies to an exact version and review release notes before upgrading.

# License

[MIT](LICENSE.txt), retaining Signalsmith Audio's original copyright.
