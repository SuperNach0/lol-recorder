import { activeSegments } from '../session/timeline.js';
import type { SessionMeta } from '../session/session.js';

/** Drift tolerated between an audio element and the game clock before re-seeking. */
const MAX_DRIFT_S = 0.3;
/** Above this replay speed voices are unintelligible: mute instead. */
const MAX_AUDIBLE_SPEED = 2;
/** Segments starting within this window are preloaded. */
const PRELOAD_S = 3;

export interface ClockState {
  time: number;
  paused: boolean;
  speed: number;
}

/**
 * Plays each speaker's recorded segments in step with an external clock
 * (the League replay, or a local clock when no replay is running).
 */
export class AudioEngine {
  private readonly elements = new Map<string, HTMLAudioElement>();
  private readonly volumes = new Map<string, number>();
  private readonly muted = new Set<string>();
  master = 1;

  constructor(private readonly meta: SessionMeta) {}

  setVolume(userId: string, volume: number): void {
    this.volumes.set(userId, volume);
  }

  setMuted(userId: string, muted: boolean): void {
    if (muted) this.muted.add(userId);
    else this.muted.delete(userId);
  }

  isMuted(userId: string): boolean {
    return this.muted.has(userId);
  }

  /** Returns the userIds currently talking. */
  tick(clock: ClockState): Set<string> {
    const active = activeSegments(this.meta, clock.time);
    const keep = new Set<string>();
    const talking = new Set<string>();

    for (const { segment, offsetS } of active) {
      keep.add(segment.file);
      talking.add(segment.userId);
      const el = this.element(segment.file);
      el.volume = this.muted.has(segment.userId) || clock.speed > MAX_AUDIBLE_SPEED ? 0 : this.master * (this.volumes.get(segment.userId) ?? 1);
      el.playbackRate = Math.min(Math.max(clock.speed, 0.25), MAX_AUDIBLE_SPEED);
      if (clock.paused) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - offsetS) > MAX_DRIFT_S) el.currentTime = offsetS;
        continue;
      }
      if (el.paused || Math.abs(el.currentTime - offsetS) > MAX_DRIFT_S) el.currentTime = offsetS;
      if (el.paused) void el.play().catch(() => undefined);
    }

    // Preload what is about to start so playback begins on time.
    if (this.meta.gameStartWallMs !== undefined) {
      for (const segment of this.meta.segments) {
        const start = (segment.startWallMs - this.meta.gameStartWallMs) / 1000;
        if (start > clock.time && start - clock.time < PRELOAD_S) {
          keep.add(segment.file);
          this.element(segment.file);
        }
      }
    }

    for (const [file, el] of this.elements) {
      if (keep.has(file)) continue;
      el.pause();
      el.removeAttribute('src');
      el.load();
      this.elements.delete(file);
    }
    return talking;
  }

  stop(): void {
    for (const el of this.elements.values()) {
      el.pause();
      el.removeAttribute('src');
    }
    this.elements.clear();
  }

  private element(file: string): HTMLAudioElement {
    let el = this.elements.get(file);
    if (!el) {
      el = new Audio(`lolrec://session/${encodeURIComponent(this.meta.id)}/${encodeURIComponent(file)}`);
      el.preload = 'auto';
      el.preservesPitch = true;
      this.elements.set(file, el);
    }
    return el;
  }
}
