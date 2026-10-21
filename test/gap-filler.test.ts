import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GapFiller } from '../src/discord/gap-filler.js';
import { OPUS_SILENCE_FRAME } from '../src/discord/ogg-opus-writer.js';

const pkt = Buffer.from([1, 2, 3]);

test('passes through packets arriving on time, with jitter', () => {
  const f = new GapFiller();
  const out = [0, 22, 38, 61, 79].flatMap((t) => f.push(pkt, 1000 + t));
  assert.equal(out.length, 5);
  assert.equal(f.start, 1000);
});

test('fills a 1 s pause with 20 ms silence frames', () => {
  const f = new GapFiller();
  f.push(pkt, 0);
  f.push(pkt, 20);
  const out = f.push(pkt, 1040);
  // frames 2..51 are missing: 50 silence frames, then the packet as frame 52
  assert.equal(out.length, 51);
  assert.deepEqual(out[0], OPUS_SILENCE_FRAME);
  assert.equal(out.at(-1), pkt);
});
