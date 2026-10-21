/**
 * Generates a fake recorded session (tones instead of voices) to try the
 * player without Discord or League:  npx tsx scripts/make-demo-session.ts <sessionsDir>
 * Requires ffmpeg.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import prism from 'prism-media';
import { OggOpusWriter } from '../src/discord/ogg-opus-writer.js';

const root = process.argv[2] ?? 'sessions';
const id = 'demo-2026-10-21';
const dir = join(root, id);
mkdirSync(dir, { recursive: true });
const gameStart = Date.parse('2026-10-21T19:05:00Z');
const users = [['111', 'Nacho', 440], ['222', 'Kevin', 550], ['333', 'Lucas', 660], ['444', 'Sarah', 330]] as const;
const segments = [];
let n = 0;
for (let t = -150; t < 1680; t += 37) {
  const [userId, , freq] = users[n++ % users.length]!;
  const dur = 1 + (n % 5);
  const src = join(dir, 'tmp.opus');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`, '-ac', '2', '-c:a', 'libopus', '-frame_duration', '20', src]);
  const packets: Buffer[] = [];
  await new Promise((r) => createReadStream(src).pipe(new prism.opus.OggDemuxer()).on('data', (p: Buffer) => packets.push(p)).on('end', r));
  unlinkSync(src);
  const startWallMs = gameStart + t * 1000;
  const file = `${userId}-${startWallMs}.ogg`;
  const writer = new OggOpusWriter(join(dir, file));
  packets.forEach((p) => writer.write(p));
  await writer.close();
  segments.push({ userId, startWallMs, durationMs: writer.frames * 20, file });
}
writeFileSync(join(dir, 'session.json'), JSON.stringify({
  id, createdAt: '2026-10-21T19:02:11.000Z', endedAt: '2026-10-21T19:35:00.000Z', channelName: 'League', gameId: 7712345678,
  game: { championName: 'Jinx', win: true, kills: 9, deaths: 3, assists: 11, queueType: 'RANKED_FLEX_SR', gameLengthS: 1712 },
  gameStartWallMs: gameStart, clockSamples: [{ wallMs: gameStart + 10_000, gameTimeS: 10 }],
  speakers: Object.fromEntries(users.map(([userId, displayName]) => [userId, { userId, displayName }])),
  segments,
}, null, 2));
console.log(`${segments.length} segments dans ${dir}`);
