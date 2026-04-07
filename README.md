# pi-hud

Heads-up display extension for pi micro-agents. Shows live agent stats, progress, and last responses as a persistent widget.

## Features

- **Live widget** — persistent display above the editor showing agent status, model, message count, and last response snippet
- **Status line** — footer indicator with agent count, streaming count, and dead agent alerts
- **Auto-polling** — refreshes every 5 seconds, plus on agent start/end events
- **Commands**:
  - `/hud` — manually refresh the HUD
  - `/hud-status` — full status dump with table and last 2-3 responses per agent

## Widget indicators

| Icon | Meaning |
|------|---------|
| ○ | Idle |
| ● | Streaming |
| ◐ | Compacting |
| ✗ | Dead |
| ? | Unresponsive |

## Install

```bash
pi install /path/to/pi-hud
```

Or test directly:

```bash
pi -e /path/to/pi-hud/extensions/index.ts
```

## Requirements

Requires a micro-agents workspace at `/tmp/pi-agents-*` (created by the `micro-agents` skill). The extension auto-discovers the most recent workspace.

## How it works

1. On session start, begins polling agent RPC sockets every 5s
2. Discovers agents from `/tmp/pi-agents-*/agents/*/socket`
3. Queries each agent via `get_state` and `get_messages` RPC commands
4. Renders a compact widget and status line with live data
