/**
 * sidepanel.js — OpenClaw Chat Side Panel
 * Chat with conversation history, markdown, syntax highlighting, relay status
 */

import {
  listConversations, loadConversation, createConversation,
  appendMessage, deleteConversation,
} from './conversations.js';



// ─── Settings ────────────────────────────────────────────────────────────────

const SETTINGS_KEY = "openclaw_settings_v1";
const DEFAULT_SETTINGS = { gatewayUrl: "https://dash.tuly.space", token: "", agentId: "main", relayPort: 18792 };

async function loadSettings() {
  const s = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s[SETTINGS_KEY] || {}) };
}
async function saveSettings(s) { await chrome.storage.local.set({ [SETTINGS_KEY]: s }); }

// ─── State ────────────────────────────────────────────────────────────────────

let settings = null;
let isStreaming = false;
let chatPort = null;
let settingsOpen = false;
let historyOpen = false;
let currentConv = null;   // full conversation object

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $status        = document.getElementById("status-dot");
const $headerName    = document.getElementById("header-name");
const $errorBanner   = document.getElementById("error-banner");
const $errorText     = document.getElementById("error-text");
const $btnRetry      = document.getElementById("btn-retry");
const $settingsPanel = document.getElementById("settings-panel");
const $messages      = document.getElementById("messages");
const $typing        = document.getElementById("typing-indicator");
const $inputMsg      = document.getElementById("input-msg");
const $btnSend       = document.getElementById("btn-send");
const $btnSettings   = document.getElementById("btn-settings");
const $btnNew        = document.getElementById("btn-new");
const $btnHistory    = document.getElementById("btn-history");
const $btnHistoryClose = document.getElementById("btn-history-close");
const $historyPanel  = document.getElementById("history-panel");
const $historyList   = document.getElementById("history-list");
const $btnRelay      = document.getElementById("btn-relay");
const $relayDot      = document.getElementById("relay-dot");
const $relayTabBar   = document.getElementById("relay-tab-bar");
const $relayTabTitle = document.getElementById("relay-tab-title");
const $btnAttach     = document.getElementById("btn-attach");
const $fileInput     = document.getElementById("file-input");
const $attachPreview = document.getElementById("attachments-preview");
const $btnSaveSettings    = document.getElementById("btn-save-settings");
const $btnCancelSettings  = document.getElementById("btn-cancel-settings");
const $inputUrl      = document.getElementById("input-url");
const $inputToken    = document.getElementById("input-token");
const $inputAgent    = document.getElementById("input-agent");
const $inputRelayPort= document.getElementById("input-relay-port");
const $hljsTheme     = document.getElementById("hljs-theme");
const $btnTheme      = document.getElementById("btn-theme");
const $btnFontUp     = document.getElementById("btn-font-up");
const $btnFontDown   = document.getElementById("btn-font-down");

// ─── Theme ────────────────────────────────────────────────────────────────────

let isDark = localStorage.getItem("oc_theme") !== "light";

function applyTheme(dark) {
  isDark = dark;
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  $hljsTheme.href = dark ? "hljs-dark.css" : "hljs-light.css";
  $btnTheme.textContent = dark ? "🌙" : "☀️";
  localStorage.setItem("oc_theme", dark ? "dark" : "light");
}

$btnTheme.addEventListener("click", () => applyTheme(!isDark));
applyTheme(isDark);

// ─── Font size ────────────────────────────────────────────────────────────────

const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18];
let fontSizeIdx = FONT_SIZES.indexOf(parseInt(localStorage.getItem("oc_fontsize")) || 13);
if (fontSizeIdx < 0) fontSizeIdx = 2; // default 13px

function applyFontSize(idx) {
  fontSizeIdx = Math.max(0, Math.min(FONT_SIZES.length - 1, idx));
  const size = FONT_SIZES[fontSizeIdx];
  document.documentElement.style.setProperty("--font-size", size + "px");
  localStorage.setItem("oc_fontsize", size);
}

$btnFontUp.addEventListener("click", () => applyFontSize(fontSizeIdx + 1));
$btnFontDown.addEventListener("click", () => applyFontSize(fontSizeIdx - 1));
applyFontSize(fontSizeIdx);

// ─── Attachments ──────────────────────────────────────────────────────────────

let pendingAttachments = []; // [{name, type, dataUrl}]

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function isImageFile(file) {
  return file.type.startsWith("image/");
}

function isTextFile(file) {
  const textTypes = ["text/", "application/json", "application/xml"];
  const textExts = [".txt", ".md", ".json", ".csv", ".log", ".xml", ".yaml", ".yml", ".toml", ".js", ".ts", ".py", ".sh", ".html", ".css"];
  if (textTypes.some(t => file.type.startsWith(t))) return true;
  return textExts.some(e => file.name.toLowerCase().endsWith(e));
}

