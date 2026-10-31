import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {openHarness} from './wasm-harness.mjs';

const source = () => runInNewContext(readFileSync(new URL('../output-history.js', import.meta.url), 'utf8')
  + '\n({createOutputHistory, decodeOutputHistory})', {Float64Array},
  {filename: fileURLToPath(new URL('../output-history.js', import.meta.url))});

test('frame pruning and reply clipping use each fractional loop segment own rate', () => {
  const {createOutputHistory, decodeOutputHistory} = source();
  const history = createOutputHistory({maxFrames: 101, maxRecords: 8, maxReplyRecords: 2});
  history.append({renderFrame: 1000, renderedThroughFrame: 1128, status: 'playing', ended: false,
    outputSegments: [{fromFrame: 1000, toFrame: 1128, sourceFrame: 10.25, rate: 1.5, loop: {start: 10.25, end: 17.75}}]});
  const reply = history.read(1030);
  assert.equal(reply.generationStartFrame, 1000);
  assert.equal(reply.oldestRetainedFrame, 1027);
  assert.equal(reply.returnedThroughFrame, 1128);
  const decoded = decodeOutputHistory(reply);
  assert.equal(decoded[0].sourceFrame, 10.25);
  assert.equal(decoded[0].fromFrame, 1030);
  assert.equal(decoded[0].toFrame, 1128);
});

test('record capacity and bounded reply preserve explicit truncation and known silence', () => {
  const {createOutputHistory, decodeOutputHistory} = source();
  const history = createOutputHistory({maxFrames: 10000, maxRecords: 2, maxReplyRecords: 1});
  for (let index = 0; index < 3; index++) history.append({renderFrame: 100 + index * 128,
    renderedThroughFrame: 228 + index * 128, status: 'paused', ended: false, outputSegments: []});
  const reply = history.read(0);
  assert.equal(reply.preGenerationThroughFrame, 100);
  assert.equal(reply.truncatedBeforeFrame, 228);
  assert.equal(reply.returnedThroughFrame, 356);
  assert.equal(reply.renderedThroughFrame, 484);
  assert.equal(reply.records.byteLength, 64);
  assert.equal(decodeOutputHistory(reply)[0].sourceFrame, null);
  const transferred = structuredClone(reply, {transfer: [reply.records.buffer]});
  assert.equal(reply.records.byteLength, 0);
  assert.equal(decodeOutputHistory(transferred).length, 1);
  assert.equal(history.read(356).records.byteLength, 64, 'copy transfer must never detach ring');
});

test('empty generation and future requests never invent committed coverage', () => {
  const {createOutputHistory} = source();
  const history = createOutputHistory({maxFrames: 1024, maxRecords: 8, maxReplyRecords: 8});
  assert.equal(history.read(0).returnedThroughFrame, null);
  assert.equal(history.read(0).generationStartFrame, null);
  assert.throws(() => history.read(1), {name: 'RangeError'});
  history.append({renderFrame: 100, renderedThroughFrame: 228, status: 'paused', ended: true, outputSegments: []});
  assert.equal(history.read(228).returnedThroughFrame, 228);
  assert.throws(() => history.read(229), {name: 'RangeError'});
});

const spec = {generation: 'history', sampleRate: 48000, channels: 1, lengthFrames: 24000, capacityFrames: 24000,
  outputHistory: {maxFrames: 48000, maxRecords: 4096, maxReplyRecords: 256}};
const historyReply = h => h.send('observe-history', {fromFrame: 0}, 'output-history');

test('actual WASM skipped credits retain preparation, loop music, seek and pause history', async () => {
  const h = await openHarness(spec);
  try {
    await h.send('window', {start: 0, channels: [Float32Array.from({length: 24000}, (_, i) => Math.sin(i * .08))]}, 'window-accepted');
    await h.send('command', {command: {id: 1, atFrame: 0, active: true, rate: 1.5, loop: {start: 100.25, end: 106.75}}}, 'queued');
    for (let index = 0; index < 40; index++) h.render();
    const before = source().decodeOutputHistory(await historyReply(h));
    assert.equal(before[0].status, 'preparing');
    assert.ok(before.some(record => record.status === 'playing' && record.loop.start === 100.25));
    const seekFrame = h.frame;
    await h.send('command', {command: {id: 2, atFrame: h.frame, position: 200.5, loop: null}}, 'queued');
    for (let index = 0; index < 30; index++) h.render();
    const pauseFrame = h.frame;
    await h.send('command', {command: {id: 3, atFrame: h.frame, active: false}}, 'queued');
    h.render();
    const after = source().decodeOutputHistory(await historyReply(h));
    assert.deepEqual(JSON.parse(JSON.stringify(after.filter(record => record.toFrame <= seekFrame))), JSON.parse(JSON.stringify(before)));
    assert.ok(after.some(record => record.fromFrame === seekFrame && record.status === 'preparing'));
    assert.equal(after.at(-1).fromFrame, pauseFrame);
    assert.equal(after.at(-1).status, 'paused');
    assert.equal(after.at(-1).sourceFrame, null);
  } finally { h.close(); }
});

