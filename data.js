// Reads Claude Code session data from two places and merges it.
// Kept separate from main.js so it can be tested with plain Node.

const fs = require("fs");
const os = require("os");
const path = require("path");

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "island", "sessions");
const LIMITS_FILE = path.join(CLAUDE_DIR, "island", "limits.json");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000; // Sessions idle longer than 3h are hidden.
const TAIL_BYTES = 512 * 1024; // Only read the end of each log file.

// ---------- Reading data ----------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// "claude-opus-5-5" -> "Opus 5.5"
function prettyModel(id) {
  if (!id) return "Claude";
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(id);
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

// Context tokens = everything sent to the model on the last call.
// Output tokens are not counted, matching how Claude Code calculates it.
function inputTokens(usage) {
  if (!usage) return null;
  return (
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
  );
}

// Source 1: files written by statusline.js. Exact numbers, plus rate limits.
function readStatuslineSessions() {
  const sessions = new Map();
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return sessions;
  }
  for (const file of files) {
    const saved = readJson(path.join(SESSIONS_DIR, file));
    if (!saved?.data?.session_id) continue;
    const d = saved.data;
    const cw = d.context_window || {};
    const tokens = cw.current_usage ? inputTokens(cw.current_usage) : null;
    const size = cw.context_window_size || 200000;
    const pct = cw.used_percentage ?? (tokens != null ? (tokens / size) * 100 : null);
    sessions.set(d.session_id, {
      id: d.session_id,
      project: path.basename(d.workspace?.project_dir || d.cwd || "") || "Claude",
      title: d.session_name || null,
      model: d.model?.display_name || prettyModel(d.model?.id),
      contextPct: pct,
      contextTokens: tokens,
      contextSize: size,
      costUsd: d.cost?.total_cost_usd ?? null,
      updatedAt: saved.receivedAt,
      source: "live",
    });
  }
  return sessions;
}

// Source 2: Claude Code's own conversation logs (~/.claude/projects/*/*.jsonl).
// Works even where the status line never runs (e.g. the desktop app),
// but has no rate limits and has to guess the context window size.
const logCache = new Map(); // file path -> { mtimeMs, session }

function readLogTail(file, size) {
  const fd = fs.openSync(file, "r");
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// A one-line description of what a tool call is doing, e.g. Edit -> "main.js".
function summarizeTool(name, input) {
  if (!input || typeof input !== "object") return "";
  const file = input.file_path || input.notebook_path || input.path;
  let text;
  switch (name) {
    case "Bash":
    case "PowerShell":
      text = input.description || input.command;
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      text = file && path.basename(file);
      break;
    case "Grep":
    case "Glob":
      text = input.pattern;
      break;
    case "WebFetch":
      text = input.url;
      break;
    case "WebSearch":
      text = input.query;
      break;
    case "Agent":
    case "Task":
      text = input.description;
      break;
    default:
      text = Object.values(input).find((v) => typeof v === "string");
  }
  return oneLine(text || "");
}

function oneLine(text) {
  // Drop markdown bold and code marks so previews read as plain text.
  return String(text).replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

// The latest thing Claude said or did, from a log message's content blocks.
function previewFromContent(content) {
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block.type === "text" && block.text?.trim()) return { tool: null, text: oneLine(block.text) };
    if (block.type === "tool_use") return { tool: block.name, text: summarizeTool(block.name, block.input) };
  }
  return null; // e.g. only "thinking" blocks
}