async function addFiles(files) {
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) {
      showError(`${file.name} too large (max 20MB)`);
      continue;
    }
    if (isImageFile(file)) {
      const dataUrl = await readFileAsDataUrl(file);
      pendingAttachments.push({ name: file.name, type: "image", dataUrl });
    } else if (isTextFile(file)) {
      const text = await readFileAsText(file);
      pendingAttachments.push({ name: file.name, type: "text", text });
    } else {
      // Binary files as base64
      const dataUrl = await readFileAsDataUrl(file);
      pendingAttachments.push({ name: file.name, type: "binary", dataUrl });
    }
  }
  renderAttachmentPreview();
}

function removeAttachment(idx) {
  pendingAttachments.splice(idx, 1);
  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  $attachPreview.innerHTML = "";
  if (pendingAttachments.length === 0) {
    $attachPreview.classList.add("hidden");
    return;
  }
  $attachPreview.classList.remove("hidden");
  pendingAttachments.forEach((a, i) => {
    const item = document.createElement("div");
    item.className = "attach-item";

    if (a.type === "image") {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      item.appendChild(img);
    }

    const name = document.createElement("span");
    name.className = "attach-item-name";
    name.textContent = a.name;
    item.appendChild(name);

    const rm = document.createElement("button");
    rm.className = "attach-item-remove";
    rm.textContent = "✕";
    rm.addEventListener("click", () => removeAttachment(i));
    item.appendChild(rm);

    $attachPreview.appendChild(item);
  });
  updateSendButton();
}

function buildContentParts(text) {
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const a of pendingAttachments) {
    if (a.type === "image") {
      parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
    } else if (a.type === "text") {
      parts.push({ type: "text", text: `[File: ${a.name}]\n${a.text}` });
    } else {
      parts.push({ type: "text", text: `[Attached binary file: ${a.name}]` });
    }
  }
  return parts.length === 1 && parts[0].type === "text" ? text : parts;
}

