# Claude Island

A notch for the top of your Windows desktop that shows your
[Claude Code](https://code.claude.com) sessions at a glance: what each one is
doing, how full its context window is, how much of your usage limit is left,
and Allow/Deny buttons for permission requests.

> **Unofficial.** A personal project, not made by or affiliated with Anthropic.
> "Claude" and Clawd belong to Anthropic.

## Features

- **Notch at the top of the screen** with Clawd and the context % of your latest session. The spinner animates while Claude works.
- **Session list on hover:** title, live status dot, and a preview of the last thing each session did.
- **Allow / Deny from the notch:** when Claude asks for permission, the notch opens by itself. Works with sessions in the terminal and in the Claude desktop app.
- **Usage view:** context window, 5-hour and weekly limits with reset countdowns.
- **Copy resume command** and **archive** for each session.
- **Click-through:** only the notch takes clicks. The rest of the window lets clicks pass to the apps behind it.

## How it works

```
Claude Code (terminal or desktop app)
   │  runs hook.js on each event: prompt sent, tool used,
   │  permission needed, reply finished...
   ▼
hook.js ──── HTTP on 127.0.0.1 + secret token ────▶ Claude Island
   ▲                                                   │
   └──────────── your Allow / Deny click ◀─────────────┘
```

Each session's data is merged from three sources:

| Source | Gives | Works in |
|---|---|---|
| Hooks (`hook.js`) | Live status, previews, titles, permission requests | Terminal and desktop app |
| Status line (`statusline.js`) | Exact context %, 5-hour and weekly limits, cost | Terminal only |
| Conversation logs (`~/.claude/projects`) | Context estimate, titles, previews | Everywhere, including sessions started before the island |

### Safety

- The server only listens on `127.0.0.1` and rejects requests without the
  secret token. The token is random and changes every time the island starts.
- It checks the `Host` header (blocks DNS-rebinding tricks from websites) and
  never answers browser CORS preflights.
- **The island can never block Claude.** If it's closed or hidden, or you don't
  answer within 290 seconds, `hook.js` prints nothing and Claude Code shows its
  normal permission prompt.
- Log text is always inserted as text, never as HTML.

## Install

Requirements: Windows 10/11, [Node.js](https://nodejs.org) 22.2+ on your PATH, Claude Code.

```bash
git clone https://github.com/isendevs/claude-island.git
cd claude-island
npm install
npm run package
npm run install-app
```

This installs the app to `%LOCALAPPDATA%\Programs\Claude Island`, adds Start
Menu and Desktop shortcuts, sets it to start with Windows, and launches it.
On first launch it copies `hook.js` and `statusline.js` to `~/.claude/island/bin/`.

### Connect Claude Code

Add this to `~/.claude/settings.json`. Replace `<you>` with your Windows user name.

```json
{
  "statusLine": { "type": "command", "command": "node \"C:/Users/<you>/.claude/island/bin/statusline.js\"" },
  "hooks": {
    "SessionStart":      [{ "hooks": [{ "type": "command", "command": "node \"C:/Users/<you>/.claude/island/bin/hook.js\"", "timeout": 5 }] }],
    "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "node \"C:/Users/<you>/.claude/island/bin/hook.js\"", "timeout": 5 }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "node \"C:/Users/<you>/.claude/island/bin/hook.js\"", "timeout": 5 }] }],
    "PreToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/Users/<you>/.claude/island/bin/hook.js\"", "timeout": 5 }] }],
    "PostToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/Users/<you>/.claude/island/bin/hook.js\"", "timeout": 5 }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/Users/<you>/.claude/island/bin/hook.js\"", "timeout": 300 }] }],
    "Notification":      [{ "hooks": [{ "type": "command", "command": "node \"C:/Users/<you>/.claude/island/bin/hook.js\"", "timeout": 5 }] }],
    "Stop":              [{ "hooks": [{ "type": "command", "command": "node \"C:/Users/<you>/.claude/island/bin/hook.js\"", "timeout": 5 }] }]
  }
}
```

## Use

- **Hover** the notch to open the session list. The menu button switches to the Usage view.
- **Ctrl+Alt+I** hides or shows it. While hidden, permission requests go to Claude's normal prompt.
- **Quit:** Usage view, then Quit.
- **Stop it starting with Windows:** Task Manager > Startup apps > Claude Island > Disable.

## Develop

```bash
npm start          # run from source, no install
npm test           # end-to-end tests for hooks, server and merging
npm run package    # build dist/Claude Island-win32-x64
npm run install-app
```

The tests run `hook.js` as a real separate process, the way Claude Code does,
inside a throwaway home folder. They cover Allow, Deny, answers given in Claude
instead of the island, parallel tools, a hidden or closed island, and rejected
requests (wrong token, wrong Host, bad JSON).

| File | Job |
|---|---|
| `main.js` | The floating window, click-through, messages between window and server |
| `live.js` | Private server that receives hook events and holds permission requests |
| `hook.js` | Run by Claude Code on each event; forwards it and returns your decision |
| `data.js` | Reads logs and status line data, merges everything per session |
| `statusline.js` | Saves Claude Code's live numbers to `~/.claude/island/` |
| `index.html` | The notch: design, animations, session list |
| `build/` | Icon generator and install script |

## Uninstall

1. Quit the island.
2. Remove the `statusLine` and `hooks` blocks from `~/.claude/settings.json`.
3. Delete `%LOCALAPPDATA%\Programs\Claude Island`, `~/.claude/island`, and the two shortcuts.

## License

[MIT](LICENSE)
