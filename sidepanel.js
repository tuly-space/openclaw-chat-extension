/**
 * sidepanel.js — OpenClaw Chat Side Panel
 * Chat via background service worker (CORS-free fetch) + runtime port streaming
 */

"use strict";

// ─── Settings ────────────────────────────────────────────────────────────────

const SETTINGS_KEY = "openclaw_settings_v1";
const DEFAULT_SETTINGS = {
  gatewayUrl: "https://dash.tuly.space",
  token: "",
  agentId: "main",
};

async function loadSettings() {
  const s = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s[SETTINGS_KEY] || {}) };
}

async function saveSettings(s) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

// ─── State ────────────────────────────────────────────────────────────────────

let settings = null;
let isStreaming = false;
let chatPort = null;
let settingsOpen = false;

// DOM refs
const $status     = document.getElementById("status-dot");
const $headerName = document.getElementById("header-name");
const $errorBanner= document.getElementById("error-banner");
const $errorText  = document.getElementById("error-text");
const $btnRetry   = document.getElementById("btn-retry");
const $settingsPanel = document.getElementById("settings-panel");
const $messages   = document.getElementById("messages");
const $typing     = document.getElementById("typing-indicator");
const $inputMsg   = document.getElementById("input-msg");
const $btnSend    = document.getElementById("btn-send");
const $btnSettings= document.getElementById("btn-settings");
const $btnRelay   = document.getElementById("btn-relay");
const $relayDot   = document.getElementById("relay-dot");
const $btnNew     = document.getElementById("btn-new");
const $btnSaveSettings = document.getElementById("btn-save-settings");
const $btnCancelSettings = document.getElementById("btn-cancel-settings");
const $inputUrl   = document.getElementById("input-url");
const $inputToken = document.getElementById("input-token");
const $inputAgent = document.getElementById("input-agent");
const $inputRelayPort = document.getElementById("input-relay-port");

// ─── Status helpers ───────────────────────────────────────────────────────────

function setStatus(state, label) {
  $status.className = `dot ${state}`;
  if (label) $headerName.textContent = label;
}

function showError(msg) {
  $errorText.textContent = msg;
  $errorBanner.classList.remove("hidden");
}

function hideError() {
  $errorBanner.classList.add("hidden");
}

function setSendEnabled(v) {
  $btnSend.disabled = !v;
}

function updateSendButton() {
  $btnSend.disabled = !$inputMsg.value.trim() || isStreaming || !settings?.token;
}

// ─── Message rendering ────────────────────────────────────────────────────────

function appendMessageEl(role, text, { streaming = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;

  if (role !== "system" && role !== "error") {
    const roleLabel = document.createElement("div");
    roleLabel.className = "message-role";
    roleLabel.textContent = role === "user" ? "You" : "OpenClaw";
    wrap.appendChild(roleLabel);
  }

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  if (streaming) bubble.classList.add("streaming-cursor");
  bubble.textContent = text;
  wrap.appendChild(bubble);

  $messages.appendChild(wrap);
  scrollBottom();
  return bubble;
}

function scrollBottom() {
  $messages.scrollTop = $messages.scrollHeight;
}

function clearMessages() {
  $messages.innerHTML = "";
}

function setTyping(v) {
  $typing.classList.toggle("hidden", !v);
  if (v) scrollBottom();
}

// ─── Port management ──────────────────────────────────────────────────────────

function openPort() {
  if (chatPort) {
    try { chatPort.disconnect(); } catch (_) {}
  }
  chatPort = chrome.runtime.connect({ name: "chat" });
  chatPort.onDisconnect.addListener(() => {
    chatPort = null;
    if (isStreaming) {
      finishStreaming();
    }
  });
  return chatPort;
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function sendMessage() {
  const text = $inputMsg.value.trim();
  if (!text || isStreaming || !settings?.token) return;

  $inputMsg.value = "";
  autoResize($inputMsg);
  hideError();

  appendMessageEl("user", text);
  setTyping(true);
  setSendEnabled(false);
  isStreaming = true;

  let streamingBubble = null;
  let assistantText = "";

  const agentId = settings.agentId || "main";
  const sessionKey = `agent:${agentId}:sidepanel`;

  const port = openPort();

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "START":
        setTyping(false);
        streamingBubble = appendMessageEl("assistant", "", { streaming: true });
        break;

      case "DELTA":
        assistantText += msg.delta;
        if (streamingBubble) {
          streamingBubble.textContent = assistantText;
          scrollBottom();
        }
        break;

      case "DONE":
        if (streamingBubble) streamingBubble.classList.remove("streaming-cursor");
        finishStreaming();
        break;

      case "ABORTED":
        if (streamingBubble) streamingBubble.classList.remove("streaming-cursor");
        if (!assistantText) appendMessageEl("system", "— stopped —");
        finishStreaming();
        break;

      case "ERROR":
        setTyping(false);
        if (streamingBubble) {
          streamingBubble.classList.remove("streaming-cursor");
          streamingBubble.textContent = assistantText || "";
        }
        appendMessageEl("error", `Error: ${msg.message}`);
        showError(msg.message);
        finishStreaming();
        break;
    }
  });

  port.postMessage({ type: "SEND", text, settings, sessionKey });
}

