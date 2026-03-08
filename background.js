/**
 * background.js — Service worker
 * Handles: chat streaming (CORS bypass) + browser relay (CDP bridge)
 */

import * as relay from './relay.js'

// ─── Settings ─────────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'openclaw_settings_v1'
const DEFAULT_RELAY_PORT = 18792

async function getSettings() {
  const s = await chrome.storage.local.get(SETTINGS_KEY)
  return { gatewayUrl: 'https://dash.tuly.space', token: '', agentId: 'main', relayPort: DEFAULT_RELAY_PORT, ...(s[SETTINGS_KEY] || {}) }
}

// ─── Open side panel on click ─────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id })
})

// ─── Chat: long-lived port for SSE streaming ──────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'chat') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'SEND') await handleChatStream(port, msg)
    })
    return
  }

  if (port.name === 'relay-status') {
    // Side panel subscribes to relay status updates
    relay.onRelayStatus((status) => {
      try { port.postMessage({ type: 'RELAY_STATUS', ...status }) } catch {}
    })
    // Send current status immediately
    port.postMessage({
      type: 'RELAY_STATUS',
      connected: relay.getRelayConnected(),
      attachedTabs: [],
    })
    return
  }
})

// ─── Chat streaming ───────────────────────────────────────────────────────────

async function handleChatStream(port, msg) {
  // `messages` = full conversation history; `text` = latest user message (legacy fallback)
  const { text, messages, settings, sessionKey } = msg
  const ac = new AbortController()

  port.onDisconnect.addListener(() => ac.abort())

  try {
    const agentId = settings.agentId || 'main'
    const chatMessages = messages || [{ role: 'user', content: text }]
    const res = await fetch(`${settings.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.token}`,
        'Content-Type': 'application/json',
        'x-openclaw-session-key': sessionKey,
      },
      body: JSON.stringify({
        model: `openclaw:${agentId}`,
        messages: chatMessages,
        stream: true,
      }),
      signal: ac.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      port.postMessage({ type: 'ERROR', message: `HTTP ${res.status}: ${body.slice(0, 200)}` })
      return
    }

    port.postMessage({ type: 'START' })

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]') continue
        if (!trimmed.startsWith('data: ')) continue
        try {
          const chunk = JSON.parse(trimmed.slice(6))
          const delta = chunk.choices?.[0]?.delta?.content
          if (delta) port.postMessage({ type: 'DELTA', delta })
        } catch {}
      }
    }

    port.postMessage({ type: 'DONE' })
  } catch (e) {
    if (e.name === 'AbortError') port.postMessage({ type: 'ABORTED' })
    else port.postMessage({ type: 'ERROR', message: e.message })
  }
}

// ─── Messages from side panel ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'RELAY_TOGGLE') {
    getSettings().then(s => {
      const port = s.relayPort || DEFAULT_RELAY_PORT
      relay.toggleRelayOnActiveTab(port, s.token)
        .then(result => sendResponse(result))
        .catch(e => sendResponse({ ok: false, error: e.message }))
    })
    return true // async
  }

  if (msg.type === 'RELAY_STATUS_GET') {
    sendResponse({ connected: relay.getRelayConnected(), attachedTabs: relay.getAttachedTabCount() })
    return false
  }
})

// ─── Relay: debugger + tab lifecycle ─────────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => relay.onDebuggerEvent(source, method, params))
chrome.debugger.onDetach.addListener((source, reason) => relay.onDebuggerDetach(source, reason))

chrome.tabs.onRemoved.addListener((tabId) => relay.onTabRemoved(tabId))
chrome.tabs.onReplaced.addListener((addedId, removedId) => relay.onTabReplaced(addedId, removedId))
chrome.tabs.onActivated.addListener(({ tabId }) => relay.onTabActivated(tabId))
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title || changeInfo.status === 'complete') relay.onTabTitleChanged(tabId)
})

chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) relay.onWebNavCompleted(tabId)
})

// ─── Keepalive alarm ──────────────────────────────────────────────────────────

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'keepalive') return
  await initPromise
  const s = await getSettings()
  await relay.relayKeepalive(s.relayPort || DEFAULT_RELAY_PORT, s.token)
})

// ─── Init ─────────────────────────────────────────────────────────────────────

const initPromise = relay.rehydrateRelayState().then(async () => {
  const s = await getSettings()
  if (s.token && relay.getAttachedTabCount() > 0) {
    await relay.autoStartRelay(s.relayPort || DEFAULT_RELAY_PORT, s.token)
  }
})
