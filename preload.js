const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bping', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveCreds: (c) => ipcRenderer.invoke('creds:save', c),
  startAuth: () => ipcRenderer.invoke('auth:start'),
  cancelAuth: () => ipcRenderer.invoke('auth:cancel'),
  notify: (opts) => ipcRenderer.invoke('notify:show', opts),
  onNotifyClick: (cb) => ipcRenderer.on('notify-clicked', (_e, p) => cb(p)),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  setAccount: (a) => ipcRenderer.invoke('account:set', a),
  getPings: (opts) => ipcRenderer.invoke('pings:list', opts),
  signOut: () => ipcRenderer.invoke('signout'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  isFocused: () => ipcRenderer.invoke('app:focused'),
  onFocusChanged: (cb) => ipcRenderer.on('focus-changed', (_e, focused) => cb(!!focused)),
  onMessageSent: (cb) => ipcRenderer.on('message-sent', () => cb()),
  // Forward / Copy feature
  listBookmarks: (bucket, chat) => ipcRenderer.invoke('bookmarks:list', { bucket, chat }),
  deleteBookmark: (bookmarkUrl) => ipcRenderer.invoke('bookmark:delete', { bookmarkUrl }),
  listPeople: () => ipcRenderer.invoke('people:list'),
  sendLine: (bucket, chat, html) => ipcRenderer.invoke('api:send-line', { bucket, chat, html }),
  writeClipboard: (text, html) => ipcRenderer.invoke('clipboard:write', { text, html }),
});