test('actual native port credit cancellation, duplicate and close settle without rendering', async () => {
  const h = await openHarness(spec);
  try {
    const queued = await h.send('observe-history', {fromFrame: 0}, 'history-queued');
    await assert.rejects(h.send('observe-history', {fromFrame: 0}, 'history-queued'), /observation_pending/);
    const cancelled = h.wait(message => message.requestId === queued.requestId && message.code === 'observation_cancelled');
    await h.send('cancel-observe-history', {observationRequestId: queued.requestId}, 'history-cancelled');
    await cancelled;
    const second = await h.send('observe-history', {fromFrame: 0}, 'history-queued');
    const closed = h.wait(message => message.requestId === second.requestId && message.code === 'source_closed');
    h.transport.close();
    await closed;
  } finally { h.close(); }
});

test('actual native output history exposes first render only and rejects future frames', async () => {
  const h = await openHarness(spec);
  try {
    await assert.rejects(h.send('observe-history', {fromFrame: 1}, 'history-queued'), /invalid_observe-history/);
    await h.send('observe-history', {fromFrame: 0}, 'history-queued');
    const pending = h.wait(message => message.type === 'output-history');
    h.render();
    const reply = await pending;
    assert.equal(reply.generationStartFrame, 0);
    assert.equal(reply.returnedThroughFrame, 128);
    assert.equal(source().decodeOutputHistory(reply)[0].status, 'paused');
    await assert.rejects(h.send('observe-history', {fromFrame: 129}, 'history-queued'), /invalid_observe-history/);
  } finally { h.close(); }
});

for (const rate of [.5, 1, 1.5, 2]) test(`actual WASM fractional natural EOF at rate ${rate} marks only subsequent silence ended`, async () => {
  const h = await openHarness({...spec, lengthFrames: 1000});
  try {
    await h.send('window', {start: 0, channels: [Float32Array.from({length: 1000}, (_, i) => Math.sin(i * .08))]}, 'window-accepted');
    await h.send('command', {command: {id: 1, atFrame: 0, active: true, rate}}, 'queued');
    for (let index = 0; index < 60; index++) h.render();
    const records = source().decodeOutputHistory(await historyReply(h));
    const music = records.filter(record => record.sourceFrame !== null);
    assert.ok(music.length);
    assert.ok(music.every(record => !record.ended));
    const end = music.at(-1).toFrame;
    assert.ok(records.some(record => record.fromFrame === end && record.ended && record.sourceFrame === null));
  } finally { h.close(); }
});

for (const rate of [.5, 1, 1.5, 2]) test(`actual WASM frame cap clips fractional loop with own delayed rate ${rate}`, async () => {
  const h = await openHarness({...spec, outputHistory: {maxFrames: 37, maxRecords: 8, maxReplyRecords: 8}});
  try {
    await h.send('window', {start: 0, channels: [Float32Array.from({length: 24000}, (_, i) => Math.sin(i * .08))]}, 'window-accepted');
    await h.send('command', {command: {id: 1, atFrame: 0, active: true, rate, loop: {start: 100.25, end: 106.75}}}, 'queued');
    for (let index = 0; index < 40; index++) h.render();
    const reply = await historyReply(h);
    const records = source().decodeOutputHistory(reply);
    assert.equal(reply.oldestRetainedFrame, h.frame - 37);
    assert.equal(reply.truncatedBeforeFrame, h.frame - 37);
    const segment = h.lastRender.observation.outputSegments.find(item => item.fromFrame <= records[0].fromFrame && item.toFrame > records[0].fromFrame);
    const position = segment.sourceFrame + (records[0].fromFrame - segment.fromFrame) * segment.rate;
    const expected = 100.25 + ((position - 100.25) % 6.5 + 6.5) % 6.5;
    assert.equal(records[0].sourceFrame, expected);
    assert.equal(records[0].rate, rate);
    assert.equal(reply.returnedThroughFrame, h.frame);
  } finally { h.close(); }
});

