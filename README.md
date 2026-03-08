# OpenClaw Chat — Chrome Side Panel Extension

A Chrome MV3 extension that provides a chat side panel for [OpenClaw](https://github.com/openclaw/openclaw), with integrated browser relay and full-featured markdown rendering.

**Repo:** [tuly-space/openclaw-chat-extension](https://github.com/tuly-space/openclaw-chat-extension)
**Version:** 1.5.4
**License:** MIT

---

## Features

### Chat
- **Side panel UI** — opens alongside any tab, doesn't take over the page
- **Streaming responses** — real-time token-by-token output via SSE
- **Markdown rendering** — headings, lists, tables, blockquotes, bold/italic, links
- **Syntax highlighting** — highlight.js with language auto-detection
- **File attachments** — 📎 button, drag & drop, or Cmd+V paste for images
- **Conversation history** — local storage, switch between past conversations
- **Font size control** — A-/A+ buttons (7 presets: 11–18px)
- **Dark/light theme** — 🌙/☀️ toggle, persisted in localStorage

### Browser Relay
- **CDP bridge** — forwards Chrome DevTools Protocol between OpenClaw and browser tabs
- **Follow mode** — relay automatically switches to the active tab
- **Multi-window** — works when side panel is in a separate window
- **Status indicator** — real-time dot (off → connecting → on) + current tab title
- **Auto-reconnect** — exponential backoff with keepalive

---

## Architecture

```
┌──────────────┐     chrome.runtime.connect     ┌─────────────────┐
│  sidepanel   │ ◄──────────────────────────────►│  background.js  │
│  (UI layer)  │    port: "chat" (streaming)     │ (service worker) │
│              │    port: "relay-status"          │                 │
└──────────────┘                                 └────────┬────────┘
                                                          │
                              ┌────────────────────────────┼────────────────────┐
                              │                            │                    │
                         fetch (SSE)                  WebSocket              chrome.debugger
                              │                            │                    │
                    ┌─────────▼──────────┐     ┌───────────▼──────────┐   ┌─────▼─────┐
                    │  OpenClaw Gateway   │     │  Local Relay Server  │   │  Browser   │
                    │ /v1/chat/completions│     │  ws://127.0.0.1:18792│   │   Tabs     │
                    │  (HTTPS, bearer)    │     │  (HMAC token auth)   │   │  (CDP)     │
                    └────────────────────┘     └──────────────────────┘   └───────────┘
```

### Why background service worker?

Chrome extension pages (side panel, popup) are subject to CORS restrictions on `fetch()`. The background service worker bypasses CORS via `host_permissions`, so all network calls are routed through it.

### Chat flow

1. User types message → sidepanel sends `{type: "SEND", messages, settings, sessionKey}` via port
2. Background calls `POST /v1/chat/completions` with `stream: true`
3. SSE chunks forwarded as `{type: "DELTA", delta}` messages back to sidepanel
4. Sidepanel renders markdown in real-time with `marked.parse()`

### Relay flow

1. Background connects to local relay server at `ws://127.0.0.1:{relayPort}/extension`
2. Relay token derived: `HMAC-SHA256("openclaw-extension-relay-v1:{port}", gatewayToken)`
3. Gateway handshake: `connect.challenge` → `connect` (role: operator)
4. Tab attached via `chrome.debugger.attach()` → CDP events forwarded to relay
5. Follow mode: `tabs.onActivated` triggers detach old → attach new

---

## File Structure

```
manifest.json         # MV3 manifest (permissions, service worker, side panel)
background.js         # Service worker: chat streaming + relay lifecycle
relay.js              # Browser relay module (CDP bridge, WebSocket, tab management)
conversations.js      # Local conversation CRUD (chrome.storage.local)
sidepanel.html        # Side panel page
sidepanel.js          # UI logic: chat, history, theme, attachments, relay status
sidepanel.css         # Styles with CSS variables, dark/light themes
marked.min.js         # Markdown parser (v15, bundled)
highlight.min.js      # Syntax highlighter (v11.11, bundled)
hljs-dark.css         # GitHub Dark theme for highlight.js
hljs-light.css        # GitHub Light theme for highlight.js
icons/                # Extension icons (16, 48, 128px)
```

---

## Permissions

| Permission | Why |
|---|---|
| `sidePanel` | Side panel UI |
| `storage` | Settings, conversation history, relay state, device identity |
| `debugger` | Chrome DevTools Protocol for browser relay |
| `tabs` | Tab info, follow-mode tab switching |
| `activeTab` | Access current tab for relay |
| `alarms` | Relay keepalive (30s interval) |
| `webNavigation` | Detect page load completion for relay re-announce |
| `host_permissions: https://*/* http://127.0.0.1/* http://localhost/*` | Gateway API + local relay server |

---

## Configuration

Settings are stored in `chrome.storage.local` and configured via the ⚙ panel:

| Setting | Default | Description |
|---|---|---|
| Gateway URL | `https://dash.tuly.space` | OpenClaw gateway HTTP endpoint |
| Gateway Token | _(required)_ | Bearer token for authentication |
| Agent ID | `main` | Target agent (sent as `model: "openclaw:{agentId}"`) |
| Relay Port | `18792` | Local relay server port |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Enter` / `Ctrl+Enter` | Send message |
| `Enter` | New line |
| `Escape` | Stop streaming / close panels |
| `Cmd+V` | Paste image from clipboard |

---

## Session Management

Each conversation gets a stable session key: `agent:{agentId}:conv-{localId}`

- The gateway maintains server-side context per session key
- Full message history is also sent with each request (belt + suspenders)
- Conversations are stored locally in `chrome.storage.local`
- Auto-titled from first user message (first 60 chars)

---

## Theming

Two themes available, toggled via 🌙/☀️ button:

- **Dark** (default): Dark backgrounds, GitHub Dark syntax highlighting
- **Light**: Light backgrounds, GitHub Light syntax highlighting

Theme preference persisted in `localStorage`. CSS uses `[data-theme]` attribute with CSS custom properties for all colors.

---

## File Attachments

Supported input methods:
- 📎 button (file picker)
- Drag & drop onto input area
- Cmd+V paste (images from clipboard)

Supported formats:
- **Images** → sent as `image_url` data URIs (OpenAI vision format)
- **Text files** (.txt, .md, .json, .csv, .log, etc.) → inlined as text content
- **Max size:** 20MB per file

---

## Development

```bash
# Clone
git clone https://github.com/tuly-space/openclaw-chat-extension.git
cd openclaw-chat-extension

# Load in Chrome
# 1. Open chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked" → select this directory
# 4. Click the extension icon to open the side panel
# 5. Configure gateway URL + token in ⚙ settings
```

### Prerequisites

- OpenClaw gateway running with `gateway.http.endpoints.chatCompletions.enabled: true`
- Gateway token (run `openclaw gateway status` to find it)
- For relay: OpenClaw node host running locally (provides relay server on port 18792)

### Version bumping

Every code change must bump the version in `manifest.json` before commit.

---

## Version History

| Version | Highlights |
|---|---|
| 0.1.0 | Initial WebSocket implementation |
| 0.2.0 | Switch to HTTP SSE (`/v1/chat/completions`) |
| 0.3.0 | Move fetch to background service worker (CORS fix) |
| 0.4.0 | Integrate browser relay (CDP bridge) |
| 0.5.0 | Relay auto-follows active tab |
| 0.6.0 | Real-time relay status indicator |
| 0.7.0 | Show relay tab title in header |
| 0.8.0 | Multi-window support, follow-mode persisted |
| 0.9.0 | Markdown rendering (marked.js) |
| 1.0.0 | Syntax highlighting + dark/light theme |
| 1.1.0 | Conversation history (local storage) |
| 1.2.0 | Gateway-backed history attempt (reverted in 1.3.0) |
| 1.3.0 | Local storage history (stable) |
| 1.4.x | Font size control, Cmd+Enter, code block styling, spacing fixes |
| 1.5.x | File attachments, paste images, input alignment |