function clearAttachments() {
  pendingAttachments = [];
  renderAttachmentPreview();
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

if (typeof marked !== "undefined") {
  marked.use({
    gfm: true, breaks: true,
    renderer: (() => {
      const r = new marked.Renderer();
      r.code = ({ text, lang }) => {
        const validLang = lang && hljs?.getLanguage?.(lang) ? lang : null;
        const hl = validLang
          ? hljs.highlight(text, { language: validLang }).value
          : (typeof hljs !== "undefined" ? hljs.highlightAuto(text).value : escapeHtml(text));
        return `<pre><code class="hljs${validLang ? ` language-${validLang}` : ''}">${hl}</code></pre>`;
      };
      return r;
    })(),
  });
}

function renderMarkdown(text) {
  if (typeof marked === "undefined") return escapeHtml(text).replace(/\n/g, "<br>");
  try { return marked.parse(text); } catch { return escapeHtml(text); }
}

function escapeHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
          .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// ─── Message rendering ────────────────────────────────────────────────────────

function appendMessageEl(role, text, { streaming = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;

  if (role !== "system" && role !== "error") {
    const lbl = document.createElement("div");
    lbl.className = "message-role";
    lbl.textContent = role === "user" ? "You" : "OpenClaw";
    wrap.appendChild(lbl);
  }

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  if (streaming) bubble.classList.add("streaming-cursor");
  if (role === "assistant") {
    bubble.classList.add("markdown");
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }

  wrap.appendChild(bubble);
  $messages.appendChild(wrap);
  scrollBottom();
  return bubble;
}

function scrollBottom() { $messages.scrollTop = $messages.scrollHeight; }
function clearMessages() { $messages.innerHTML = ""; }
function setTyping(v) { $typing.classList.toggle("hidden", !v); if (v) scrollBottom(); }
function showError(msg) { $errorText.textContent = msg; $errorBanner.classList.remove("hidden"); }
function hideError() { $errorBanner.classList.add("hidden"); }
function setSendEnabled(v) { $btnSend.disabled = !v; }
function updateSendButton() { $btnSend.disabled = (!$inputMsg.value.trim() && pendingAttachments.length === 0) || isStreaming || !settings?.token; }
function setStatus(state, label) { $status.className = `dot ${state}`; if (label) $headerName.textContent = label; }

// ─── Load conversation into UI ────────────────────────────────────────────────

function renderConversation(conv) {
  clearMessages();
  for (const m of conv.messages) {
    if (m.role === "user" || m.role === "assistant") {
      appendMessageEl(m.role, m.content);
    }
  }
}

// ─── History panel ────────────────────────────────────────────────────────────

async function openHistory() {
  historyOpen = true;
  $historyPanel.classList.remove("hidden");
  await refreshHistoryList();
}



function closeHistory() {
  historyOpen = false;
  $historyPanel.classList.add("hidden");
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function makeHistoryItem({ key, title, subtitle, isCurrent, onSelect, onDelete }) {
  const item = document.createElement("div");
  item.className = "history-item" + (isCurrent ? " active" : "");

  const info = document.createElement("div");
  info.className = "history-item-info";
  info.addEventListener("click", onSelect);

  const t = document.createElement("div");
  t.className = "history-item-title";
  t.textContent = title;

  const s = document.createElement("div");
  s.className = "history-item-time";
  s.textContent = subtitle;

  info.appendChild(t);
  info.appendChild(s);
  item.appendChild(info);

  if (onDelete) {
    const del = document.createElement("button");
    del.className = "history-item-delete";
    del.title = "Delete";
    del.textContent = "🗑";
    del.addEventListener("click", async (e) => { e.stopPropagation(); await onDelete(); });
    item.appendChild(del);
  }

  return item;
}

async function refreshHistoryList() {
  $historyList.innerHTML = "";
  const convs = await listConversations();

  if (convs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No conversations yet";
    $historyList.appendChild(empty);
    return;
  }

  for (const c of convs) {
    $historyList.appendChild(makeHistoryItem({
      key: c.id,
      title: c.title,
      subtitle: relativeTime(c.updatedAt),
      isCurrent: currentConv?.id === c.id,
      onSelect: () => switchConversation(c.id),
      onDelete: () => deleteConversationItem(c.id),
    }));
  }
}

async function switchConversation(id) {
  const conv = await loadConversation(id);
  if (!conv) return;
  currentConv = conv;
  renderConversation(conv);
  closeHistory();
}

async function deleteConversationItem(id) {
  await deleteConversation(id);
  if (currentConv?.id === id) {
    currentConv = await createConversation();
    clearMessages();
  }
  await refreshHistoryList();
}

async function newConversation() {
  if (isStreaming) stopStreaming();
  currentConv = await createConversation();
  clearMessages();
}

// ─── Port management ──────────────────────────────────────────────────────────

function openPort() {
  if (chatPort) { try { chatPort.disconnect(); } catch (_) {} }
  chatPort = chrome.runtime.connect({ name: "chat" });
  chatPort.onDisconnect.addListener(() => {
    chatPort = null;
    if (isStreaming) finishStreaming();
  });
  return chatPort;
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function sendMessage() {
  const text = $inputMsg.value.trim();
  if ((!text && pendingAttachments.length === 0) || isStreaming || !settings?.token) return;

  $inputMsg.value = "";
  autoResize($inputMsg);
  hideError();

  // Build content (text only or multi-part with attachments)
  const content = buildContentParts(text);
  const hasAttachments = pendingAttachments.length > 0;
  const attachNames = pendingAttachments.map(a => a.name);

  // Save user message locally (text only for display)
  const displayText = hasAttachments ? `${text}\n📎 ${attachNames.join(", ")}` : text;
  await appendMessage(currentConv, "user", text);

  appendMessageEl("user", displayText);
  clearAttachments();
  setTyping(true);
  setSendEnabled(false);
  isStreaming = true;

  let streamingBubble = null;
  let assistantText = "";

  const agentId = settings.agentId || "main";
  const sessionKey = `agent:${agentId}:conv-${currentConv.id}`;

  // Build full message history; last message uses content parts if attachments
  const messages = currentConv.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: "user", content });

  const port = openPort();

  port.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case "START":
        setTyping(false);
        streamingBubble = appendMessageEl("assistant", "", { streaming: true });
        break;

      case "DELTA":
        assistantText += msg.delta;
        if (streamingBubble) { streamingBubble.innerHTML = renderMarkdown(assistantText); scrollBottom(); }
        break;

      case "DONE":
        if (streamingBubble) streamingBubble.classList.remove("streaming-cursor");
        if (assistantText) await appendMessage(currentConv, "assistant", assistantText);
        finishStreaming();
        break;

      case "ABORTED":
        if (streamingBubble) streamingBubble.classList.remove("streaming-cursor");
        if (!assistantText) appendMessageEl("system", "— stopped —");
        else { streamingBubble.innerHTML = renderMarkdown(assistantText); await appendMessage(currentConv, "assistant", assistantText); }
        finishStreaming();
        break;

      case "ERROR":
        setTyping(false);
        if (streamingBubble) { streamingBubble.classList.remove("streaming-cursor"); streamingBubble.innerHTML = renderMarkdown(assistantText || ""); }
        if (assistantText) await appendMessage(currentConv, "assistant", assistantText);
        appendMessageEl("error", `Error: ${msg.message}`);
        showError(msg.message);
        finishStreaming();
        break;
    }
  });

  port.postMessage({ type: "SEND", messages, settings, sessionKey });
}

