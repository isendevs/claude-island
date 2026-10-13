// End-to-end tests for hook.js + live.js + data.js.
// Runs hook.js as a real separate process, like Claude Code does.
// Uses a throwaway home folder, so your real ~/.claude is never touched.
// Run: npm test

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// Point "home" at a temp folder BEFORE loading our modules: they read it on load.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "claude-island-test-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

const ISLAND = path.join(__dirname, "..");
const { startLiveServer } = require(path.join(ISLAND, "live.js"));
const { collect } = require(path.join(ISLAND, "data.js"));
const HOOK = path.join(ISLAND, "hook.js");
const SERVER_FILE = path.join(os.homedir(), ".claude", "island", "server.json");

let accepting = true;
let changes = 0;
const live = startLiveServer({ onChange: () => changes++, acceptingPermissions: () => accepting });
const SID = "11111111-2222-3333-4444-555555555555";

function runHook(event) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [HOOK], { env: process.env });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
    p.stdin.end(JSON.stringify({ session_id: SID, cwd: "C:/code/shannela", ...event }));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sess = () => live.sessions().find((s) => s.id === SID);
async function waitForPending() {
  for (let i = 0; i < 100 && !(sess()?.pending.length); i++) await wait(20);
  return sess().pending[0];
}

(async () => {
  while (!fs.existsSync(SERVER_FILE)) await wait(20);

  let r = await runHook({ hook_event_name: "SessionStart", source: "startup", session_title: "Fix checkout bug" });
  assert.strictEqual(r.out, "", "SessionStart must print nothing (it would be added to Claude's context)");
  assert.strictEqual(sess().title, "Fix checkout bug");
  console.log(`ok  SessionStart sets title (${r.ms} ms)`);

  r = await runHook({ hook_event_name: "UserPromptSubmit", prompt: "fix the cart" });
  assert.strictEqual(r.out, "");
  assert.strictEqual(sess().status, "working");
  console.log("ok  UserPromptSubmit -> working, prints nothing");

  // Allow
  const input = { file_path: "C:/code/shannela/cart.ts", content: "x" };
  let hookRun = runHook({ hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: input });
  let p = await waitForPending();
  assert.strictEqual(sess().status, "waiting");
  assert.strictEqual(p.summary, "cart.ts");
  live.decide(p.reqId, "allow");
  r = await hookRun;
  assert.deepStrictEqual(JSON.parse(r.out).hookSpecificOutput.decision, { behavior: "allow" });
  assert.strictEqual(sess().pending.length, 0);
  console.log("ok  PermissionRequest -> Allow click -> hook prints allow");

  // Deny
  hookRun = runHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf dist", description: "Clean build" } });
  p = await waitForPending();
  assert.strictEqual(p.summary, "Clean build");
  live.decide(p.reqId, "deny");
  r = await hookRun;
  const d = JSON.parse(r.out).hookSpecificOutput.decision;
  assert.strictEqual(d.behavior, "deny");
  assert.ok(d.message);
  console.log("ok  PermissionRequest -> Deny click -> hook prints deny + message");

  // Answered elsewhere: the tool runs (PostToolUse) -> hook stays silent
  hookRun = runHook({ hook_event_name: "PermissionRequest", tool_name: "Edit", tool_input: { file_path: "C:/a/b.ts" } });
  await waitForPending();
  await runHook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "C:/a/b.ts" }, tool_response: {} });
  r = await hookRun;
  assert.strictEqual(r.out, "");
  assert.strictEqual(sess().pending.length, 0);
  console.log("ok  answered in terminal/app (PostToolUse) -> hook prints nothing");

  // A different tool finishing must NOT clear the pending request (parallel tools)
  hookRun = runHook({ hook_event_name: "PermissionRequest", tool_name: "Edit", tool_input: { file_path: "C:/a/c.ts" } });
  p = await waitForPending();
  await runHook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "C:/a/z.ts" }, tool_response: {} });
  assert.strictEqual(sess().pending.length, 1, "unrelated tool must not clear it");
  await runHook({ hook_event_name: "Stop", last_assistant_message: "Done! The cart total is fixed." });
  r = await hookRun;
  assert.strictEqual(r.out, "");
  assert.strictEqual(sess().status, "idle");
  assert.strictEqual(sess().preview.text, "Done! The cart total is fixed.");
  console.log("ok  unrelated tool keeps request; Stop clears it, sets idle + preview");

  // Island hidden -> answer immediately with nothing
  accepting = false;
  r = await runHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.strictEqual(r.out, "");
  assert.ok(r.ms < 2000, `should be quick, took ${r.ms} ms`);
  accepting = true;
  console.log(`ok  island hidden -> hook returns nothing right away (${r.ms} ms)`);

  // releaseAll (Ctrl+Alt+I while waiting)
  hookRun = runHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls -la" } });
  await waitForPending();
  live.releaseAll();
  r = await hookRun;
  assert.strictEqual(r.out, "");
  console.log("ok  hiding the island releases waiting requests");

  // Security: wrong token, wrong Host header, GET
  const { port } = JSON.parse(fs.readFileSync(SERVER_FILE, "utf8"));
  const status = (opts, body) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/hook", method: "POST", ...opts }, (res) => resolve(res.statusCode));
    req.on("error", () => resolve("error"));
    req.end(body);
  });
  const ev = JSON.stringify({ session_id: SID, hook_event_name: "Stop" });
  assert.strictEqual(await status({ headers: { "X-Island-Token": "nope" } }, ev), 403);
  const { token } = JSON.parse(fs.readFileSync(SERVER_FILE, "utf8"));
  assert.strictEqual(await status({ headers: { "X-Island-Token": token, Host: "evil.example:80" } }, ev), 403);
  assert.strictEqual(await status({ method: "GET", headers: { "X-Island-Token": token } }), 403);
  assert.strictEqual(await status({ headers: { "X-Island-Token": token } }, "not json"), 400);
  console.log("ok  wrong token / wrong Host / GET -> 403, bad JSON -> 400");

  // Merge with logs/statusline
  const state = collect(live.sessions());
  const merged = state.sessions.find((s) => s.id === SID);
  assert.strictEqual(merged.title, "Fix checkout bug");
  assert.strictEqual(merged.project, "shannela");
  // The last request went back to Claude's own prompt, so it's still waiting there.
  assert.strictEqual(merged.status, "waiting");
  assert.strictEqual(merged.pending.length, 0);
  console.log("ok  collect() merges hook sessions");

  // SessionEnd hides it
  await runHook({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  assert.ok(!collect(live.sessions()).sessions.find((s) => s.id === SID));
  console.log("ok  SessionEnd removes it from the list");

  // Island closed -> hook is silent and quick
  live.close();
  assert.ok(!fs.existsSync(SERVER_FILE), "server.json removed on close");
  r = await runHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.strictEqual(r.out, "");
  assert.strictEqual(r.code, 0);
  console.log(`ok  island closed -> hook exits 0 silently (${r.ms} ms)`);

  console.log(`\nALL PASSED (${changes} change events)`);
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
