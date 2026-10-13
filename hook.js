#!/usr/bin/env node
// Claude Code hook script. Claude Code runs this at key moments (prompt sent,
// tool used, permission needed, reply finished...) and pipes the event as JSON.
// We forward it to the island app. For permission requests we wait for your
// Allow/Deny click and hand the answer back to Claude Code.
//
// Golden rule: if anything goes wrong (island closed, hidden, no answer in
// time), print NOTHING and exit 0. Claude Code then carries on normally,
// showing its usual permission prompt.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const SERVER_FILE = path.join(os.homedir(), ".claude", "island", "server.json");
const QUICK_TIMEOUT_MS = 800; // Normal events: never slow Claude down.
const PERMISSION_TIMEOUT_MS = 290 * 1000; // Must stay under the hook timeout in settings.json (300s).

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => resolve(raw));
  });
}

function post(server, body, timeoutMs) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: "/hook",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
          "X-Island-Token": server.token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null)); // Island not running: stay silent.
    req.end(data);
  });
}

async function main() {
  const event = JSON.parse(await readStdin());
  const server = JSON.parse(fs.readFileSync(SERVER_FILE, "utf8"));
  const isPermission = event.hook_event_name === "PermissionRequest";
  const reply = await post(server, event, isPermission ? PERMISSION_TIMEOUT_MS : QUICK_TIMEOUT_MS);

  if (!isPermission || !reply) return;
  if (reply.behavior === "allow") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    }));
  } else if (reply.behavior === "deny") {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied from Claude Island." },
      },
    }));
  }
  // Any other reply (e.g. answered elsewhere): print nothing.
}

// No process.exit(): it could cut off the answer before Claude Code reads it.
// The script ends by itself once stdout is flushed.
main().catch(() => {});
