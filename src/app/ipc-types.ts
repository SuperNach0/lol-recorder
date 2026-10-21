import type { RecorderStatus } from '../core/recorder-service.js';
import type { SessionMeta } from '../session/session.js';
import type { Playback } from '../lol/game-client.js';
import type { BotIdentity } from './discord-app.js';

export interface PublicSettings {
  configured: boolean;
  botName?: string;
  inviteUrl?: string;
  lolDir: string;
  sessionsDir: string;
  /** undefined when game.cfg was not found. */
  replayApi: boolean | undefined;
}

export interface SessionListItem {
  meta: SessionMeta;
  /** Replay state reported by the client: "watch", "download", "missingOrExpired"... */
  replayState?: string;
}

/** Everything the renderer can call, exposed by the preload script as `window.api`. */
export interface Api {
  getSettings(): Promise<PublicSettings>;
  checkToken(token: string): Promise<BotIdentity>;
  saveToken(token: string): Promise<PublicSettings>;
  setLolDir(): Promise<PublicSettings>;
  enableReplayApi(): Promise<PublicSettings>;
  openExternal(url: string): Promise<void>;
  openSessionsFolder(): Promise<void>;

  getStatus(): Promise<RecorderStatus>;
  startRecording(): Promise<boolean>;
  stopRecording(): Promise<void>;
  onStatus(cb: (status: RecorderStatus) => void): () => void;
  onLog(cb: (line: string) => void): () => void;
  onSessionsChanged(cb: () => void): () => void;

  listSessions(): Promise<SessionListItem[]>;
  getSession(id: string): Promise<SessionMeta>;
  watchReplay(gameId: number): Promise<void>;
  downloadReplay(gameId: number): Promise<void>;
  seekReplay(time: number): Promise<void>;
  setReplayPaused(paused: boolean): Promise<void>;
  followReplay(enabled: boolean): Promise<void>;
  onPlayback(cb: (playback: Playback | null) => void): () => void;
}
