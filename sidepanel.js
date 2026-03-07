/**
 * sidepanel.js — OpenClaw Chat Side Panel
 *
 * Protocol: OpenClaw Gateway WebSocket v3
 * Auth:     Ed25519 device keypair + gateway token
 * Events:   chat events (delta/final/aborted/error)
 */

"use strict";

// ─── Constants ───────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = 3;
const CLIENT_ID = "webchat";
const CLIENT_MODE = "webchat";
const CLIENT_VERSION = "0.1.0";
const CLIENT_PLATFORM = "chrome-extension";
const CLIENT_DEVICE_FAMILY = "browser";

// ─── Utility: Base64url ──────────────────────────────────────────────────────

function base64UrlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  const b64 = padded + "=".repeat(pad);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function hexEncode(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
}

// ─── Device Identity (Ed25519) ───────────────────────────────────────────────

const IDENTITY_STORAGE_KEY = "openclaw_device_identity_v1";

async function generateDeviceIdentity() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign"]
  );
  const rawPub = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

  // Device ID = SHA-256 hex of raw public key bytes
  const hashBuf = await crypto.subtle.digest("SHA-256", rawPub);
  const deviceId = hexEncode(hashBuf);

  // Public key for gateway = base64url of raw 32-byte key
  const publicKeyB64url = base64UrlEncode(rawPub);

  return { deviceId, publicKeyB64url, privJwk, pubJwk };
}

async function loadOrCreateDeviceIdentity() {
  const stored = await chrome.storage.local.get(IDENTITY_STORAGE_KEY);
  if (stored[IDENTITY_STORAGE_KEY]) {
    try {
      const d = stored[IDENTITY_STORAGE_KEY];
      // Verify it still has the required fields
      if (d.deviceId && d.publicKeyB64url && d.privJwk) {
        return d;
      }
    } catch (_) {}
  }
  const identity = await generateDeviceIdentity();
  await chrome.storage.local.set({ [IDENTITY_STORAGE_KEY]: identity });
  return identity;
}

async function signPayload(privJwk, payload) {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privJwk,
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const data = new TextEncoder().encode(payload);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, data);
  return base64UrlEncode(sig);
}

