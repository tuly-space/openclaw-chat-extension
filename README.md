# OpenClaw Chat — Side Panel Extension

Chrome MV3 side panel extension that connects directly to your local OpenClaw gateway via WebSocket.

## Setup

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select this folder
4. Click the OpenClaw toolbar icon → side panel opens
5. Enter your gateway token (run `openclaw gateway status` to find it) → Save & Connect

## How it works

- Connects to `ws://127.0.0.1:18789` (default gateway port)
- Full WS protocol with Ed25519 device auth (keypair auto-generated on first use, stored in `chrome.storage.local`)
- Sends chat messages to the main agent session (`agent:main:main`)
- Receives streaming responses via `chat` events (`delta` → `final`)
- Gateway token stored locally — never transmitted elsewhere

## Protocol

```
Browser → Gateway:
  connect.challenge (← from server)
  → connect { auth: { token }, device: { id, publicKey, signature, signedAt, nonce } }
  ← hello-ok { snapshot.sessionDefaults.mainSessionKey }

Sending messages:
  → chat.send { sessionKey, message, idempotencyKey }
  ← chat event { state: "delta"|"final"|"aborted"|"error", message, runId }
```

## Files

- `manifest.json` — Chrome MV3 manifest
- `background.js` — service worker (opens panel on click)
- `sidepanel.html/css/js` — chat UI + gateway WS client
- `icons/` — placeholder icons (replace with real ones)

## TODO (v2)

- [ ] Session picker (switch between sessions)
- [ ] Markdown rendering in assistant messages
- [ ] File/image attachment support
- [ ] Remote gateway support (wss://)
- [ ] Export conversation
