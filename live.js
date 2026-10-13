// A tiny private web server that receives events from hook.js and keeps a
// live picture of every session: working, waiting for permission, or idle.
//
// Security: it only listens on 127.0.0.1 (this PC), and every request must
// carry a secret token that is regenerated each time the island starts.
// Browsers can't send that custom header to another site without asking
// first, and we never answer those "asking first" (CORS preflight) requests.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { summarizeTool } = require("./data");

const ISLAND_DIR = path.join(os.homedir(), ".claude", "island");
const SERVER_FILE = path.join(ISLAND_DIR, "server.json");
const MAX_BODY_BYTES = 1024 * 1024;

function startLiveServer({ onChange, acceptingPermissions }) {
  const token = crypto.randomBytes(32).toString("hex");
  const sessions = new Map(); // session id -> live session
  const waiters = new Map(); // permission request id -> { sessionId, res }

  function session(event) {
    let s = sessions.get(event.session_id);
    if (!s) {
      s = { id: event.session_id, cwd: event.cwd, title: null, status: "idle", preview: null, pending: [], updatedAt: Date.now() };
      sessions.set(s.id, s);
    }
    if (event.cwd) s.cwd = event.cwd;
    s.updatedAt = Date.now();
    return s;
  }

  // Answer a waiting permission hook. behavior: "allow", "deny", or null (= "stay silent").
  function settle(reqId, behavior) {
    const waiter = waiters.get(reqId);
    if (!waiter) return;
    waiters.delete(reqId);
    const s = sessions.get(waiter.sessionId);
    if (s) s.pending = s.pending.filter((p) => p.reqId !== reqId);
    if (!waiter.res.writableEnded) waiter.res.end(JSON.stringify({ behavior }));
  }

  // The question was answered somewhere else (terminal, desktop app) or became moot.
  function clearPending(s, match = () => true) {
    for (const p of [...s.pending]) if (match(p)) settle(p.reqId, null);
  }

  function apply(event, res) {
    const s = session(event);
    const name = event.hook_event_name;

    if (name === "SessionStart") {
      if (event.session_title) s.title = event.session_title;
      s.status = "idle";
    } else if (name === "UserPromptSubmit") {
      clearPending(s);
      s.status = "working";
      s.preview = { tool: null, text: event.prompt || "" };
    } else if (name === "PreToolUse") {
      // Note: PreToolUse arrives BEFORE the permission request for the same tool,
      // and tools can run in parallel, so it must not clear pending requests.
      if (s.pending.length === 0) s.status = "working";
      s.preview = { tool: event.tool_name, text: summarizeTool(event.tool_name, event.tool_input) };
    } else if (name === "PostToolUse") {
      // If a tool we were asking about just ran, it was approved elsewhere.
      const input = JSON.stringify(event.tool_input);
      clearPending(s, (p) => p.tool === event.tool_name && p.inputKey === input);
      if (s.pending.length === 0) s.status = "working";
    } else if (name === "PermissionRequest") {
      s.status = "waiting";
      s.preview = { tool: event.tool_name, text: summarizeTool(event.tool_name, event.tool_input) };
      if (acceptingPermissions()) {
        const reqId = crypto.randomUUID();
        s.pending.push({
          reqId,
          tool: event.tool_name,
          summary: summarizeTool(event.tool_name, event.tool_input),
          inputKey: JSON.stringify(event.tool_input),
        });
        waiters.set(reqId, { sessionId: s.id, res });
        // hook.js gave up waiting (timeout or Claude cancelled): forget the request.
        res.on("close", () => {
          if (waiters.has(reqId)) {
            waiters.delete(reqId);
            s.pending = s.pending.filter((p) => p.reqId !== reqId);
            onChange();
          }
        });
        return true; // Keep the connection open until you click Allow or Deny.
      }
    } else if (name === "Notification") {
      if (event.notification_type === "permission_prompt") s.status = "waiting";
      else if (event.notification_type === "idle_prompt") s.status = "idle";
    } else if (name === "Stop") {
      clearPending(s);
      s.status = "idle";
      if (event.last_assistant_message) s.preview = { tool: null, text: event.last_assistant_message };
    } else if (name === "SessionEnd") {
      clearPending(s);
      s.status = "ended";
    }
    return false;
  }

  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const given = Buffer.from(String(req.headers["x-island-token"] || ""));
    const expected = Buffer.from(token);
    const tokenOk = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    // Checking the Host header blocks "DNS rebinding" tricks from websites.
    const hostOk = req.headers.host === `127.0.0.1:${port}`;
    if (req.method !== "POST" || req.url !== "/hook" || !tokenOk || !hostOk) {
      res.writeHead(403).end();
      return;
    }

    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      let event;
      try {
        event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!event?.session_id || !event.hook_event_name) {
        res.writeHead(400).end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      console.log(`[hook] ${event.hook_event_name} ${event.tool_name || ""} session=${event.session_id.slice(0, 8)}`);
      const waiting = apply(event, res);
      if (!waiting) res.end("{}");
      onChange();
    });
  });

  server.listen(0, "127.0.0.1", () => {
    // Tell hook.js where we are. Written atomically so it never reads half a file.
    fs.mkdirSync(ISLAND_DIR, { recursive: true });
    const tmp = `${SERVER_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ port: server.address().port, token, pid: process.pid }));
    fs.renameSync(tmp, SERVER_FILE);
  });

  return {
    sessions: () => [...sessions.values()],
    decide(reqId, behavior) {
      const waiter = waiters.get(reqId);
      if (!waiter || (behavior !== "allow" && behavior !== "deny")) return;
      const s = sessions.get(waiter.sessionId);
      settle(reqId, behavior);
      if (s && s.pending.length === 0) s.status = behavior === "allow" ? "working" : "idle";
      onChange();
    },
    // Hidden island: hand every waiting question back to Claude's normal prompt.
    releaseAll() {
      for (const reqId of [...waiters.keys()]) settle(reqId, null);
      onChange();
    },
    close() {
      for (const reqId of [...waiters.keys()]) settle(reqId, null);
      server.close();
      try {
        // Only remove the file if it's still ours (a newer island may have replaced it).
        const saved = JSON.parse(fs.readFileSync(SERVER_FILE, "utf8"));
        if (saved.token === token) fs.unlinkSync(SERVER_FILE);
      } catch {}
    },
  };
}

module.exports = { startLiveServer };
