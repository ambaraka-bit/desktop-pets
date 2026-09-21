// preload.js — the only bridge between each window's page (isolated main
// world) and Electron/Node.
//
// With contextIsolation:true, renderer code can NO LONGER call require() —
// a compromised howler/peerjs/renderer script can't reach fs, child_process,
// or the network stack. All the renderers get is `window.api`, a whitelisted
// passthrough to ipcRenderer. Channels must be listed below or the call is
// dropped/rejected.

const { contextBridge, ipcRenderer } = require('electron');

// Renderer → main, one-way (fire-and-forget).
const SEND_CHANNELS = new Set([
  'settings-changed',
  'set-mouse-ignore',
  'pets-changed',
  'copy-to-clipboard',
  'friends:connect-request',
  'friends:disconnect-request',
  'friends:recall-request',
  'friends:send-home-request',
  'friends:request-status',
  'friends:status-update'
]);

// Renderer → main, request/response (returns a Promise).
const INVOKE_CHANNELS = new Set(['species:scan', 'generate-peer-code', 'show-confirm-dialog']);

// main → renderer events the page may subscribe to.
const RECEIVE_CHANNELS = new Set([
  'display-info',
  'restore-settings',
  'set-paused',
  'add-pet',
  'remove-pet',
  'apply-settings',
  'foreground-window',
  'friends:connect-request',
  'friends:disconnect-request',
  'friends:recall-request',
  'friends:send-home-request',
  'friends:request-status',
  'friends:status-update',
  'init-settings-values',
  'settings-roster-update'
]);

contextBridge.exposeInMainWorld('api', {
  send(channel, ...args) {
    if (!SEND_CHANNELS.has(channel)) {
      console.warn(`[preload] blocked send to "${channel}"`);
      return;
    }
    ipcRenderer.send(channel, ...args);
  },
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.has(channel)) {
      console.warn(`[preload] blocked invoke of "${channel}"`);
      return Promise.reject(new Error(`[preload] blocked invoke channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, listener) {
    if (!RECEIVE_CHANNELS.has(channel)) {
      console.warn(`[preload] blocked subscribe to "${channel}"`);
      return () => {};
    }
    const wrapped = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});

// Renderer debug-log gating: sandboxed renderers have no `process`, so the
// sole fact it needs from the main world is whether DP_DEBUG is set. Nothing
// else from process.env is exposed.
contextBridge.exposeInMainWorld('__dpDebug', () => process.env.DP_DEBUG === '1');
