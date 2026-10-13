// Electron "main process": creates the floating window and gathers the data.
// The window itself (index.html) only draws what this file sends it.

const { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { collect } = require("./data");
const { startLiveServer } = require("./live");

const WIN_WIDTH = 440;
const WIN_HEIGHT = 560; // Tall enough for the expanded panel with a full session list.
const POLL_MS = 1500;

let win = null;
let live = null;
const archived = new Map(); // session id -> time you archived it

// ---------- Window ----------

function createWindow() {
  // Use the full screen edge (bounds), not workArea, so the notch touches the very top.
  const { bounds } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: Math.round(bounds.x + (bounds.width - WIN_WIDTH) / 2),
    y: bounds.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false, // Never steal keyboard focus from the app you're using.
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  // "screen-saver" is the highest level, so it stays above maximized windows.
  win.setAlwaysOnTop(true, "screen-saver");
  // The window is bigger than the notch. Let clicks pass through the empty
  // parts; "forward" still tells the page where the mouse is, so it can
  // turn clicks back on when you hover the notch.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile("index.html");
}

// ---------- Helper scripts ----------

// Claude Code runs hook.js and statusline.js with your own Node.js, so they
// must be plain files on disk (not packed inside the app). Copy them to a
// fixed place that ~/.claude/settings.json points to. Running this on every
// start means app updates reach the scripts too.
function installHelpers() {
  const binDir = path.join(os.homedir(), ".claude", "island", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ["hook.js", "statusline.js"]) {
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    const target = path.join(binDir, name);
    let current = null;
    try {
      current = fs.readFileSync(target, "utf8");
    } catch {}
    if (current !== source) fs.writeFileSync(target, source);
  }
}

// ---------- Sending data to the window ----------

let lastSent = "";
function tick() {
  if (!win) return;
  const state = collect(live.sessions());
  // An archived session stays hidden until it does something new.
  state.sessions = state.sessions.filter((s) => {
    const at = archived.get(s.id);
    return !at || s.updatedAt > at || s.pending.length > 0;
  });
  const json = JSON.stringify(state);
  if (json !== lastSent) {
    lastSent = json;
    win.webContents.send("island:update", state);
  }
}

// ---------- Messages from the window ----------

ipcMain.on("island:hover", (_e, hovering) => {
  win?.setIgnoreMouseEvents(!hovering, { forward: true });
});
ipcMain.on("island:quit", () => app.quit());
ipcMain.on("island:decide", (_e, reqId, behavior) => live?.decide(reqId, behavior));
ipcMain.on("island:archive", (_e, id) => {
  archived.set(id, Date.now());
  tick();
});
ipcMain.on("island:copy-resume", (_e, id) => {
  // Session ids are UUIDs; refuse anything else so the clipboard never gets odd text.
  if (/^[0-9a-f-]{36}$/i.test(id)) clipboard.writeText(`claude --resume ${id}`);
});

// Only allow one island at a time.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    installHelpers();
    // The installed app starts with Windows. (Not while developing with npm start.)
    // Only register once: re-registering on every launch would undo it if you
    // turned it off in Task Manager > Startup apps.
    const firstRunMarker = path.join(app.getPath("userData"), "startup-registered");
    if (app.isPackaged && !fs.existsSync(firstRunMarker)) {
      app.setLoginItemSettings({ openAtLogin: true });
      fs.writeFileSync(firstRunMarker, new Date().toISOString());
    }

    // Only answer permission requests while the island is on screen.
    live = startLiveServer({ onChange: tick, acceptingPermissions: () => !!win?.isVisible() });
    createWindow();
    win.webContents.on("did-finish-load", () => {
      lastSent = "";
      tick();
    });
    setInterval(tick, POLL_MS);

    globalShortcut.register("Control+Alt+I", () => {
      if (win.isVisible()) {
        win.hide();
        live.releaseAll(); // Hand waiting questions back to Claude's normal prompt.
      } else {
        win.showInactive();
      }
    });
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    live?.close();
  });
}