function finishStreaming() {
  isStreaming = false;
  setTyping(false);
  setSendEnabled(true);
  updateSendButton();
}

function stopStreaming() {
  if (chatPort) {
    try { chatPort.disconnect(); } catch (_) {}
    chatPort = null;
  }
  finishStreaming();
}

// ─── Connection test ──────────────────────────────────────────────────────────

async function testConnection(s) {
  // Use a one-shot port to test connectivity
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "chat" });
    const timeout = setTimeout(() => {
      port.disconnect();
      reject(new Error("Connection timeout"));
    }, 6000);

    port.onMessage.addListener((msg) => {
      clearTimeout(timeout);
      port.disconnect();
      if (msg.type === "ERROR") reject(new Error(msg.message));
      else resolve(true);
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timeout);
    });

    port.postMessage({
      type: "SEND",
      text: "ping",
      settings: s,
      sessionKey: `agent:${s.agentId || "main"}:sidepanel-test`,
    });
  });
}

// ─── Settings panel ───────────────────────────────────────────────────────────

// ─── Relay UI ────────────────────────────────────────────────────────────────

function setRelayStatus(state) {
  $relayDot.className = `relay-indicator ${state}`;
  $btnRelay.title = state === 'on'
    ? 'Relay ON — click to detach'
    : state === 'connecting' ? 'Relay connecting…'
    : 'Toggle browser relay on current tab';
}

function subscribeRelayStatus() {
  const port = chrome.runtime.connect({ name: 'relay-status' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'RELAY_STATUS') {
      const state = !msg.connected ? 'off'
        : msg.attachedTabs > 0 ? 'on'
        : 'connecting';
      setRelayStatus(state);
    }
  });
  port.onDisconnect.addListener(() => {
    setTimeout(subscribeRelayStatus, 2000);
  });
}

async function openSettings() {
  const s = await loadSettings();
  $inputUrl.value = s.gatewayUrl;
  $inputToken.value = s.token;
  $inputAgent.value = s.agentId;
  $inputRelayPort.value = s.relayPort || 18792;
  $settingsPanel.classList.remove("hidden");
  settingsOpen = true;
  if (!s.token) $inputToken.focus();
}

function closeSettings() {
  $settingsPanel.classList.add("hidden");
  settingsOpen = false;
}

async function saveAndConnect() {
  const s = {
    gatewayUrl: $inputUrl.value.trim() || DEFAULT_SETTINGS.gatewayUrl,
    token: $inputToken.value.trim(),
    agentId: $inputAgent.value.trim() || "main",
    relayPort: parseInt($inputRelayPort.value) || 18792,
  };
  if (!s.token) { $inputToken.focus(); return; }
  await saveSettings(s);
  closeSettings();
  await init(s);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(s) {
  settings = s || await loadSettings();

  if (!settings.token) {
    setStatus("disconnected", "Not configured");
    setSendEnabled(false);
    openSettings();
    return;
  }

  setStatus("connected", `OpenClaw · ${settings.agentId || "main"}`);
  setSendEnabled(true);
  hideError();
  clearMessages();
}

// ─── Textarea ─────────────────────────────────────────────────────────────────

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

// ─── Event listeners ──────────────────────────────────────────────────────────

$btnSend.addEventListener("click", () => {
  if (isStreaming) stopStreaming();
  else sendMessage();
});

$inputMsg.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!isStreaming) sendMessage();
  }
});

$inputMsg.addEventListener("input", () => {
  autoResize($inputMsg);
  updateSendButton();
});

$btnSettings.addEventListener("click", () => {
  if (settingsOpen) closeSettings();
  else openSettings();
});

$btnCancelSettings.addEventListener("click", closeSettings);
$btnSaveSettings.addEventListener("click", saveAndConnect);
$btnRetry.addEventListener("click", () => init());

$btnNew.addEventListener("click", () => {
  if (!confirm("Start a new conversation?")) return;
  clearMessages();
  appendMessageEl("system", "— new conversation —");
});

$btnRelay.addEventListener("click", async () => {
  setRelayStatus("connecting");
  const result = await chrome.runtime.sendMessage({ type: "RELAY_TOGGLE" });
  if (!result?.ok) {
    setRelayStatus("error");
    showError(result?.error || "Relay toggle failed");
    setTimeout(() => { hideError(); setRelayStatus("off"); }, 3000);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isStreaming) stopStreaming();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
subscribeRelayStatus();
