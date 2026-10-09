const { contextBridge, ipcRenderer } = require('electron');
const channels = [
  'journal:read',
  'accounts:add',
  'accounts:select',
  'accounts:update',
  'accounts:choose-terminal',
  'accounts:launch-terminal',
  'mt5:connect-sync',
  'mt5:positions',
  'mt5:chart',
  'mt5:fx-rate',
  'daily:save',
  'returns:read',
  'mappings:save',
  'csv:import',
  'journal:export',
  'journal:restore',
  'bridge:connect',
  'alerts:add',
  'alerts:delete',
  'alerts:rearm',
  'alerts:preference',
  'alerts:email',
  'trade:annotate',
];
contextBridge.exposeInMainWorld('journal', {
  call: (channel, input) => {
    if (!channels.includes(channel)) throw Error('Unknown channel');
    return ipcRenderer.invoke(channel, input);
  },
  onStatus: (callback) => {
    const listener = (_, status) => callback(status);
    ipcRenderer.on('bridge:status', listener);
    return () => ipcRenderer.removeListener('bridge:status', listener);
  },
  onPriceAlert: (callback) => {
    const listener = (_, alert) => callback(alert);
    ipcRenderer.on('price-alert', listener);
    return () => ipcRenderer.removeListener('price-alert', listener);
  },
  onJournalChanged: (callback) => {
    const listener = (_, change) => callback(change);
    ipcRenderer.on('journal:changed', listener);
    return () => ipcRenderer.removeListener('journal:changed', listener);
  },
});
