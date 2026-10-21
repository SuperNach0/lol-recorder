import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OggOpusWriter } from '../src/discord/ogg-opus-writer.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('writes an Ogg Opus file that ffmpeg decodes with the expected duration', { skip: !hasFfmpeg && 'ffmpeg absent' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ogg-'));
  // Real Opus packets: encode 3 s of tone, then re-mux its packets with our writer.
  const src = join(dir, 'src.opus');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ac', '2', '-c:a', 'libopus', '-frame_duration', '20', src]);

  const { OggDemuxer } = (await import('prism-media')).default.opus;
  const { createReadStream } = await import('node:fs');
  const packets: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    createReadStream(src).pipe(new OggDemuxer()).on('data', (p: Buffer) => packets.push(p)).on('end', resolve).on('error', reject);
  });
  assert.ok(packets.length >= 149);

  const out = join(dir, 'out.ogg');
  const writer = new OggOpusWriter(out);
  for (const p of packets) writer.write(p);
  await writer.close();

  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
  assert.ok(Math.abs(duration - packets.length * 0.02) < 0.05, `duration ${duration}`);
  // Full decode must succeed without CRC or framing errors.
  const errors = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  assert.equal(errors, '');
});