function parseLog(file, stat) {
  const lines = readLogTail(file, stat.size).split("\n");
  let usageEntry = null;
  let title = null;
  let preview = null;
  // Walk backwards (newest first) until we've found all three things we need.
  for (let i = lines.length - 1; i >= 0 && !(usageEntry && title && preview); i--) {
    const line = lines[i];
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Blank line, or the first line cut in half by the tail read.
    }
    if (entry.type === "custom-title") {
      title ??= entry.customTitle || null;
      continue;
    }
    const msg = entry.message;
    // isSidechain = a subagent's reply, which has its own separate context.
    if (entry.type !== "assistant" || entry.isSidechain || !msg || msg.model === "<synthetic>") continue;
    preview ??= previewFromContent(msg.content);
    if (!usageEntry && msg.usage) usageEntry = entry;
  }
  if (!usageEntry) return null;

  const msg = usageEntry.message;
  const tokens = inputTokens(msg.usage);
  // Logs don't record the window size. Assume 200K unless usage proves it's bigger.
  const size = tokens > 200000 ? 1000000 : 200000;
  return {
    id: path.basename(file, ".jsonl"),
    project: path.basename(usageEntry.cwd || "") || "Claude",
    title,
    model: prettyModel(msg.model),
    contextPct: (tokens / size) * 100,
    contextTokens: tokens,
    contextSize: size,
    costUsd: null,
    updatedAt: stat.mtimeMs,
    source: "estimated",
    preview,
  };
}

function readLogSessions() {
  const sessions = new Map();
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return sessions;
  }
  for (const dir of projectDirs) {
    const dirPath = path.join(PROJECTS_DIR, dir.name);
    let files = [];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dirPath, f);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;
      // Only re-read a log when it has changed since the last check.
      const cached = logCache.get(file);
      let session = cached?.session;
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        try {
          session = parseLog(file, stat);
        } catch {
          session = null;
        }
        logCache.set(file, { mtimeMs: stat.mtimeMs, session });
      }
      if (session) sessions.set(session.id, session);
    }
  }
  return sessions;
}

function readLimits() {
  const saved = readJson(LIMITS_FILE);
  if (!saved?.rate_limits) return null;
  const now = Date.now();
  const toWindow = (w) => {
    if (!w || w.used_percentage == null) return null;
    const resetsAt = w.resets_at ? w.resets_at * 1000 : null;
    // Once the reset time passes, the old percentage no longer applies.
    if (resetsAt && resetsAt < now) return { pct: 0, resetsAt: null };
    return { pct: w.used_percentage, resetsAt };
  };
  return {
    fiveHour: toWindow(saved.rate_limits.five_hour),
    sevenDay: toWindow(saved.rate_limits.seven_day),
    updatedAt: saved.receivedAt,
  };
}

const WORKING_MS = 8000; // Without hooks, "working" = the log changed in the last 8s.
const MAX_SESSIONS = 8;

// Merges three sources per session:
//   logs (always there) < status line (exact numbers) < hooks (live status, permissions)
function collect(hookSessions = []) {
  const logs = readLogSessions();
  const merged = new Map(logs);
  for (const [id, s] of readStatuslineSessions()) {
    const fromLog = logs.get(id);
    // Prefer the exact status line numbers, but keep the log's title, preview and newest time.
    merged.set(id, {
      ...s,
      title: s.title || fromLog?.title || null,
      preview: fromLog?.preview || null,
      updatedAt: Math.max(s.updatedAt, fromLog?.updatedAt || 0),
    });
  }

  const now = Date.now();
  for (const s of merged.values()) {
    s.status = now - s.updatedAt < WORKING_MS ? "working" : "idle";
    s.pending = [];
  }

  for (const h of hookSessions) {
    const base = merged.get(h.id) || {
      id: h.id,
      project: path.basename(h.cwd || "") || "Claude",
      title: null,
      model: null,
      contextPct: null,
      contextTokens: null,
      contextSize: null,
      costUsd: null,
      updatedAt: 0,
      source: "estimated",
      preview: null,
    };
    merged.set(h.id, {
      ...base,
      title: h.title || base.title,
      status: h.status,
      preview: h.preview || base.preview,
      pending: h.pending.map(({ reqId, tool, summary }) => ({ reqId, tool, summary })),
      updatedAt: Math.max(base.updatedAt, h.updatedAt),
    });
  }

  const cutoff = now - ACTIVE_WINDOW_MS;
  const sessions = [...merged.values()]
    .filter((s) => s.status !== "ended" && (s.updatedAt >= cutoff || s.pending.length))
    // Sessions waiting for your permission go first, then the most recent.
    .sort((a, b) => (b.pending.length > 0) - (a.pending.length > 0) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);
  return { sessions, limits: readLimits() };
}

module.exports = { collect, prettyModel, inputTokens, summarizeTool };
