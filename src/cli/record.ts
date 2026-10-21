/**
 * Headless recorder, same engine as the desktop app (useful for debugging).
 *
 *   npm run record
 */
import 'dotenv/config';
import { RecorderService } from '../core/recorder-service.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Variable manquante : DISCORD_TOKEN (voir .env.example)');
  process.exit(1);
}

const service = new RecorderService({
  token,
  sessionsRoot: process.env.SESSIONS_DIR ?? 'sessions',
  ownerId: process.env.DISCORD_OWNER_ID || undefined,
  lockfile: process.env.LOL_LOCKFILE || undefined,
});
service.on('log', (m: string) => console.log(m));
service.on('status', (s) => s.phase && console.log(`[LoL] ${s.phase}`));

process.on('SIGINT', async () => {
  await service.stop();
  process.exit(0);
});

await service.start();
