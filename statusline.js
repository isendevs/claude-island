#!/usr/bin/env node
// Claude Code status line script.
// Claude Code pipes live session data (JSON) into this script after every reply.
// We save it to ~/.claude/island/ so the Dynamic Island app can read it,
// then print a short line for the terminal's own status bar.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ISLAND_DIR = path.join(os.homedir(), ".claude", "island");
const SESSIONS_DIR = path.join(ISLAND_DIR, "sessions");

// Write to a temp file first, then rename. Renaming is instant, so the
// island app never reads a half-written file.
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // Bad input: print nothing rather than crash the status bar.
  }

  const now = Date.now();
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    if (input.session_id) {
      writeAtomic(path.join(SESSIONS_DIR, `${input.session_id}.json`), {
        receivedAt: now,
        data: input,
      });
    }
    // Rate limits belong to your account, not one session, so they get their own file.
    if (input.rate_limits) {
      writeAtomic(path.join(ISLAND_DIR, "limits.json"), {
        receivedAt: now,
        rate_limits: input.rate_limits,
      });
    }
  } catch {
    // Saving failed (disk, permissions). Still print the status line below.
  }

  const parts = [input.model?.display_name ?? "Claude"];
  const ctx = input.context_window?.used_percentage;
  if (ctx != null) parts.push(`ctx ${Math.round(ctx)}%`);
  const fiveHour = input.rate_limits?.five_hour?.used_percentage;
  if (fiveHour != null) parts.push(`5h ${Math.round(fiveHour)}%`);
  const week = input.rate_limits?.seven_day?.used_percentage;
  if (week != null) parts.push(`7d ${Math.round(week)}%`);
  process.stdout.write(parts.join(" · "));
});
