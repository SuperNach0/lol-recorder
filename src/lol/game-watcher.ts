import { EventEmitter } from 'node:events';
import { LcuClient, readLockfile, type GameflowPhase } from './lcu.js';
import { sampleGameClock } from './game-client.js';
import type { ClockSample } from '../session/session.js';

const CLOCK_SAMPLE_INTERVAL_MS = 1000;
const IN_GAME_PHASES = new Set<GameflowPhase>(['GameStart', 'InProgress', 'Reconnect']);
const PRE_GAME_PHASES = new Set<GameflowPhase>(['Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect']);
const POST_GAME_PHASES = new Set<GameflowPhase>(['WaitingForStats', 'PreEndOfGame', 'EndOfGame']);

/**
 * Follows the League client and emits:
 * - `pregame`  when entering lobby / queue / champ select
 * - `game-start` (gameId) when the game is in progress
 * - `clock` (ClockSample) every second during the game
 * - `game-end` (gameId) when the game is over
 * - `phase` (phase) for every change
 */
export class GameWatcher extends EventEmitter {
  private lcu: LcuClient | undefined;
  private phase: GameflowPhase = 'None';
  private gameId: number | undefined;
  private clockTimer: NodeJS.Timeout | undefined;

  async start(): Promise<LcuClient> {
    this.lcu = new LcuClient(await readLockfile());
    this.lcu.on('gameflow-phase', (p: GameflowPhase) => void this.onPhase(p));
    this.lcu.on('error', (err) => this.emit('error', err));
    await this.lcu.connectEvents();
    await this.onPhase(await this.lcu.gameflowPhase());
    return this.lcu;
  }

  stop(): void {
    this.stopClock();
    this.lcu?.close();
  }

  private async onPhase(phase: GameflowPhase): Promise<void> {
    if (phase === this.phase) return;
    const previous = this.phase;
    this.phase = phase;
    this.emit('phase', phase);

    if (PRE_GAME_PHASES.has(phase) && !PRE_GAME_PHASES.has(previous)) this.emit('pregame');

    if (IN_GAME_PHASES.has(phase) && this.gameId === undefined) {
      this.gameId = await this.lcu!.currentGameId().catch(() => undefined);
      this.emit('game-start', this.gameId);
      this.startClock();
    }

    if ((POST_GAME_PHASES.has(phase) || phase === 'None' || phase === 'Lobby') && this.gameId !== undefined && !IN_GAME_PHASES.has(phase)) {
      this.stopClock();
      const gameId = this.gameId;
      this.gameId = undefined;
      this.emit('game-end', gameId);
    }
  }

  private startClock(): void {
    this.stopClock();
    this.clockTimer = setInterval(() => {
      // The Live Client Data API answers only once the game has loaded.
      sampleGameClock()
        .then((s: ClockSample) => {
          if (s.gameTimeS > 0) this.emit('clock', s);
        })
        .catch(() => undefined);
    }, CLOCK_SAMPLE_INTERVAL_MS);
  }

  private stopClock(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = undefined;
  }
}

/** Asks the client to download the .rofl, retrying while it is not ready yet. */
export async function downloadReplayWhenReady(lcu: LcuClient, gameId: number, log = console.log, attempts = 30): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const meta = await lcu.replayMetadata(gameId).catch(() => undefined);
    if (meta?.state === 'watch') return true;
    if (meta?.state === 'download') {
      log(`Téléchargement du replay ${gameId}...`);
      await lcu.downloadReplay(gameId).catch((e: Error) => log(`Échec du téléchargement : ${e.message}`));
    }
    if (meta?.state === 'incompatible' || meta?.state === 'missingOrExpired') return false;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return false;
}
