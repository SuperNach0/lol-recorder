import { OPUS_SILENCE_FRAME } from './ogg-opus-writer.js';

const FRAME_MS = 20;

/**
 * Discord sends nothing while a user is silent, so a naive recording collapses
 * pauses and drifts from real time. GapFiller compares packet arrival times
 * with the number of frames already written and inserts silence frames so the
 * recorded audio stays aligned with the wall clock.
 */
export class GapFiller {
  private startMs: number | undefined;
  private framesOut = 0;

  /** @param toleranceFrames jitter allowed before silence is inserted. */
  constructor(private readonly toleranceFrames = 3) {}

  /** Wall-clock time (ms) of the first packet, i.e. where frame 0 sits. */
  get start(): number | undefined {
    return this.startMs;
  }

  /** Returns the packets to write for a packet that arrived at `arrivalMs`. */
  push(packet: Buffer, arrivalMs: number): Buffer[] {
    if (this.startMs === undefined) this.startMs = arrivalMs;
    const expected = Math.floor((arrivalMs - this.startMs) / FRAME_MS);
    const out: Buffer[] = [];
    const missing = expected - this.framesOut;
    if (missing > this.toleranceFrames) {
      for (let i = 0; i < missing; i++) out.push(OPUS_SILENCE_FRAME);
    }
    out.push(packet);
    this.framesOut += out.length;
    return out;
  }
}
