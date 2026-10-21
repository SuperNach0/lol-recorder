import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The Replay API is off unless `EnableReplayApi=1` is set in game.cfg. */
export function gameCfgPath(lolDir: string): string {
  return join(lolDir, 'Config', 'game.cfg');
}

export function isReplayApiEnabled(lolDir: string): boolean | undefined {
  const path = gameCfgPath(lolDir);
  if (!existsSync(path)) return undefined;
  return /^\s*EnableReplayApi\s*=\s*1\s*$/im.test(readFileSync(path, 'utf8'));
}

export function withReplayApiEnabled(cfg: string): string {
  const eol = cfg.includes('\r\n') ? '\r\n' : '\n';
  const existing = /^[ \t]*EnableReplayApi[ \t]*=[^\r\n]*/im;
  if (existing.test(cfg)) return cfg.replace(existing, 'EnableReplayApi=1');
  const general = /^(\[General\])[ \t]*(\r?)$/im;
  if (general.test(cfg)) return cfg.replace(general, `$1${eol}EnableReplayApi=1$2`);
  return `[General]${eol}EnableReplayApi=1${eol}${cfg}`;
}

export function enableReplayApi(lolDir: string): void {
  const path = gameCfgPath(lolDir);
  if (!existsSync(path)) throw new Error(`Fichier introuvable : ${path}`);
  writeFileSync(path, withReplayApiEnabled(readFileSync(path, 'utf8')));
}