test('actual WASM seek-to-end records EOF silence without inventing source audio', async () => {
  const h = await openHarness(spec);
  try {
    await h.send('command', {command: {id: 1, atFrame: 0, active: true, position: 24000}}, 'queued');
    h.render();
    const records = source().decodeOutputHistory(await historyReply(h));
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'ended');
    assert.equal(records[0].ended, true);
    assert.equal(records[0].sourceFrame, null);
    await assert.rejects(h.send('observe-history', {fromFrame: 0, generation: 'replacement'}, 'output-history'), /stale_generation/);
  } finally { h.close(); }
});

test('decoder rejects malformed envelopes, stride, temporal gaps, flags and NaN fields', () => {
  const {createOutputHistory, decodeOutputHistory} = source();
  const history = createOutputHistory({maxFrames: 4096, maxRecords: 8, maxReplyRecords: 8});
  history.append({renderFrame: 0, renderedThroughFrame: 128, status: 'playing', ended: false,
    outputSegments: [{fromFrame: 0, toFrame: 128, sourceFrame: 10, rate: 1, loop: null}]});
  const valid = history.read(0);
  const invalid = [null, {}, {...valid, records: []}, {...valid, records: new Float64Array(7)},
    {...valid, records: new Float64Array(257 * 8)}, {...valid, returnedThroughFrame: 129},
    {...valid, generationStartFrame: -1}, {...valid, oldestRetainedFrame: 129},
    {...valid, preGenerationThroughFrame: 1}, {...valid, truncatedBeforeFrame: 1},
    {...valid, records: new Float64Array(0)}];
  for (const value of invalid) assert.throws(() => decodeOutputHistory(value), {name: 'RangeError'});
  for (const [index, value] of [[0, 1], [1, 0], [2, NaN], [3, 0], [4, 0], [6, 7], [7, 1]]) {
    const records = valid.records.slice();
    records[index] = value;
    assert.throws(() => decodeOutputHistory({...valid, records}), {name: 'RangeError'});
  }
  history.append({renderFrame: 128, renderedThroughFrame: 256, status: 'paused', ended: false, outputSegments: []});
  const silence = history.read(128);
  silence.records[2] = 0;
  assert.throws(() => decodeOutputHistory(silence), {name: 'RangeError'});
});

test('decoder rejects nonexclusive or shared backing and accepts native transferred copies', () => {
  const {createOutputHistory, decodeOutputHistory} = source();
  const history = createOutputHistory({maxFrames: 4096, maxRecords: 8, maxReplyRecords: 8});
  history.append({renderFrame: 0, renderedThroughFrame: 128, status: 'paused', ended: false, outputSegments: []});
  const valid = history.read(0);
  const shadowed = new Float64Array(new ArrayBuffer(1024 * 1024), 0, 8);
  Object.defineProperties(shadowed, {buffer: {value: new ArrayBuffer(64)},
    byteOffset: {value: 0}, byteLength: {value: 64}});
  const shadowedLength = new Float64Array(257 * 8);
  Object.defineProperty(shadowedLength, 'length', {value: 8});
  for (const records of [new Float64Array(new ArrayBuffer(1024 * 1024), 0, 8),
    new Float64Array(new ArrayBuffer(128), 64, 8), new Float64Array(new SharedArrayBuffer(64)), shadowed, shadowedLength]) {
    records.set(valid.records);
    assert.throws(() => decodeOutputHistory({...valid, records}), {name: 'RangeError'});
  }
  const transferred = structuredClone(valid, {transfer: [valid.records.buffer]});
  assert.equal(valid.records.byteLength, 0);
  Object.defineProperties(transferred.records, {length: {value: 0},
    subarray: {value() {throw new Error('Input methods must not be invoked');}}});
  assert.equal(decodeOutputHistory(transferred)[0].status, 'paused');
  assert.equal(history.read(0).records.byteLength, 64);
});

