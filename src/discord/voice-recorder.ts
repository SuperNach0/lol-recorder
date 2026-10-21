import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { EndBehaviorType, type VoiceConnection } from '@discordjs/voice';
import { GapFiller } from './gap-filler.js';
import { OggOpusWriter } from './ogg-opus-writer.js';
import type { Segment } from '../session/session.js';

/** Silence after which a speech segment is closed and a new file starts. */
const SEGMENT_END_SILENCE_MS = 2000;

/**
 * Records every user of a voice connection to their own Ogg Opus files, one
 * file per stretch of speech, each tagged with the wall-clock time of its
 * first frame. Emits `segment` when a file is complete.
 */
export class VoiceRecorder extends EventEmitter {
  private readonly active = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly onSpeakingStart = (userId: string) => this.startSegment(userId);
  private stopped = false;

  constructor(
    private readonly connection: VoiceConnection,
    private readonly dir: string,
    private readonly ignoredUsers: ReadonlySet<string> = new Set(),
  ) {
    super();
    connection.receiver.speaking.on('start', this.onSpeakingStart);
  }

  private startSegment(userId: string): void {
    if (this.stopped || this.active.has(userId) || this.ignoredUsers.has(userId)) return;
    this.active.add(userId);

    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SEGMENT_END_SILENCE_MS },
    });
    const filler = new GapFiller();
    let writer: OggOpusWriter | undefined;
    let file = '';

    stream.on('data', (packet: Buffer) => {
      const now = Date.now();
      if (!writer) {
        file = `${userId}-${now}.ogg`;
        writer = new OggOpusWriter(join(this.dir, file));
      }
      for (const p of filler.push(packet, now)) writer.write(p);
    });

    const done = new Promise<void>((resolve) => {
      stream.once('close', async () => {
        this.active.delete(userId);
        if (writer && filler.start !== undefined) {
          await writer.close();
          const segment: Segment = { userId, startWallMs: filler.start, durationMs: writer.frames * 20, file };
          this.emit('segment', segment);
        }
        resolve();
      });
    });
    this.pending.add(done);
    void done.finally(() => this.pending.delete(done));
  }

  /** Stops listening and waits for every open file to be finalized. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.connection.receiver.speaking.off('start', this.onSpeakingStart);
    for (const stream of this.connection.receiver.subscriptions.values()) stream.destroy();
    await Promise.all([...this.pending]);
  }
}
