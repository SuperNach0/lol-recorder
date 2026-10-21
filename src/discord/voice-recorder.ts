import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { EndBehaviorType, type AudioReceiveStream, type VoiceConnection } from '@discordjs/voice';
import { GapFiller } from './gap-filler.js';
import { OggOpusWriter } from './ogg-opus-writer.js';
import type { Segment } from '../session/session.js';

/** Silence after which a speech segment is closed and a new file starts. */
const SEGMENT_END_SILENCE_MS = 2000;

/** One open audio file for one user. */
interface OpenSegment {
  writer: OggOpusWriter;
  filler: GapFiller;
  file: string;
  lastPacketMs: number;
}

/**
 * Records every user of a voice connection to their own Ogg Opus files, one
 * file per stretch of speech, each tagged with the wall-clock time of its
 * first frame. Emits `segment` when a file is complete and `warn` (message)
 * when a user's audio stream fails (it is re-subscribed automatically).
 */
export class VoiceRecorder extends EventEmitter {
  private readonly streams = new Map<string, AudioReceiveStream>();
  private readonly open = new Map<string, OpenSegment>();
  private readonly closing = new Set<Promise<void>>();
  private readonly onSpeakingStart = (userId: string) => this.subscribe(userId);
  private readonly idleTimer: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly connection: VoiceConnection,
    private readonly dir: string,
    private readonly ignoredUsers: ReadonlySet<string> = new Set(),
    private readonly now: () => number = Date.now,
  ) {
    super();
    connection.receiver.speaking.on('start', this.onSpeakingStart);
    this.idleTimer = setInterval(() => this.closeIdleSegments(), 250);
  }

  /** One long-lived subscription per user; segments are cut on silence here. */
  private subscribe(userId: string): void {
    if (this.stopped || this.streams.has(userId) || this.ignoredUsers.has(userId)) return;
    const stream = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    this.streams.set(userId, stream);
    stream.on('data', (packet: Buffer) => this.onPacket(userId, packet));
    stream.on('error', (err: Error) => this.emit('warn', `Flux audio de ${userId} interrompu : ${err.message}`));
    stream.once('close', () => {
      this.streams.delete(userId);
      this.closeSegment(userId);
      // The receiver destroys a stream when a packet fails to decrypt: listen again right away.
      if (!this.stopped) setImmediate(() => this.subscribe(userId));
    });
  }

  private onPacket(userId: string, packet: Buffer): void {
    const now = this.now();
    let seg = this.open.get(userId);
    if (seg && now - seg.lastPacketMs > SEGMENT_END_SILENCE_MS) {
      this.closeSegment(userId);
      seg = undefined;
    }
    if (!seg) {
      const file = `${userId}-${now}.ogg`;
      seg = { writer: new OggOpusWriter(join(this.dir, file)), filler: new GapFiller(), file, lastPacketMs: now };
      this.open.set(userId, seg);
    }
    seg.lastPacketMs = now;
    for (const p of seg.filler.push(packet, now)) seg.writer.write(p);
  }

  private closeIdleSegments(): void {
    const now = this.now();
    for (const [userId, seg] of this.open) if (now - seg.lastPacketMs > SEGMENT_END_SILENCE_MS) this.closeSegment(userId);
  }

  private closeSegment(userId: string): void {
    const seg = this.open.get(userId);
    if (!seg) return;
    this.open.delete(userId);
    const done = seg.writer.close().then(() => {
      const segment: Segment = { userId, startWallMs: seg.filler.start!, durationMs: seg.writer.frames * 20, file: seg.file };
      this.emit('segment', segment);
    });
    this.closing.add(done);
    void done.finally(() => this.closing.delete(done));
  }

  /** Stops listening and waits for every open file to be finalized. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.idleTimer);
    this.connection.receiver.speaking.off('start', this.onSpeakingStart);
    for (const stream of this.streams.values()) stream.destroy();
    for (const userId of [...this.open.keys()]) this.closeSegment(userId);
    await Promise.all([...this.closing]);
  }
}
