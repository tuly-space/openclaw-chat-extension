/**
 * background.js — Service worker
 * Handles: chat streaming (gateway WS, webchat protocol) + browser relay (CDP bridge)
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

// ─── Gateway WebSocket client (webchat protocol) ──────────────────────────────
//
// Copied from openclaw control-ui webchat client (th class in index-UvgeZ3yV.js).
// Key behaviour:
//   1. onopen → queueConnect (750ms delay, lets challenge arrive first)
//   2. connect.challenge → sendConnect immediately (sets connectNonce)
//   3. sendConnect guarded by connectSent flag (runs only once per WS)
//   4. Scopes: operator.admin, operator.approvals, operator.pairing
//   5. All responses dispatched via pending Map (reqId → {resolve, reject})
//   6. All events dispatched via onEvent callback

class GatewayClient {
  constructor(opts) {
    // opts: { url, token, clientName, onEvent, onHello, onClose }
    this.opts = opts
    this.ws = null
    this.pending = new Map()
    this.closed = false
    this.lastSeq = null
    this.connectNonce = null
    this.connectSent = false
    this.connectTimer = null
    this.backoffMs = 800
    this.pendingConnectError = null
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start() {
    this.closed = false
    this._connect()
  }

  stop() {
    this.closed = true
    this.ws?.close()
    this.ws = null
    this._flushPending(new Error('gateway client stopped'))
  }

  _connect() {
    if (this.closed) return
    this.ws = new WebSocket(this.opts.url)
    this.ws.addEventListener('open', () => this._queueConnect())
    this.ws.addEventListener('message', (e) => this._handleMessage(String(e.data ?? '')))
    this.ws.addEventListener('close', (e) => {
      const reason = String(e.reason ?? '')
      const err = this.pendingConnectError
      this.pendingConnectError = null
      this.ws = null
      this._flushPending(new Error(`gateway closed (${e.code}): ${reason}`))
      this.opts.onClose?.({ code: e.code, reason, error: err })
      if (!this.closed) this._scheduleReconnect()
    })
    this.ws.addEventListener('error', () => {})
  }

  _scheduleReconnect() {
    if (this.closed) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15000)
    setTimeout(() => this._connect(), delay)
  }

  _flushPending(err) {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  _queueConnect() {
    this.connectNonce = null
    this.connectSent = false
    if (this.connectTimer !== null) clearTimeout(this.connectTimer)
    // Wait 750ms — if challenge arrives first, sendConnect fires immediately
    this.connectTimer = setTimeout(() => this._sendConnect(), 750)
  }

  async _sendConnect() {
    if (this.connectSent) return
    this.connectSent = true
    if (this.connectTimer !== null) { clearTimeout(this.connectTimer); this.connectTimer = null }

    const token = this.opts.token?.trim() || undefined
    const auth = token ? { token } : undefined
    const params = {
      minProtocol: 3, maxProtocol: 3,
      client: {
        id: this.opts.clientName ?? 'webchat',
        version: '0.4.0',
        platform: 'chrome-extension',
        mode: 'webchat',
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
      caps: ['tool-events'],
      auth,
    }

    try {
      const res = await this.request('connect', params)
      this.backoffMs = 800
      this.opts.onHello?.(res)
      console.log('[gateway-ws] connected')
    } catch (e) {
      this.pendingConnectError = e
      console.warn('[gateway-ws] connect failed:', e.message)
      this.ws?.close(4008, 'connect failed')
    }
  }

  _handleMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg?.type === 'event') {
      if (msg.event === 'connect.challenge') {
        const nonce = typeof msg.payload?.nonce === 'string' ? msg.payload.nonce : null
        if (nonce) this.connectNonce = nonce
        this._sendConnect()
        return
      }
      const seq = typeof msg.seq === 'number' ? msg.seq : null
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          console.warn('[gateway-ws] sequence gap', this.lastSeq + 1, '->', seq)
        }
        this.lastSeq = seq
      }
      try { this.opts.onEvent?.(msg) } catch (e) { console.error('[gateway-ws] event handler error:', e) }
      return
    }

    if (msg?.type === 'res') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.payload)
      else p.reject(Object.assign(new Error(msg.error?.message ?? 'gateway error'), { gatewayCode: msg.error?.code, details: msg.error?.details }))
      return
    }

    if (msg?.method === 'ping') {
      try { this.ws?.send(JSON.stringify({ method: 'pong' })) } catch {}
    }
  }

  request(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('gateway not connected'))
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const frame = { type: 'req', id, method, params }
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.ws.send(JSON.stringify(frame))
    return promise
  }
}

// ─── Gateway client singleton ─────────────────────────────────────────────────

let gatewayClient = null
let agentListeners = new Map()   // sessionKey → Set<fn>

function getGatewayWsUrl(gatewayUrl) {
  // Route through local relay (server/relay.mjs) which rewrites client.id
  // to 'openclaw-control-ui' so gateway retains declared scopes.
  // Relay listens on ws://127.0.0.1:18790 and forwards to the real gateway.
  return 'ws://127.0.0.1:18790'
}

function getRealGatewayWsUrl(gatewayUrl) {
  const u = new URL(gatewayUrl)
  return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}/`
}

async function ensureGatewayClient(settings) {
  if (gatewayClient?.connected) return gatewayClient

  if (gatewayClient) { try { gatewayClient.stop() } catch {} }

  gatewayClient = new GatewayClient({
    url: getGatewayWsUrl(settings.gatewayUrl),
    token: settings.token,
    clientName: 'webchat',
    onEvent: (evt) => {
      if (evt.event === 'chat') {
        const sk = evt.payload?.sessionKey
        if (sk && agentListeners.has(sk)) {
          for (const fn of agentListeners.get(sk)) {
            try { fn(evt.payload) } catch {}
          }
        }
      }
    },
    onClose: () => {
      // Notify all waiting listeners that WS dropped
      for (const [, fns] of agentListeners) {
        for (const fn of fns) { try { fn(null) } catch {} }
      }
      agentListeners.clear()
    },
  })
  gatewayClient.start()

  // Wait for connect to complete (up to 10s)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('gateway connect timeout')), 10000)
    const orig = gatewayClient.opts.onHello
    gatewayClient.opts.onHello = (res) => {
      clearTimeout(t)
      orig?.(res)
      resolve()
    }
    const origClose = gatewayClient.opts.onClose
    gatewayClient.opts.onClose = (info) => {
      clearTimeout(t)
      origClose?.(info)
      reject(new Error(`gateway closed during connect (${info.code})`))
    }
  })

  return gatewayClient
}

function subscribeAgent(sessionKey, fn) {
  if (!agentListeners.has(sessionKey)) agentListeners.set(sessionKey, new Set())
  agentListeners.get(sessionKey).add(fn)
  return () => {
    const fns = agentListeners.get(sessionKey)
    if (fns) { fns.delete(fn); if (!fns.size) agentListeners.delete(sessionKey) }
  }
}

// ─── Chat: long-lived port ────────────────────────────────────────────────────

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

// ─── Chat streaming via gateway WS (webchat protocol) ────────────────────────

async function handleChatStream(port, msg) {
  const { messages, text, settings, sessionKey } = msg
  let aborted = false
  let unsubscribe = null

  port.onDisconnect.addListener(() => {
    aborted = true
    if (unsubscribe) unsubscribe()
  })

  // Connect / reuse gateway WS
  let client
  try {
    client = await ensureGatewayClient(settings)
  } catch (e) {
    port.postMessage({ type: 'ERROR', message: `Gateway connect failed: ${e.message}` })
    return
  }
  if (aborted) return

  const agentId = settings.agentId || 'main'
  const chatMessages = messages || [{ role: 'user', content: text }]
  const lastMsg = chatMessages[chatMessages.length - 1]
  const msgText = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content)
  const idempotencyKey = `ext-${Date.now()}-${Math.random().toString(36).slice(2)}`

  let started = false
  let doneReceived = false
  let safetyTimer = null

  const finish = (type) => {
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null }
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
    port.postMessage({ type })
  }

  // Subscribe to chat events for this session.
  // Gateway chat events use state: 'delta' | 'final' | 'aborted' | 'error'.
  // Delta payloads carry cumulative text in message.content[0].text (not incremental),
  // so we track the last sent length and compute the new suffix ourselves.
  let lastSentLength = 0
  unsubscribe = subscribeAgent(sessionKey, (payload) => {
    if (aborted) return

    if (payload === null) {
      // WS dropped
      if (!doneReceived) port.postMessage({ type: 'ERROR', message: 'Gateway disconnected' })
      return
    }

    const state = payload?.state

    if (state === 'delta') {
      // Extract cumulative text from message.content[0].text
      const msg = payload?.message
      let fullText = ''
      if (msg && Array.isArray(msg.content) && msg.content.length > 0) {
        const block = msg.content[0]
        if (block?.type === 'text' && typeof block.text === 'string') {
          fullText = block.text
        }
      } else if (typeof msg?.text === 'string') {
        fullText = msg.text
      }
      if (!fullText) return
      const delta = fullText.slice(lastSentLength)
      if (!delta) return
      lastSentLength = fullText.length
      if (!started) { started = true; port.postMessage({ type: 'START' }) }
      port.postMessage({ type: 'DELTA', delta })
      return
    }

    if (state === 'final') {
      doneReceived = true
      if (!started) { started = true; port.postMessage({ type: 'START' }) }
      finish('DONE')
      return
    }

    if (state === 'aborted') {
      doneReceived = true
      finish('ABORTED')
      return
    }

    if (state === 'error') {
      finish('ERROR')
      port.postMessage({ type: 'ERROR', message: payload?.errorMessage || 'Agent error' })
      return
    }
  })

  // Send the message
  try {
    await client.request('chat.send', {
      sessionKey,
      message: msgText,
      deliver: false,
      idempotencyKey,
    })
  } catch (e) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
    port.postMessage({ type: 'ERROR', message: e.message })
    return
  }

  // Safety timeout: 3 minutes
  safetyTimer = setTimeout(() => {
    if (!doneReceived && !aborted) finish('DONE')
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

  // Expose sessions.list via WS for side panel
  if (msg.type === 'SESSIONS_LIST') {
    getSettings().then(async (settings) => {
      try {
        const client = await ensureGatewayClient(settings)
        const result = await client.request('sessions.list', msg.params || {})
        sendResponse({ ok: true, result })
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
      }
    })
    return true
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
  if (s.token) {
    ensureGatewayClient(s).catch(e => console.warn('[gateway-ws] pre-connect failed:', e.message))
  }
  if (s.token && relay.getAttachedTabCount() > 0) {
    await relay.autoStartRelay(s.gatewayUrl, s.token)
  }
})
