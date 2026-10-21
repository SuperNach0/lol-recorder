import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Api } from './ipc-types.js';

function subscribe<T>(channel: string) {
  return (cb: (value: T) => void) => {
    const listener = (_e: IpcRendererEvent, value: T) => cb(value);
    ipcRenderer.on(channel, listener);
    return () => void ipcRenderer.off(channel, listener);
  };
}

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

const api: Api = {
  getSettings: invoke('getSettings'),
  checkToken: invoke('checkToken'),
  saveToken: invoke('saveToken'),
  setLolDir: invoke('setLolDir'),
  enableReplayApi: invoke('enableReplayApi'),
  openExternal: invoke('openExternal'),
  openSessionsFolder: invoke('openSessionsFolder'),
  getStatus: invoke('getStatus'),
  startRecording: invoke('startRecording'),
  stopRecording: invoke('stopRecording'),
  onStatus: subscribe('status'),
  onLog: subscribe('log'),
  onSessionsChanged: subscribe('sessions-changed'),
  listSessions: invoke('listSessions'),
  getSession: invoke('getSession'),
  watchReplay: invoke('watchReplay'),
  downloadReplay: invoke('downloadReplay'),
  seekReplay: invoke('seekReplay'),
  setReplayPaused: invoke('setReplayPaused'),
  followReplay: invoke('followReplay'),
  onPlayback: subscribe('playback'),
};

contextBridge.exposeInMainWorld('api', api);
