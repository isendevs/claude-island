// A small, safe bridge: the page can only call these functions,
// not Node.js or Electron directly.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("island", {
  onUpdate: (callback) => ipcRenderer.on("island:update", (_e, state) => callback(state)),
  setHover: (hovering) => ipcRenderer.send("island:hover", hovering),
  quit: () => ipcRenderer.send("island:quit"),
  decide: (reqId, behavior) => ipcRenderer.send("island:decide", reqId, behavior),
  archive: (id) => ipcRenderer.send("island:archive", id),
  copyResume: (id) => ipcRenderer.send("island:copy-resume", id),
});
