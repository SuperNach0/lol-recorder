import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceConnection } from '@discordjs/voice';
import { VoiceRecorder } from '../src/discord/voice-recorder.js';
import type { Segment } from '../src/session/session.js';

/** Stands in for @discordjs/voice's receiver: one Readable of Opus packets per user. */
function fakeConnection() {
  const speaking = new EventEmitter();
  const subscriptions = new Map<string, Readable>();
  let subscribeCalls = 0;
  const receiver = {
    speaking,
    subscriptions,
    get subscribeCalls() {
      return subscribeCalls;
    },
    subscribe(userId: string) {
      subscribeCalls++;
      const stream = new Readable({ read() {} });
      subscriptions.set(userId, stream);
      stream.once('close', () => subscriptions.delete(userId));
      return stream;
    },
  };
  return { connection: { receiver } as unknown as VoiceConnection, receiver };
}

const packet = (i: number) => Buffer.from([0xfc, i & 0xff]);
const tick = () => new Promise((r) => setImmediate(r));

test('records each user to a separate timestamped segment, ignoring the bot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  const { connection, receiver } = fakeConnection();
  let now = 1_000_000;
  const recorder = new VoiceRecorder(connection, dir, new Set(['bot']), () => now);
  const segments: Segment[] = [];
  recorder.on('segment', (s: Segment) => segments.push(s));

  for (const user of ['alice', 'bob', 'bot']) receiver.speaking.emit('start', user);
  assert.deepEqual([...receiver.subscriptions.keys()], ['alice', 'bob']);

  for (let i = 0; i < 10; i++) {
    receiver.subscriptions.get('alice')!.push(packet(i));
    await tick();
    now += 20;
  }
  receiver.subscriptions.get('bob')!.push(packet(0));
  await tick();

  await recorder.stop();
  assert.equal(segments.length, 2);
  const alice = segments.find((s) => s.userId === 'alice')!;
  assert.equal(alice.durationMs, 200);
  assert.equal(alice.startWallMs, 1_000_000);
  assert.ok(statSync(join(dir, alice.file)).size > 0);
});

test('starts a new segment after 2 s of silence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  const { connection, receiver } = fakeConnection();
  let now = 0;
  const recorder = new VoiceRecorder(connection, dir, new Set(), () => now);
  const segments: Segment[] = [];
  recorder.on('segment', (s: Segment) => segments.push(s));

  receiver.speaking.emit('start', 'alice');
  const stream = receiver.subscriptions.get('alice')!;
  stream.push(packet(1));
  await tick();
  now = 5000;
  stream.push(packet(2));
  await tick();
  await recorder.stop();
  assert.deepEqual(segments.map((s) => s.startWallMs), [0, 5000]);
});

test('re-subscribes when a stream fails to decrypt, and keeps what was recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  const { connection, receiver } = fakeConnection();
  const recorder = new VoiceRecorder(connection, dir);
  const segments: Segment[] = [];
  const warnings: string[] = [];
  recorder.on('segment', (s: Segment) => segments.push(s));
  recorder.on('warn', (w: string) => warnings.push(w));

  receiver.speaking.emit('start', 'alice');
  receiver.subscriptions.get('alice')!.push(packet(1));
  await tick();
  receiver.subscriptions.get('alice')!.destroy(new Error('Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)'));
  await tick();
  await tick();
  assert.equal(receiver.subscribeCalls, 2);
  assert.ok(receiver.subscriptions.has('alice'));
  assert.equal(warnings.length, 1);

  receiver.subscriptions.get('alice')!.push(packet(2));
  await tick();
  await recorder.stop();
  assert.equal(segments.length, 2);
});
