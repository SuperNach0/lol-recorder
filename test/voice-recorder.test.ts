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
  const receiver = {
    speaking,
    subscriptions,
    subscribe(userId: string) {
      const stream = new Readable({ read() {} });
      subscriptions.set(userId, stream);
      stream.once('close', () => subscriptions.delete(userId));
      return stream;
    },
  };
  return { connection: { receiver } as unknown as VoiceConnection, receiver };
}

test('records each user to a separate timestamped segment, ignoring the bot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  const { connection, receiver } = fakeConnection();
  const recorder = new VoiceRecorder(connection, dir, new Set(['bot']));
  const segments: Segment[] = [];
  recorder.on('segment', (s: Segment) => segments.push(s));

  for (const user of ['alice', 'bob', 'bot']) receiver.speaking.emit('start', user);
  assert.deepEqual([...receiver.subscriptions.keys()], ['alice', 'bob']);

  const before = Date.now();
  for (let i = 0; i < 10; i++) receiver.subscriptions.get('alice')!.push(Buffer.from([0xfc, i]));
  receiver.subscriptions.get('bob')!.push(Buffer.from([0xfc, 0]));
  receiver.subscriptions.get('alice')!.destroy();

  await recorder.stop();
  assert.equal(segments.length, 2);
  const alice = segments.find((s) => s.userId === 'alice')!;
  assert.equal(alice.durationMs, 200);
  assert.ok(alice.startWallMs >= before);
  assert.ok(statSync(join(dir, alice.file)).size > 0);
});
