import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withReplayApiEnabled } from '../src/app/game-config.js';
import { summarizeEog } from '../src/lol/game-watcher.js';

test('enables the Replay API in game.cfg', () => {
  assert.equal(withReplayApiEnabled('[General]\r\nWindowMode=2\r\n'), '[General]\r\nEnableReplayApi=1\r\nWindowMode=2\r\n');
  assert.equal(withReplayApiEnabled('[General]\nEnableReplayApi=0\n'), '[General]\nEnableReplayApi=1\n');
  assert.equal(withReplayApiEnabled('[HUD]\nX=1\n'), '[General]\nEnableReplayApi=1\n[HUD]\nX=1\n');
});

test('summarizes the end-of-game stats for the local player', () => {
  const summary = summarizeEog({
    gameId: 1,
    gameLength: 1712,
    queueType: 'RANKED_FLEX_SR',
    localPlayer: { puuid: 'me', championName: 'Jinx', stats: { CHAMPIONS_KILLED: 9, NUM_DEATHS: 3, ASSISTS: 11 } },
    teams: [
      { isWinningTeam: false, players: [{ puuid: 'x' }] },
      { isWinningTeam: true, players: [{ puuid: 'me' }] },
    ],
  });
  assert.deepEqual(summary, { championName: 'Jinx', win: true, kills: 9, deaths: 3, assists: 11, queueType: 'RANKED_FLEX_SR', gameLengthS: 1712 });
});
