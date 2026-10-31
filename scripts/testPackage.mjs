import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = join(root, '.tmp');
mkdirSync(temporaryRoot, {recursive: true});
const directory = mkdtempSync(join(temporaryRoot, 'package-consumer-'));
const run = (command, args, cwd = directory) => execFileSync(command, args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  // A publish dry-run must still create and install the test tarball.
  env: {...process.env, npm_config_dry_run: 'false'}
});
const packed = JSON.parse(run('npm', ['pack', '--foreground-scripts=false', '--json', '--pack-destination', directory], root))[0];
const archive = join(directory, packed.filename);
writeFileSync(join(directory, 'package.json'), JSON.stringify({private: true, type: 'module'}));
run('npm', ['install', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund',
  '--registry=https://registry.npmjs.org', archive]);

// The public factory must reach worklet installation, rather than returning an
// ESM namespace or requiring a browser global merely to load the package.
const invokeCheck = `
assert.equal(typeof factory, 'function');
assert.equal(factory.moduleUrl, undefined);
factory.moduleUrl = 'https://example.org/worklet.js';
assert.equal(factory.moduleUrl, 'https://example.org/worklet.js');
await assert.rejects(factory({audioWorklet: {addModule() { throw new Error('worklet installation reached'); }}}), {message: 'worklet installation reached'});
`;
writeFileSync(join(directory, 'consumer.mjs'), "import assert from 'node:assert/strict';\nimport factory from '@alexgorbatchev/signalsmith-stretch';\n" + invokeCheck);
writeFileSync(join(directory, 'consumer.cjs'), "const assert = require('node:assert/strict');\nconst factory = require('@alexgorbatchev/signalsmith-stretch');\n(async () => {\n" + invokeCheck + "\n})().catch(error => { console.error(error); process.exitCode = 1; });\n");
run(process.execPath, ['consumer.mjs']);
run(process.execPath, ['consumer.cjs']);

const typeConsumer = `
async function connect(context: AudioContext, port: MessagePort): Promise<SignalsmithStretch.IStretchNode> {
  const node = await SignalsmithStretch(context, {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]});
  const description: SignalsmithStretch.ISourceDescription = {generation: 'track', sampleRate: context.sampleRate, channels: 1, lengthFrames: null, capacityFrames: 48000};
  const finiteDescription: SignalsmithStretch.ISourceDescription = {...description, lengthFrames: 480000};
  void finiteDescription;
  await node.attachSource(description, port, [port]);
  const command: SignalsmithStretch.ICommandMessage = {type: 'command', generation: description.generation, command: {id: 1, atFrame: 128, active: true, rate: 1.5, loop: {start: 100.25, end: 6100.25}}};
  const window: SignalsmithStretch.IWindowMessage = {type: 'window', generation: description.generation, start: 0, channels: [new Float32Array(12000)]};
  port.postMessage(window, window.channels.map(channel => channel.buffer));
  port.postMessage(command);
  const finalWindow: SignalsmithStretch.IWindowMessage = {type: 'window', generation: description.generation, start: 12000, channels: [new Float32Array(1000)], endFrame: 13000};
  const finalMessage: SignalsmithStretch.WorkerMessage = finalWindow;
  port.postMessage(finalMessage, finalWindow.channels.map(channel => channel.buffer));
  const eof: SignalsmithStretch.IEofMessage = {type: 'eof', generation: description.generation, endFrame: 13000};
  const eofMessage: SignalsmithStretch.WorkerMessage = eof;
  port.postMessage(eofMessage);
  // @ts-expect-error generation identity is immutable
  description.generation = 'other';
  // @ts-expect-error command rate is numeric
  command.command.rate = 'fast';
  await node.detachSource();
  await node.configure({preset: 'cheaper'});
  const scheduled: SignalsmithStretch.IScheduledState = await node.start({active: true, rate: 1.5, semitones: 0});
  scheduled.output.toFixed();
  await node.stop();
  await node.addBuffers([new Float32Array(128)]);
  await node.dropBuffers();
  return node;
}
function observe(message: SignalsmithStretch.WorkletMessage): number | null {
  if (message.type === 'applied') return message.effectiveOutputFrame;
  if (message.type === 'state') return message.sourceFrame;
  if (message.type === 'need') return message.range.end;
  return null;
}
function observeBoundary(message: SignalsmithStretch.IObservation): boolean {
  const length: number | null = message.lengthFrames;
  const ended: boolean = message.ended;
  void length;
  return ended;
}
function observeEof(message: SignalsmithStretch.IEofAcceptedMessage): number {
  const response: SignalsmithStretch.WorkletMessage = message;
  return response.lengthFrames;
}
function observeWindow(message: SignalsmithStretch.IAcceptedMessage): number | null {
  return message.lengthFrames;
}
function observeApplied(message: SignalsmithStretch.IAppliedMessage): boolean {
  return observeBoundary(message);
}
function observeState(message: SignalsmithStretch.IStateMessage): boolean {
  return observeBoundary(message);
}
void connect;
void observe;
void observeEof;
void observeWindow;
void observeApplied;
void observeState;
`;
writeFileSync(join(directory, 'consumer.mts'), "import SignalsmithStretch from '@alexgorbatchev/signalsmith-stretch';\n" + typeConsumer);
writeFileSync(join(directory, 'consumer.cts'), "import SignalsmithStretch = require('@alexgorbatchev/signalsmith-stretch');\n" + typeConsumer);
writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({compilerOptions: {
  noEmit: true, strict: true, module: 'NodeNext', target: 'ES2022', lib: ['ES2022', 'DOM'], skipLibCheck: false
}, files: ['consumer.mts', 'consumer.cts']}));
run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--project', join(directory, 'tsconfig.json')]);

const installed = join(directory, 'node_modules/@alexgorbatchev/signalsmith-stretch');
assert.equal(readFileSync(join(installed, 'LICENSE.txt'), 'utf8'), readFileSync(join(root, 'LICENSE.txt'), 'utf8'));
assert.equal(readFileSync(join(installed, 'UPSTREAM.md'), 'utf8'), readFileSync(join(root, 'UPSTREAM.md'), 'utf8'));
const receipt = {node: process.version, typescript: run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--version']).trim(),
  package: packed.name, version: packed.version, archiveSHA256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  archiveIntegrity: packed.integrity, files: packed.files.map(file => file.path), runtime: ['ESM callable factory', 'CommonJS callable factory'],
  declarations: ['NodeNext .mts consumer', 'NodeNext .cts consumer'], licenseAndProvenance: true};
writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({directory, ...receipt}, null, 2));