test('bounds reject atomically and pruning occurs without observing', () => {
  const {createOutputHistory, decodeOutputHistory} = source();
  for (const options of [null, {}, {maxFrames: Infinity, maxRecords: 8, maxReplyRecords: 1},
    {maxFrames: 1024, maxRecords: 4097, maxReplyRecords: 1}, {maxFrames: 1024, maxRecords: 8, maxReplyRecords: 9}]) {
    assert.throws(() => createOutputHistory(options), {name: 'RangeError'});
  }
  const history = createOutputHistory({maxFrames: 37, maxRecords: 2, maxReplyRecords: 2});
  for (let frame = 0; frame < 12800; frame += 128) history.append({renderFrame: frame,
    renderedThroughFrame: frame + 128, status: 'source-error', ended: false, outputSegments: []});
  const reply = history.read(0);
  assert.equal(reply.oldestRetainedFrame, 12800 - 37);
  assert.equal(reply.truncatedBeforeFrame, 12800 - 37);
  assert.equal(reply.records.byteLength, 64);
  assert.equal(decodeOutputHistory(reply)[0].status, 'source-error');
});

test('actual WASM starvation keeps real draining tail then unavailable music until reprime', async () => {
  const h = await openHarness(spec);
  try {
    await h.send('window', {start: 0, channels: [Float32Array.from({length: 24000}, (_, i) => Math.sin(i * .08))]}, 'window-accepted');
    await h.send('command', {command: {id: 1, atFrame: 0, active: true}}, 'queued');
    for (let index = 0; index < 40; index++) h.render();
    await h.send('drop', {starts: [0]}, 'released');
    const starvationFrame = h.frame;
    for (let index = 0; index < 30; index++) h.render();
    const records = source().decodeOutputHistory(await historyReply(h));
    const tail = records.filter(record => record.fromFrame >= starvationFrame && record.status === 'draining');
    assert.ok(tail.length);
    assert.ok(tail.every(record => record.sourceFrame !== null));
    assert.ok(records.some(record => record.fromFrame === tail.at(-1).toFrame && record.status === 'underrun'));
    await h.send('window', {start: 0, channels: [Float32Array.from({length: 24000}, (_, i) => Math.sin(i * .08))]}, 'window-accepted');
    const recoveryFrame = h.frame;
    for (let index = 0; index < 30; index++) h.render();
    const recovered = source().decodeOutputHistory(await historyReply(h));
    assert.ok(recovered.some(record => record.fromFrame === recoveryFrame && record.status === 'preparing'));
    assert.ok(recovered.some(record => record.fromFrame > recoveryFrame && record.status === 'playing'));
  } finally { h.close(); }
});

test('actual WASM delayed rate and loop exit history changes exactly at effective output frame', async () => {
  const h = await openHarness(spec);
  try {
    await h.send('window', {start: 0, channels: [Float32Array.from({length: 24000}, (_, i) => Math.sin(i * .08))]}, 'window-accepted');
    await h.send('command', {command: {id: 1, atFrame: 0, active: true, loop: {start: 100.25, end: 6000.75}}}, 'queued');
    for (let index = 0; index < 40; index++) h.render();
    await h.send('command', {command: {id: 2, atFrame: h.frame, rate: 2, loop: null}}, 'queued');
    const applied = h.wait(message => message.type === 'applied' && message.commandId === 2);
    h.render();
    const ack = await applied;
    for (let index = 0; index < 30; index++) h.render();
    const records = source().decodeOutputHistory(await historyReply(h));
    const old = records.find(record => record.toFrame === ack.effectiveOutputFrame);
    const next = records.find(record => record.fromFrame === ack.effectiveOutputFrame);
    assert.equal(old.rate, 1);
    assert.equal(old.loop.start, 100.25);
    assert.equal(next.rate, 2);
    assert.equal(next.loop, null);
    assert.ok(records.filter(record => record.fromFrame < ack.effectiveOutputFrame && record.sourceFrame !== null).every(record => record.rate === 1));
  } finally { h.close(); }
});

test('history disabled attachments reject the protocol without disturbing ordinary output', async () => {
  const h = await openHarness({...spec, outputHistory: undefined});
  try {
    await assert.rejects(h.send('observe-history', {fromFrame: 0}, 'history-queued'), /invalid_observe-history/);
    await assert.rejects(h.send('cancel-observe-history', {observationRequestId: 99}, 'history-cancelled'), /invalid_cancel-observe-history/);
    h.render();
    assert.equal(h.lastRender, null);
  } finally { h.close(); }
});