function finishStreaming() {
  isStreaming = false;
  setTyping(false);
  setSendEnabled(true);
  updateSendButton();
}

function stopStreaming() {
  if (chatPort) { try { chatPort.disconnect(); } catch (_) {} chatPort = null; }
  finishStreaming();
}

// ─── Settings ─────────────────────────────────────────────────────────────────

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

function closeSettings() { $settingsPanel.classList.add("hidden"); settingsOpen = false; }

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

// ─── Relay UI ─────────────────────────────────────────────────────────────────

function setRelayStatus(state) {
  $relayDot.className = `relay-indicator ${state}`;
}

function subscribeRelayStatus() {
  const port = chrome.runtime.connect({ name: "relay-status" });
  port.onMessage.addListener((msg) => {
    if (msg.type !== "RELAY_STATUS") return;
    const hasAttached = Array.isArray(msg.attachedTabs) ? msg.attachedTabs.length > 0 : msg.attachedTabs > 0;
    const state = !msg.followMode ? "off" : !msg.connected ? "connecting" : hasAttached ? "on" : "connecting";
    setRelayStatus(state);
    $btnRelay.title = msg.followMode ? "Relay ON — following active tab (click to stop)" : "Enable relay — will follow active tab";
    if (msg.followMode && msg.tabTitle) {
      $relayTabTitle.textContent = msg.tabTitle;
      $relayTabBar.classList.remove("hidden");
    } else {
      $relayTabBar.classList.add("hidden");
      $relayTabTitle.textContent = "";
    }
  });
  port.onDisconnect.addListener(() => setTimeout(subscribeRelayStatus, 2000));
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

  // Restore last conversation or create new
  const convs = await listConversations();
  if (convs.length > 0) {
    currentConv = await loadConversation(convs[0].id);
    if (currentConv) {
      renderConversation(currentConv);
    } else {
      currentConv = await createConversation();
      clearMessages();
    }
  } else {
    currentConv = await createConversation();
    clearMessages();
  }
}

// ─── Textarea ─────────────────────────────────────────────────────────────────

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

// ─── Event listeners ──────────────────────────────────────────────────────────

$btnSend.addEventListener("click", () => { if (isStreaming) stopStreaming(); else sendMessage(); });

$inputMsg.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!isStreaming) sendMessage(); }
});

$inputMsg.addEventListener("input", () => { autoResize($inputMsg); updateSendButton(); });

$btnSettings.addEventListener("click", () => { if (settingsOpen) closeSettings(); else openSettings(); });
$btnCancelSettings.addEventListener("click", closeSettings);
$btnSaveSettings.addEventListener("click", saveAndConnect);
$btnRetry.addEventListener("click", () => init());

$btnNew.addEventListener("click", newConversation);

$btnHistory.addEventListener("click", () => { if (historyOpen) closeHistory(); else openHistory(); });
$btnHistoryClose.addEventListener("click", closeHistory);

$btnRelay.addEventListener("click", async () => {
  setRelayStatus("connecting");
  const result = await chrome.runtime.sendMessage({ type: "RELAY_TOGGLE" });
  if (!result?.ok) {
    setRelayStatus("error");
    showError(result?.error || "Relay toggle failed");
    setTimeout(() => { hideError(); setRelayStatus("off"); }, 3000);
  }
});

$btnAttach.addEventListener("click", () => $fileInput.click());
$fileInput.addEventListener("change", async () => {
  if ($fileInput.files.length > 0) await addFiles($fileInput.files);
  $fileInput.value = "";
});

// Drag & drop on input area
$inputMsg.addEventListener("dragover", (e) => { e.preventDefault(); });
$inputMsg.addEventListener("drop", async (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length > 0) await addFiles(e.dataTransfer.files);
});

// Paste images
$inputMsg.addEventListener("paste", async (e) => {
  const files = [...(e.clipboardData?.items || [])]
    .filter(item => item.kind === "file")
    .map(item => item.getAsFile())
    .filter(Boolean);
  if (files.length > 0) {
    e.preventDefault();
    await addFiles(files);
  }
});

document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (isStreaming) stopStreaming(); else if (historyOpen) closeHistory(); else if (settingsOpen) closeSettings(); } });

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
subscribeRelayStatus();
