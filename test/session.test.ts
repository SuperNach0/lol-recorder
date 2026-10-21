import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSegments, type SessionMeta } from '../src/session/session.js';
import { estimateGameStart } from '../src/lol/clock.js';

test('estimates game start from noisy samples using the median', () => {
  const start = 1_700_000_000_000;
  const samples = [10, 11, 12, 13, 14].map((g) => ({ wallMs: start + g * 1000 + 15, gameTimeS: g }));
  samples.push({ wallMs: start + 15_000 + 900, gameTimeS: 15 }); // slow response
  assert.ok(Math.abs(estimateGameStart(samples)! - start - 15) < 1);
  assert.equal(estimateGameStart([]), undefined);
});

test('finds the segments audible at a given game time', () => {
  const gameStartWallMs = 1_000_000;
  const meta: SessionMeta = {
    id: 's', createdAt: '', clockSamples: [], speakers: {}, gameStartWallMs,
    segments: [
      { userId: 'a', startWallMs: gameStartWallMs - 30_000, durationMs: 10_000, file: 'a1.ogg' }, // champ select
      { userId: 'a', startWallMs: gameStartWallMs + 600_000, durationMs: 4_000, file: 'a2.ogg' },
      { userId: 'b', startWallMs: gameStartWallMs + 601_000, durationMs: 2_000, file: 'b1.ogg' },
    ],
  };
  assert.deepEqual(activeSegments(meta, -25).map((s) => s.segment.file), ['a1.ogg']);
  const at = activeSegments(meta, 601.5);
  assert.deepEqual(at.map((s) => s.segment.file), ['a2.ogg', 'b1.ogg']);
  assert.equal(at[0]!.offsetS, 1.5);
  assert.deepEqual(activeSegments(meta, 700), []);
});
