/**
 * sidepanel.js — OpenClaw Chat Side Panel
 * Transport: OpenAI-compatible HTTP SSE endpoint
 * POST /v1/chat/completions with stream:true
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

async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// ─── State ────────────────────────────────────────────────────────────────────

let settings = null;
let isStreaming = false;
let abortController = null;
// Local message history for display (gateway maintains context server-side via session key)
let messages = [];

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

// ─── Message rendering ────────────────────────────────────────────────────────

function appendMessageEl(role, text, { streaming = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;

  if (role !== "system") {
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
  messages = [];
}

function setTyping(v) {
  $typing.classList.toggle("hidden", !v);
  if (v) scrollBottom();
}

// ─── Connection test ──────────────────────────────────────────────────────────

async function testConnection(s) {
  const res = await fetch(`${s.gatewayUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${s.token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

// ─── Send message via HTTP SSE ────────────────────────────────────────────────

async function sendMessage() {
  const text = $inputMsg.value.trim();
  if (!text || isStreaming || !settings?.token) return;

  $inputMsg.value = "";
  autoResize($inputMsg);
  hideError();

  // Add to local history
  messages.push({ role: "user", content: text });
  appendMessageEl("user", text);
  setTyping(true);
  setSendEnabled(false);
  isStreaming = true;

  // Streaming bubble
  let streamingBubble = null;
  let assistantText = "";

  abortController = new AbortController();

  try {
    const agentId = settings.agentId || "main";
    // Use stable session key so gateway maintains context across requests
    const sessionKey = `agent:${agentId}:sidepanel`;

    const res = await fetch(`${settings.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.token}`,
        "Content-Type": "application/json",
        "x-openclaw-session-key": sessionKey,
      },
      body: JSON.stringify({
        model: `openclaw:${agentId}`,
        // Send only the latest message; gateway handles history via session key
        messages: [{ role: "user", content: text }],
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }

    setTyping(false);
    streamingBubble = appendMessageEl("assistant", "", { streaming: true });

    // Parse SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const chunk = JSON.parse(trimmed.slice(6));
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            assistantText += delta;
            streamingBubble.textContent = assistantText;
            scrollBottom();
          }
        } catch (_) {
          // skip malformed chunk
        }
      }
    }

    // Finalize
    if (streamingBubble) {
      streamingBubble.classList.remove("streaming-cursor");
    }
    if (assistantText) {
      messages.push({ role: "assistant", content: assistantText });
    }

  } catch (e) {
    setTyping(false);
    if (streamingBubble) streamingBubble.classList.remove("streaming-cursor");

    if (e.name === "AbortError") {
      if (assistantText) {
        messages.push({ role: "assistant", content: assistantText });
      }
      appendMessageEl("system", "— stopped —");
    } else {
      appendMessageEl("error", `Error: ${e.message}`);
      // Remove failed user message from history
      if (messages[messages.length - 1]?.role === "user") messages.pop();
      showError(e.message);
    }
  } finally {
    abortController = null;
    isStreaming = false;
    setSendEnabled(true);
    setTyping(false);
    updateSendButton();
  }
}

function stopStreaming() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

// ─── Settings panel ───────────────────────────────────────────────────────────

let settingsOpen = false;

async function openSettings() {
  const s = await loadSettings();
  $inputUrl.value = s.gatewayUrl;
  $inputToken.value = s.token;
  $inputAgent.value = s.agentId;
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
  };
  if (!s.token) {
    $inputToken.focus();
    return;
  }
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

  setStatus("connecting", "Connecting…");
  setSendEnabled(false);
  hideError();

  try {
    await testConnection(settings);
    setStatus("connected", `OpenClaw · ${settings.agentId || "main"}`);
    setSendEnabled(true);
    clearMessages();
  } catch (e) {
    setStatus("error", "Connection failed");
    showError(`Cannot reach gateway: ${e.message}`);
    setSendEnabled(false);
  }
}

// ─── Textarea ─────────────────────────────────────────────────────────────────

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

function updateSendButton() {
  $btnSend.disabled = !$inputMsg.value.trim() || isStreaming || !settings?.token;
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

// Send button acts as stop when streaming
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isStreaming) stopStreaming();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
