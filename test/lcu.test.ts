import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLockfile } from '../src/lol/lcu.js';

test('parses the League client lockfile', () => {
  assert.deepEqual(parseLockfile('LeagueClient:12345:54321:s3cr3t-Pa_ss:https\n'), { port: 54321, password: 's3cr3t-Pa_ss' });
  assert.throws(() => parseLockfile('garbage'));
});
