import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Settings {
  /** Bot token, encrypted with the Windows user's credentials (DPAPI). */
  tokenEncrypted?: string;
  applicationId?: string;
  botName?: string;
  ownerId?: string;
  lolDir: string;
  sessionsDir: string;
}

const file = () => join(app.getPath('userData'), 'settings.json');

export function defaultSettings(): Settings {
  return {
    lolDir: 'C:\\Riot Games\\League of Legends',
    sessionsDir: join(app.getPath('documents'), 'LoL Recorder'),
  };
}

export function loadSettings(): Settings {
  const settings = defaultSettings();
  if (existsSync(file())) Object.assign(settings, JSON.parse(readFileSync(file(), 'utf8')));
  mkdirSync(settings.sessionsDir, { recursive: true });
  return settings;
}

export function saveSettings(settings: Settings): void {
  writeFileSync(file(), JSON.stringify(settings, null, 2));
}

export function encryptToken(token: string): string {
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token).toString('base64') : `plain:${token}`;
}

export function decryptToken(settings: Settings): string | undefined {
  const value = settings.tokenEncrypted;
  if (!value) return undefined;
  if (value.startsWith('plain:')) return value.slice(6);
  return safeStorage.decryptString(Buffer.from(value, 'base64'));
}
