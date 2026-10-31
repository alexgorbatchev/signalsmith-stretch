# Upstream provenance

This checkout extends the JavaScript AudioWorklet wrapper from
[Signalsmith Audio's Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch)
at commit `222093b4cc13ddb4d07c826bc3c1559326091731`.
That commit's `web/release/SignalsmithStretch.mjs` is byte-identical to the
published `signalsmith-stretch@1.3.2` package payload.
This is the selected published-web baseline, not a claim about the current
upstream C++ revision. Later upstream C++ changes are outside this extension's
embedded-WASM provenance and qualification.

The upstream C++ implementation, Emscripten bridge, and embedded WASM remain
unchanged. Sparse PCM ownership, wrapped analysis reads, and render-frame
observations belong to the wrapper. They do not implement another stretch or
pitch-shifting algorithm.

The original MIT license and copyright remain in `LICENSE.txt`; the web release
includes that file. Package naming, versioning and publication belong to the
fork's release workflow.

Run the wrapper's source and embedded-WASM tests with `make -C web test`.
Rebuild the JavaScript releases with `make -C web`. Recompiling the WASM requires
Emscripten through the existing `web/emscripten/compile.sh` workflow. A wrapper-only
build can reuse the unchanged checked-in `web/emscripten/main.js` with
`make -C web -o emscripten/main.js`.

The fork publishes the repository root as `@alexgorbatchev/signalsmith-stretch`.
The generated `.cjs` file is the standalone wrapper in CommonJS module format;
`.mjs` supplies the default ESM factory. Both have generated module-specific
declarations from `web/SignalsmithStretch.d.ts`. `web/release/UPSTREAM.md` and
the original license are copied into the published package by the Makefile.

For native validation, use Node 22 or newer, GNU Make, and npm:

1. Run `npm ci --ignore-scripts --registry=https://registry.npmjs.org` to install the pinned TypeScript 6.0.3 compiler.
2. Run `npm run build` to regenerate wrapper artifacts without recompiling the unchanged embedded WASM.
3. Run `npm test` for source ownership and actual embedded-WASM transport behavior.
4. Run `npm run test:package` to pack and install the release into an isolated `.tmp` consumer, invoke both module factories, and compile strict ESM/CommonJS consumers against the installed declarations.

The native CI matrix runs these checks on Node 22, 24, and 26 and rejects
uncommitted generated-release differences. These checks do not substitute for
actual browser audio qualification or constitute a package publication.

Node tests instantiate the real embedded WASM and advance render quanta
explicitly. They do not validate browser scheduling, hardware output latency,
background lifecycle, decoder format parity, or a source-fetching worker's
network behavior. Those require separate browser and integration qualification.
