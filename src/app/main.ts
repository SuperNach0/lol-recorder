import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, shell, Tray } from 'electron';
import { readdir } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RecorderService } from '../core/recorder-service.js';
import { loadSession } from '../session/session.js';
import { getPlayback, setPlayback } from '../lol/game-client.js';
import { LcuClient, readLockfile } from '../lol/lcu.js';
import { decryptToken, encryptToken, loadSettings, saveSettings, type Settings } from './settings.js';
import { enableReplayApi, isReplayApiEnabled } from './game-config.js';
import { checkToken } from './discord-app.js';
import { inviteUrl } from '../core/recorder-service.js';
import type { PublicSettings, SessionListItem } from './ipc-types.js';

/** Audio files are served to the renderer as lolrec://session/<sessionId>/<file>. */
protocol.registerSchemesAsPrivileged([{ scheme: 'lolrec', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

const iconPath = join(__dirname, 'icon.png');
let settings: Settings;
let service: RecorderService | undefined;
let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function publicSettings(): PublicSettings {
  return {
    configured: !!settings.tokenEncrypted,
    botName: settings.botName,
    inviteUrl: settings.applicationId ? inviteUrl(settings.applicationId) : undefined,
    lolDir: settings.lolDir,
    sessionsDir: settings.sessionsDir,
    replayApi: isReplayApiEnabled(settings.lolDir),
  };
}

function lockfilePath(): string {
  return join(settings.lolDir, 'lockfile');
}

async function startService(): Promise<void> {
  await service?.stop();
  service = undefined;
  const token = decryptToken(settings);
  if (!token) return;
  service = new RecorderService({ token, sessionsRoot: settings.sessionsDir, ownerId: settings.ownerId, lockfile: lockfilePath() });
  service.on('status', (s) => {
    send('status', s);
    updateTray();
  });
  service.on('log', (line: string) => send('log', `${new Date().toLocaleTimeString('fr-FR')}  ${line}`));
  service.on('session', () => send('sessions-changed'));
  await service.start().catch((e: Error) => send('log', `Connexion Discord impossible : ${e.message}`));
}

async function listSessions(): Promise<SessionListItem[]> {
  const entries = await readdir(settings.sessionsDir, { withFileTypes: true }).catch(() => []);
  const metas = await Promise.all(
    entries.filter((e) => e.isDirectory()).map((e) => loadSession(join(settings.sessionsDir, e.name)).catch(() => undefined)),
  );
  const lcu = await readLockfile(lockfilePath()).then((c) => new LcuClient(c)).catch(() => undefined);
  const items = await Promise.all(
    metas
      .filter((m) => m !== undefined)
      .map(async (meta) => ({
        meta,
        replayState: meta.gameId && lcu ? (await lcu.replayMetadata(meta.gameId).catch(() => undefined))?.state : undefined,
      })),
  );
  return items.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
}

async function lcu(): Promise<LcuClient> {
  try {
    return new LcuClient(await readLockfile(lockfilePath()));
  } catch {
    throw new Error('Le client League of Legends doit être ouvert.');
  }
}

/** Polls the replay clock while the player view is open. */
let followTimer: NodeJS.Timeout | undefined;
function followReplay(enabled: boolean): void {
  if (followTimer) clearInterval(followTimer);
  followTimer = undefined;
  if (!enabled) return;
  let busy = false;
  followTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    send('playback', await getPlayback().catch(() => null));
    busy = false;
  }, 100);
}

function registerIpc(): void {
  ipcMain.handle('getSettings', () => publicSettings());
  ipcMain.handle('checkToken', (_e, token: string) => checkToken(token));
  ipcMain.handle('saveToken', async (_e, token: string) => {
    const identity = await checkToken(token);
    Object.assign(settings, {
      tokenEncrypted: encryptToken(token.trim()),
      applicationId: identity.applicationId,
      botName: identity.botName,
      ownerId: identity.ownerId,
    });
    saveSettings(settings);
    await startService();
    return publicSettings();
  });
  ipcMain.handle('setLolDir', async () => {
    const result = await dialog.showOpenDialog(win!, { title: 'Dossier de League of Legends', defaultPath: settings.lolDir, properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths[0]) {
      settings.lolDir = result.filePaths[0];
      saveSettings(settings);
      await startService();
    }
    return publicSettings();
  });
  ipcMain.handle('enableReplayApi', () => {
    enableReplayApi(settings.lolDir);
    return publicSettings();
  });
  ipcMain.handle('openExternal', (_e, url: string) => {
    if (/^https:\/\/(discord\.com|github\.com)\//.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('openSessionsFolder', () => shell.openPath(settings.sessionsDir));

  ipcMain.handle('getStatus', () => service?.status ?? { discord: 'offline', lol: 'unknown' });
  ipcMain.handle('startRecording', () => service?.startForOwner() ?? false);
  ipcMain.handle('stopRecording', () => service?.stopRecording());

  ipcMain.handle('listSessions', () => listSessions());
  ipcMain.handle('getSession', (_e, id: string) => loadSession(join(settings.sessionsDir, id)));
  ipcMain.handle('watchReplay', async (_e, gameId: number) => (await lcu()).watchReplay(gameId));
  ipcMain.handle('downloadReplay', async (_e, gameId: number) => (await lcu()).downloadReplay(gameId));
  ipcMain.handle('seekReplay', async (_e, time: number) => void (await setPlayback({ time })));
  ipcMain.handle('setReplayPaused', async (_e, paused: boolean) => void (await setPlayback({ paused })));
  ipcMain.handle('followReplay', (_e, enabled: boolean) => followReplay(enabled));
}

function registerAudioProtocol(): void {
  protocol.handle('lolrec', (request) => {
    const url = new URL(request.url);
    const [sessionId, file] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const root = normalize(settings.sessionsDir + sep);
    const path = normalize(join(settings.sessionsDir, sessionId ?? '', file ?? ''));
    if (url.host !== 'session' || !path.startsWith(root) || !path.endsWith('.ogg')) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path).toString(), { headers: request.headers });
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'LoL Recorder',
    icon: iconPath,
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Closing the window keeps the bot recording in the tray.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
}

function showWindow(): void {
  if (!win) return createWindow();
  win.show();
  win.focus();
}

function updateTray(): void {
  if (!tray) return;
  const recording = service?.status.recording;
  tray.setToolTip(recording ? `LoL Recorder : enregistrement de #${recording.channelName}` : 'LoL Recorder');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir LoL Recorder', click: showWindow },
      recording
        ? { label: "Arrêter l'enregistrement", click: () => void service?.stopRecording() }
        : { label: 'Enregistrer mon salon vocal', click: () => void service?.startForOwner() },
      { type: 'separator' },
      { label: 'Quitter', click: () => app.quit() },
    ]),
  );
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', (e) => {
  if (!service) return;
  // Finalize open audio files before exiting.
  e.preventDefault();
  const s = service;
  service = undefined;
  void s.stop().finally(() => app.quit());
});

app.whenReady().then(async () => {
  settings = loadSettings();
  registerIpc();
  registerAudioProtocol();
  createWindow();
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  updateTray();
  await startService();
});
