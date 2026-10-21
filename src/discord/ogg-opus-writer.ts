import { createWriteStream, type WriteStream } from 'node:fs';

/**
 * Minimal Ogg Opus muxer: writes raw Opus packets (as received from Discord)
 * into a playable .ogg file without re-encoding.
 * Spec: RFC 3533 (Ogg) + RFC 7845 (Opus in Ogg).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(buf: Buffer): number {
  let crc = 0;
  for (const byte of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

/** Samples (at 48 kHz) per 20 ms Opus frame, which is what Discord sends. */
export const SAMPLES_PER_FRAME = 960;

/** An Opus packet that decodes to 20 ms of silence. */
export const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

const HEADER_TYPE_BOS = 0x02;
const HEADER_TYPE_EOS = 0x04;
const MAX_PACKETS_PER_PAGE = 50; // 1 s of audio per page

export class OggOpusWriter {
  private readonly out: WriteStream;
  private readonly serial = (Math.random() * 0xffffffff) >>> 0;
  private sequence = 0;
  private granule = 0n;
  private pending: Buffer[] = [];
  private closed = false;

  constructor(path: string, private readonly channels = 2) {
    this.out = createWriteStream(path);
    this.writePage([this.opusHead()], HEADER_TYPE_BOS, 0n);
    this.writePage([this.opusTags()], 0, 0n);
  }

  write(packet: Buffer): void {
    if (this.closed) throw new Error('OggOpusWriter already closed');
    this.pending.push(packet);
    this.granule += BigInt(SAMPLES_PER_FRAME);
    if (this.pending.length >= MAX_PACKETS_PER_PAGE) this.flush(0);
  }

  /** Number of 20 ms frames written so far. */
  get frames(): number {
    return Number(this.granule / BigInt(SAMPLES_PER_FRAME));
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.flush(HEADER_TYPE_EOS, true);
    return new Promise((resolve, reject) => {
      this.out.once('error', reject);
      this.out.end(resolve);
    });
  }

  private flush(headerType: number, force = false): void {
    if (this.pending.length === 0 && !force) return;
    this.writePage(this.pending, headerType, this.granule);
    this.pending = [];
  }

  private opusHead(): Buffer {
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head.writeUInt8(1, 8); // version
    head.writeUInt8(this.channels, 9);
    head.writeUInt16LE(312, 10); // pre-skip, libopus default
    head.writeUInt32LE(48000, 12);
    head.writeInt16LE(0, 16); // output gain
    head.writeUInt8(0, 18); // channel mapping family
    return head;
  }

  private opusTags(): Buffer {
    const vendor = Buffer.from('lol-recorder', 'utf8');
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write('OpusTags', 0, 'ascii');
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length);
    return tags;
  }

  private writePage(packets: Buffer[], headerType: number, granule: bigint): void {
    const lacing: number[] = [];
    for (const p of packets) {
      let len = p.length;
      while (len >= 255) {
        lacing.push(255);
        len -= 255;
      }
      lacing.push(len);
    }
    const header = Buffer.alloc(27 + lacing.length);
    header.write('OggS', 0, 'ascii');
    header.writeUInt8(0, 4);
    header.writeUInt8(headerType, 5);
    header.writeBigUInt64LE(granule, 6);
    header.writeUInt32LE(this.serial, 14);
    header.writeUInt32LE(this.sequence++, 18);
    header.writeUInt32LE(0, 22); // CRC placeholder
    header.writeUInt8(lacing.length, 26);
    Buffer.from(lacing).copy(header, 27);
    const page = Buffer.concat([header, ...packets]);
    page.writeUInt32LE(oggCrc(page), 22);
    this.out.write(page);
  }
}
