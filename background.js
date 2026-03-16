/**
 * background.js — Service worker
 * Handles: chat streaming (gateway WS) + browser relay (CDP bridge)
 */

import * as relay from './relay.js'

// ─── Settings ─────────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'openclaw_settings_v1'

async function getSettings() {
  const s = await chrome.storage.local.get(SETTINGS_KEY)
  return { gatewayUrl: 'https://dash.tuly.space', token: '', agentId: 'main', ...(s[SETTINGS_KEY] || {}) }
}

// ─── Open side panel on click ─────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id })
})

// ─── Gateway WebSocket (for chat) ─────────────────────────────────────────────

let gatewayWs = null
let gatewayWsReady = false
let gwPendingRequests = new Map()   // reqId → { resolve, reject }
let gwAgentListeners = new Map()    // sessionKey → Set<(event) => void>
let gwReconnectTimer = null
let gwSettings = null
let gwConnectPromise = null

function gatewayWsUrl(settings) {
  const url = new URL(settings.gatewayUrl)
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${url.host}/`
}

async function ensureGatewayWs(settings) {
  if (gatewayWs && gatewayWsReady) return

  if (gwConnectPromise) return gwConnectPromise

  gwConnectPromise = new Promise((resolve, reject) => {
    if (gwReconnectTimer) { clearTimeout(gwReconnectTimer); gwReconnectTimer = null }

    const ws = new WebSocket(gatewayWsUrl(settings))
    gatewayWs = ws
    gwSettings = settings
    gatewayWsReady = false

    let handshakeDone = false
    let reqId = null

    ws.onmessage = (evt) => {
      let msg
      try { msg = JSON.parse(evt.data) } catch { return }

      // Handshake: gateway sends connect.challenge, but we already sent connect on open.
      // Ignore the challenge — our connect req is already in flight.
      if (!handshakeDone && msg?.type === 'event' && msg.event === 'connect.challenge') {
        return
      }

      // Handshake response
      if (!handshakeDone && msg?.type === 'res' && msg.id === reqId) {
        if (msg.ok) {
          handshakeDone = true
          gatewayWsReady = true
          console.log('[chat-ws] handshake OK')
          resolve()
        } else {
          const err = msg.error?.message || 'Gateway connect rejected'
          console.warn('[chat-ws] handshake rejected:', err)
          reject(new Error(err))
          ws.close()
        }
        return
      }

      // Request responses
      if (msg?.type === 'res' && gwPendingRequests.has(msg.id)) {
        const p = gwPendingRequests.get(msg.id)
        gwPendingRequests.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error?.message || 'Gateway request failed'))
        return
      }

      // Agent events (chat streaming)
      if (msg?.type === 'event' && msg.event === 'agent') {
        const payload = msg.payload
        const sk = payload?.sessionKey
        if (sk && gwAgentListeners.has(sk)) {
          for (const fn of gwAgentListeners.get(sk)) {
            try { fn(payload) } catch {}
          }
        }
        return
      }

      // ping
      if (msg?.method === 'ping') {
        try { ws.send(JSON.stringify({ method: 'pong' })) } catch {}
      }
    }

    ws.onopen = () => {
      console.log('[chat-ws] connected to', gatewayWsUrl(settings))
      // Send connect immediately on open with full operator scopes
      reqId = `chat-${Date.now()}`
      ws.send(JSON.stringify({
        type: 'req', id: reqId, method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'webchat', version: '0.4.0', platform: 'chrome-extension', mode: 'webchat' },
          role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
          caps: [], commands: [],
          auth: { token: settings.token },
        },
      }))
    }

    ws.onerror = (e) => {
      console.warn('[chat-ws] error', e)
      if (!handshakeDone) reject(new Error('Gateway WebSocket connect failed'))
      onGatewayWsClosed()
    }

    ws.onclose = (ev) => {
      console.log('[chat-ws] closed', ev.code, ev.reason)
      if (!handshakeDone) reject(new Error('Gateway WebSocket closed before handshake'))
      onGatewayWsClosed()
    }

    setTimeout(() => {
      if (!handshakeDone) {
        reject(new Error('Gateway handshake timeout'))
        ws.close()
      }
    }, 8000)
  }).finally(() => { gwConnectPromise = null })

  return gwConnectPromise
}

function onGatewayWsClosed() {
  if (gatewayWs) { try { gatewayWs.close() } catch {} }
  gatewayWs = null
  gatewayWsReady = false
  // Reject all pending requests
  for (const [, p] of gwPendingRequests) p.reject(new Error('Gateway WS disconnected'))
  gwPendingRequests.clear()
  // Notify all agent listeners (empty payload = disconnected)
  for (const [, fns] of gwAgentListeners) {
    for (const fn of fns) { try { fn(null) } catch {} }
  }
  gwAgentListeners.clear()
}

function gwRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!gatewayWs || !gatewayWsReady) return reject(new Error('Gateway WS not connected'))
    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
    gwPendingRequests.set(id, { resolve, reject })
    setTimeout(() => {
      if (gwPendingRequests.has(id)) {
        gwPendingRequests.delete(id)
        reject(new Error('Gateway request timeout'))
      }
    }, 30000)
    gatewayWs.send(JSON.stringify({ type: 'req', id, method, params }))
  })
}

function subscribeAgentEvents(sessionKey, fn) {
  if (!gwAgentListeners.has(sessionKey)) gwAgentListeners.set(sessionKey, new Set())
  gwAgentListeners.get(sessionKey).add(fn)
  return () => {
    const fns = gwAgentListeners.get(sessionKey)
    if (fns) { fns.delete(fn); if (!fns.size) gwAgentListeners.delete(sessionKey) }
  }
}

// ─── Chat: long-lived port for WS streaming ───────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'chat') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'SEND') await handleChatStream(port, msg)
    })
    return
  }

  if (port.name === 'relay-status') {
    relay.onRelayStatus((status) => {
      try { port.postMessage({ type: 'RELAY_STATUS', ...status }) } catch {}
    })
    port.postMessage({
      type: 'RELAY_STATUS',
      connected: relay.getRelayConnected(),
      attachedTabs: [],
    })
    return
  }
})

// ─── Chat streaming via Gateway WS ────────────────────────────────────────────

async function handleChatStream(port, msg) {
  const { messages, text, settings, sessionKey } = msg
  let aborted = false
  let unsubscribe = null

  port.onDisconnect.addListener(() => {
    aborted = true
    if (unsubscribe) unsubscribe()
  })

  try {
    await ensureGatewayWs(settings)
  } catch (e) {
    port.postMessage({ type: 'ERROR', message: `Gateway connect failed: ${e.message}` })
    return
  }

  if (aborted) return

  const agentId = settings.agentId || 'main'
  const chatMessages = messages || [{ role: 'user', content: text }]
  const lastMsg = chatMessages[chatMessages.length - 1]

  // Build idempotency key
  const idempotencyKey = `ext-${Date.now()}-${Math.random().toString(36).slice(2)}`

  // Subscribe to agent events for this session before sending
  let started = false
  let doneReceived = false

  unsubscribe = subscribeAgentEvents(sessionKey, (payload) => {
    if (aborted) return
    if (payload === null) {
      // WS disconnected
      if (!doneReceived) port.postMessage({ type: 'ERROR', message: 'Gateway disconnected' })
      return
    }

    const kind = payload?.kind
    const text = payload?.text ?? payload?.delta ?? payload?.chunk ?? ''

    if (!started && kind === 'text' && text) {
      started = true
      port.postMessage({ type: 'START' })
    }

    if (kind === 'text' && text) {
      if (!started) { started = true; port.postMessage({ type: 'START' }) }
      port.postMessage({ type: 'DELTA', delta: text })
      return
    }

    if (kind === 'done' || kind === 'end' || payload?.status === 'done') {
      doneReceived = true
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
      if (started) port.postMessage({ type: 'DONE' })
      else { port.postMessage({ type: 'START' }); port.postMessage({ type: 'DONE' }) }
      return
    }

    if (kind === 'error') {
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
      port.postMessage({ type: 'ERROR', message: payload?.message || 'Agent error' })
      return
    }
  })

  // Send the message via chat.send
  try {
    await gwRequest('chat.send', {
      to: agentId,
      message: typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content),
      sessionKey,
      agentId,
      idempotencyKey,
    })
  } catch (e) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
    port.postMessage({ type: 'ERROR', message: e.message })
    return
  }

  // Start a safety timeout — if no done event in 3 minutes, finish
  setTimeout(() => {
    if (!doneReceived && !aborted) {
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
      port.postMessage({ type: 'DONE' })
    }
  }, 180000)
}

// ─── Messages from side panel ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'clipSelection') {
    handleClipRequest('getSelection')
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ ok: false, error: e.message }))
    return true
  }

  if (msg.action === 'clipPage') {
    handleClipRequest('getPageContent')
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ ok: false, error: e.message }))
    return true
  }

  if (msg.type === 'RELAY_TOGGLE') {
    getSettings().then(s => {
      relay.toggleRelayOnActiveTab(s.gatewayUrl, s.token)
        .then(result => sendResponse(result))
        .catch(e => sendResponse({ ok: false, error: e.message }))
    })
    return true
  }

  if (msg.type === 'RELAY_STATUS_GET') {
    sendResponse({ connected: relay.getRelayConnected(), attachedTabs: relay.getAttachedTabCount() })
    return false
  }
})

async function handleClipRequest(action) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id) return { ok: false, error: 'No active tab found' }
  if (!/^https?:/i.test(tab.url || '')) {
    return { ok: false, error: 'Clip only works on regular web pages' }
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['clipper.js'] })
  } catch (e) {
    return { ok: false, error: e.message || 'Failed to inject clipper' }
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { action })
    return { ok: true, ...result }
  } catch (e) {
    return { ok: false, error: e.message || 'Failed to read page content' }
  }
}

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
  await relay.relayKeepalive(s.gatewayUrl, s.token)
})

// ─── Init ─────────────────────────────────────────────────────────────────────

const initPromise = relay.rehydrateRelayState().then(async () => {
  const s = await getSettings()
  // Pre-connect gateway WS if token is configured
  if (s.token) {
    ensureGatewayWs(s).catch(e => console.warn('[chat-ws] pre-connect failed:', e.message))
  }
  if (s.token && relay.getAttachedTabCount() > 0) {
    await relay.autoStartRelay(s.gatewayUrl, s.token)
  }
})