function buildDeviceAuthPayloadV3({
  deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce,
  platform, deviceFamily,
}) {
  const scopesStr = scopes.join(",");
  const tokenStr = token ?? "";
  const platformStr = (platform || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const familyStr = (deviceFamily || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return [
    "v3", deviceId, clientId, clientMode, role, scopesStr,
    String(signedAtMs), tokenStr, nonce, platformStr, familyStr,
  ].join("|");
}

// ─── Settings ────────────────────────────────────────────────────────────────

const SETTINGS_KEY = "openclaw_settings_v1";
const DEFAULT_SETTINGS = {
  gatewayUrl: "ws://127.0.0.1:18789",
  token: "",
  agentId: "main",
};

async function loadSettings() {
  const s = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s[SETTINGS_KEY] || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// ─── Gateway WebSocket Client ─────────────────────────────────────────────────

class GatewayClient {
  constructor({ gatewayUrl, token, agentId, identity, onEvent, onConnected, onDisconnected, onError }) {
    this.gatewayUrl = gatewayUrl;
    this.token = token;
    this.agentId = agentId;
    this.identity = identity;
    this.onEvent = onEvent;
    this.onConnected = onConnected;
    this.onDisconnected = onDisconnected;
    this.onError = onError;

    this.ws = null;
    this.pending = new Map(); // id → { resolve, reject }
    this.connected = false;
    this.sessionKey = null;
    this.connectNonce = null;
    this.closed = false;
    this.deviceToken = null; // persisted device token for reconnects
  }

  connect() {
    if (this.ws) return;
    this.closed = false;
    try {
      this.ws = new WebSocket(this.gatewayUrl);
    } catch (e) {
      this.onError?.(`Cannot open WebSocket: ${e.message}`);
      return;
    }

    this.ws.onopen = () => {
      // Wait for connect.challenge event before sending anything
    };

    this.ws.onmessage = (evt) => {
      try {
        const frame = JSON.parse(evt.data);
        this._handleFrame(frame);
      } catch (e) {
        console.error("[openclaw] frame parse error", e);
      }
    };

    this.ws.onclose = (evt) => {
      this.connected = false;
      this.ws = null;
      if (!this.closed) {
        const reason = evt.reason ? `: ${evt.reason}` : "";
        this.onDisconnected?.(`WebSocket closed (${evt.code})${reason}`);
      }
    };

    this.ws.onerror = () => {
      // onclose fires after onerror, so we handle there
      if (!this.connected) {
        this.onError?.("Cannot connect to gateway. Check URL and that the gateway is running.");
      }
    };
  }

  disconnect() {
    this.closed = true;
    this.connected = false;
    if (this.ws) {
      try { this.ws.close(1000, "user disconnect"); } catch (_) {}
      this.ws = null;
    }
    // Reject all pending
    for (const [, p] of this.pending) {
      p.reject(new Error("disconnected"));
    }
    this.pending.clear();
  }

  async _handleFrame(frame) {
    if (frame.type === "event") {
      // connect.challenge → send connect
      if (frame.event === "connect.challenge") {
        const nonce = frame.payload?.nonce;
        if (!nonce) { this.onError?.("Missing nonce in connect.challenge"); return; }
        this.connectNonce = nonce.trim();
        await this._sendConnect();
        return;
      }

      // Forward to app
      this.onEvent?.(frame);
      return;
    }

    if (frame.type === "res") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;

      // chat.send returns interim "accepted" status before final
      if (frame.payload?.status === "accepted" && pending.expectFinal) return;

      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        pending.reject(new Error(frame.error?.message || "gateway error"));
      }
      return;
    }
  }

  async _sendConnect() {
    const role = "operator";
    const scopes = ["operator.read", "operator.write"];
    const signedAtMs = Date.now();
    const nonce = this.connectNonce;
    const tokenStr = this.token?.trim() || "";

    // Build device auth
    let device = undefined;
    if (this.identity) {
      const payload = buildDeviceAuthPayloadV3({
        deviceId: this.identity.deviceId,
        clientId: CLIENT_ID,
        clientMode: CLIENT_MODE,
        role,
        scopes,
        signedAtMs,
        token: tokenStr || null,
        nonce,
        platform: CLIENT_PLATFORM,
        deviceFamily: CLIENT_DEVICE_FAMILY,
      });
      const signature = await signPayload(this.identity.privJwk, payload);
      device = {
        id: this.identity.deviceId,
        publicKey: this.identity.publicKeyB64url,
        signature,
        signedAt: signedAtMs,
        nonce,
      };
    }

    const auth = tokenStr
      ? { token: tokenStr }
      : this.deviceToken
      ? { deviceToken: this.deviceToken }
      : undefined;

    const params = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: CLIENT_ID,
        displayName: "OpenClaw Side Panel",
        version: CLIENT_VERSION,
        platform: CLIENT_PLATFORM,
        deviceFamily: CLIENT_DEVICE_FAMILY,
        mode: CLIENT_MODE,
      },
      role,
      scopes,
      caps: [],
      auth,
      device,
      locale: navigator.language || "en-US",
      userAgent: navigator.userAgent,
    };

    try {
      const helloOk = await this._request("connect", params);
      this.connected = true;

      // Store device token for future reconnects (skip gateway token re-auth)
      if (helloOk?.auth?.deviceToken) {
        this.deviceToken = helloOk.auth.deviceToken;
      }

      // Extract main session key
      const sessionDefaults = helloOk?.snapshot?.sessionDefaults;
      if (sessionDefaults?.mainSessionKey) {
        this.sessionKey = sessionDefaults.mainSessionKey;
      } else {
        // Fallback: construct it
        const agentId = this.agentId || "main";
        this.sessionKey = `agent:${agentId}:main`;
      }

      this.onConnected?.(helloOk);
    } catch (e) {
      this.onError?.(`Connect failed: ${e.message}`);
    }
  }

  _send(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not open");
    }
    this.ws.send(JSON.stringify(frame));
  }

  _request(method, params, { expectFinal = false } = {}) {
    return new Promise((resolve, reject) => {
      const id = uuid();
      this.pending.set(id, { resolve, reject, expectFinal });
      try {
        this._send({ type: "req", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  // Send a chat message to the main session
  async chatSend(message, { thinking } = {}) {
    if (!this.connected || !this.sessionKey) {
      throw new Error("Not connected");
    }
    const params = {
      sessionKey: this.sessionKey,
      message,
      idempotencyKey: uuid(),
      ...(thinking ? { thinking } : {}),
    };
    return this._request("chat.send", params, { expectFinal: true });
  }

  // Load recent chat history
  async chatHistory(limit = 40) {
    if (!this.connected || !this.sessionKey) return null;
    try {
      return await this._request("chat.history", {
        sessionKey: this.sessionKey,
        limit,
      });
    } catch (e) {
      console.warn("[openclaw] chat.history failed:", e.message);
      return null;
    }
  }

  // Abort current run
  async chatAbort() {
    if (!this.connected || !this.sessionKey) return;
    try {
      await this._request("chat.abort", { sessionKey: this.sessionKey });
    } catch (_) {}
  }

  // Start a new session
  async sessionReset() {
    if (!this.connected || !this.sessionKey) return;
    try {
      await this._request("sessions.reset", {
        key: this.sessionKey,
        reason: "new",
      });
    } catch (e) {
      console.warn("[openclaw] sessions.reset failed:", e.message);
    }
  }
}

// ─── UI State ────────────────────────────────────────────────────────────────

let client = null;
let isStreaming = false;
let streamingMessageEl = null;
let streamingText = "";
let streamingRunId = null;
let settingsOpen = false;

// DOM refs
const $status = document.getElementById("status-dot");
const $headerName = document.getElementById("header-name");
const $errorBanner = document.getElementById("error-banner");
const $errorText = document.getElementById("error-text");
const $btnRetry = document.getElementById("btn-retry");
const $settingsPanel = document.getElementById("settings-panel");
const $messages = document.getElementById("messages");
const $typing = document.getElementById("typing-indicator");
const $inputMsg = document.getElementById("input-msg");
const $btnSend = document.getElementById("btn-send");
const $btnSettings = document.getElementById("btn-settings");
const $btnNew = document.getElementById("btn-new");
const $btnSaveSettings = document.getElementById("btn-save-settings");
const $btnCancelSettings = document.getElementById("btn-cancel-settings");
const $inputUrl = document.getElementById("input-url");
const $inputToken = document.getElementById("input-token");
const $inputAgent = document.getElementById("input-agent");

// ─── Status helpers ───────────────────────────────────────────────────────────

function setStatus(state, label = "OpenClaw") {
  $status.className = `dot ${state}`;
  $headerName.textContent = label;
}

function showError(msg) {
  $errorText.textContent = msg;
  $errorBanner.classList.remove("hidden");
  setStatus("error");
}

function hideError() {
  $errorBanner.classList.add("hidden");
}

function setSendEnabled(enabled) {
  $btnSend.disabled = !enabled;
}

// ─── Message rendering ────────────────────────────────────────────────────────

function appendMessage(role, text, { streaming = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;

  const roleLabel = document.createElement("div");
  roleLabel.className = "message-role";
  roleLabel.textContent = role === "user" ? "You" : role === "assistant" ? "OpenClaw" : role;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  if (streaming) bubble.classList.add("streaming-cursor");
  bubble.textContent = text;

  wrap.appendChild(roleLabel);
  wrap.appendChild(bubble);

  if (role !== "system") {
    $messages.appendChild(wrap);
  } else {
    // System messages go at top as context
    $messages.insertBefore(wrap, $messages.firstChild);
  }

  scrollBottom();
  return bubble;
}

function scrollBottom() {
  $messages.scrollTop = $messages.scrollHeight;
}

function clearMessages() {
  $messages.innerHTML = "";
}

// ─── Load history ─────────────────────────────────────────────────────────────

async function loadHistory() {
  if (!client?.connected) return;
  const result = await client.chatHistory(40);
  if (!result) return;

  const messages = result.messages || result;
  if (!Array.isArray(messages) || messages.length === 0) return;

  clearMessages();

  for (const msg of messages) {
    const role = msg.role === "user" ? "user" : "assistant";
    // Content can be string or array of content blocks
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");
    }
    if (text.trim()) {
      appendMessage(role, text.trim());
    }
  }
}

// ─── Event handling ───────────────────────────────────────────────────────────

function handleGatewayEvent(frame) {
  // We're interested in "chat" events for our session
  if (frame.event !== "chat") return;

  const ev = frame.payload;
  if (!ev) return;

  // Only handle events for our session
  if (ev.sessionKey && client?.sessionKey && ev.sessionKey !== client.sessionKey) return;

  const state = ev.state;
  const runId = ev.runId;

  if (state === "delta") {
    const delta = extractDeltaText(ev.message);
    if (delta === null && !streamingMessageEl) {
      // No text yet (tool calls etc.), show typing
      setTyping(true);
      return;
    }

    if (!streamingMessageEl || streamingRunId !== runId) {
      // New message bubble
      setTyping(false);
      streamingRunId = runId;
      streamingText = delta || "";
      streamingMessageEl = appendMessage("assistant", streamingText, { streaming: true });
      isStreaming = true;
      setSendEnabled(false);
    } else if (delta) {
      streamingText += delta;
      streamingMessageEl.textContent = streamingText;
      scrollBottom();
    }
  } else if (state === "final") {
    setTyping(false);
    if (streamingMessageEl) {
      // Finalize: set full text from final message
      const finalText = extractFinalText(ev.message) || streamingText;
      streamingMessageEl.textContent = finalText;
      streamingMessageEl.classList.remove("streaming-cursor");
      streamingMessageEl = null;
      streamingText = "";
      streamingRunId = null;
    }
    isStreaming = false;
    setSendEnabled(true);
  } else if (state === "aborted") {
    setTyping(false);
    if (streamingMessageEl) {
      streamingMessageEl.classList.remove("streaming-cursor");
      streamingMessageEl = null;
    }
    streamingText = "";
    streamingRunId = null;
    isStreaming = false;
    setSendEnabled(true);
    appendMessage("system", "— run aborted —");
  } else if (state === "error") {
    setTyping(false);
    if (streamingMessageEl) {
      streamingMessageEl.classList.remove("streaming-cursor");
      streamingMessageEl = null;
    }
    streamingText = "";
    streamingRunId = null;
    isStreaming = false;
    setSendEnabled(true);
    const errMsg = ev.errorMessage || "An error occurred";
    appendMessage("error", `Error: ${errMsg}`);
  }
}

function extractDeltaText(message) {
  if (!message) return null;
  // Delta message may be a string, or object with text delta
  if (typeof message === "string") return message;
  if (message.type === "text" && typeof message.text === "string") return message.text;
  // OpenClaw sends content blocks
  if (Array.isArray(message.content)) {
    const parts = message.content
      .filter((c) => c.type === "text_delta" || c.type === "text")
      .map((c) => c.text || c.delta || "")
      .join("");
    return parts || null;
  }
  if (typeof message.delta === "string") return message.delta;
  if (message.delta?.text) return message.delta.text;
  return null;
}

function extractFinalText(message) {
  if (!message) return null;
  if (typeof message === "string") return message;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("\n");
  }
  if (message.text) return message.text;
  return null;
}

function setTyping(visible) {
  $typing.classList.toggle("hidden", !visible);
  if (visible) scrollBottom();
}

// ─── Connection ───────────────────────────────────────────────────────────────

async function connect(settings) {
  if (client) {
    client.disconnect();
    client = null;
  }

  hideError();
  setStatus("connecting", "Connecting…");
  setSendEnabled(false);

  const identity = await loadOrCreateDeviceIdentity();

  client = new GatewayClient({
    gatewayUrl: settings.gatewayUrl,
    token: settings.token,
    agentId: settings.agentId,
    identity,

    onConnected: async (helloOk) => {
      hideError();
      setStatus("connected", `OpenClaw · ${settings.agentId || "main"}`);
      setSendEnabled(true);
      await loadHistory();
    },

    onDisconnected: (reason) => {
      setStatus("disconnected", "Disconnected");
      setSendEnabled(false);
      showError(reason || "Disconnected from gateway");
    },

    onError: (msg) => {
      setStatus("error", "Error");
      setSendEnabled(false);
      showError(msg);
    },

    onEvent: handleGatewayEvent,
  });

  client.connect();
}

async function reconnect() {
  const settings = await loadSettings();
  if (!settings.token) {
    openSettings();
    return;
  }
  await connect(settings);
}

// ─── Settings panel ───────────────────────────────────────────────────────────

async function openSettings() {
  const settings = await loadSettings();
  $inputUrl.value = settings.gatewayUrl;
  $inputToken.value = settings.token;
  $inputAgent.value = settings.agentId;
  $settingsPanel.classList.remove("hidden");
  settingsOpen = true;
  $inputToken.focus();
}

function closeSettings() {
  $settingsPanel.classList.add("hidden");
  settingsOpen = false;
}

async function saveAndConnect() {
  const settings = {
    gatewayUrl: ($inputUrl.value.trim() || DEFAULT_SETTINGS.gatewayUrl),
    token: $inputToken.value.trim(),
    agentId: ($inputAgent.value.trim() || "main"),
  };
  await saveSettings(settings);
  closeSettings();
  await connect(settings);
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function sendMessage() {
  const text = $inputMsg.value.trim();
  if (!text || isStreaming || !client?.connected) return;

  $inputMsg.value = "";
  autoResize($inputMsg);

  appendMessage("user", text);
  setTyping(true);
  setSendEnabled(false);
  isStreaming = true;

  try {
    await client.chatSend(text);
    // Response comes via chat events (delta/final)
  } catch (e) {
    setTyping(false);
    isStreaming = false;
    setSendEnabled(true);
    appendMessage("error", `Failed to send: ${e.message}`);
  }
}

// ─── Textarea auto-resize ─────────────────────────────────────────────────────

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

// ─── Event listeners ──────────────────────────────────────────────────────────

$btnSend.addEventListener("click", sendMessage);

$inputMsg.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$inputMsg.addEventListener("input", () => {
  autoResize($inputMsg);
  $btnSend.disabled = !$inputMsg.value.trim() || isStreaming || !client?.connected;
});

$btnSettings.addEventListener("click", () => {
  if (settingsOpen) closeSettings();
  else openSettings();
});

$btnCancelSettings.addEventListener("click", closeSettings);
$btnSaveSettings.addEventListener("click", saveAndConnect);

$btnRetry.addEventListener("click", reconnect);

$btnNew.addEventListener("click", async () => {
  if (!client?.connected) return;
  if (!confirm("Start a new session? This clears the current context.")) return;
  await client.sessionReset();
  clearMessages();
  appendMessage("system", "— new session started —");
});

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  const settings = await loadSettings();
  if (!settings.token) {
    setStatus("disconnected", "Not configured");
    setSendEnabled(false);
    appendMessage("system", "Set your gateway token in ⚙ Settings to connect.");
    openSettings();
  } else {
    await connect(settings);
  }
})();
