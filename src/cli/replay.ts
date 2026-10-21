/**
 * Prototype: drive a League replay and check the voice sync.
 *
 *   npm run replay -- status
 *   npm run replay -- seek 600          (seconds)
 *   npm run replay -- watch <gameId>    (launch the replay from the client)
 *   npm run replay -- sync <sessionDir> (prints who is talking at the replay's current time)
 */
import { getPlayback, setPlayback } from '../lol/game-client.js';
import { LcuClient, readLockfile } from '../lol/lcu.js';
import { activeSegments, loadSession } from '../session/session.js';

const [cmd, arg] = process.argv.slice(2);

function fmt(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

switch (cmd) {
  case 'status': {
    const p = await getPlayback();
    console.log(`${fmt(p.time)} / ${fmt(p.length)}  vitesse x${p.speed}${p.paused ? '  (pause)' : ''}`);
    break;
  }
  case 'seek': {
    const p = await setPlayback({ time: Number(arg) });
    console.log(`Position : ${fmt(p.time)}`);
    break;
  }
  case 'watch': {
    const lcu = new LcuClient(await readLockfile());
    await lcu.watchReplay(Number(arg));
    console.log('Replay lancé.');
    break;
  }
  case 'sync': {
    const meta = await loadSession(arg!);
    if (meta.gameStartWallMs === undefined) throw new Error("Cette session n'a pas d'horloge de partie.");
    console.log('Ctrl+C pour quitter.');
    let last = '';
    setInterval(async () => {
      const p = await getPlayback().catch(() => undefined);
      if (!p) return;
      const names = activeSegments(meta, p.time).map(({ segment }) => meta.speakers[segment.userId]?.displayName ?? segment.userId);
      const line = `${fmt(p.time)}  ${names.length ? names.join(', ') : '—'}`;
      if (line !== last) console.log((last = line));
    }, 200);
    break;
  }
  default:
    console.log('Usage : replay status | seek <secondes> | watch <gameId> | sync <dossier de session>');
}
