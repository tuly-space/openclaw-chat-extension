/**
 * relay.js — Browser relay module (merged from OpenClaw Browser Relay extension)
 *
 * Connects to the OpenClaw local relay server exposed via relay.tuly.space.
 * Token is derived: HMAC-SHA256("openclaw-extension-relay-v1:<relayPort>", gatewayToken)
 * matching the openclaw relay server's expected format (port number as context).
 */

// ─── Relay URL & port ─────────────────────────────────────────────────────────

// The local relay server port (gateway port + 3: 18789 + 3 = 18792).
// The relay server is exposed publicly at relay.tuly.space via Cloudflare Tunnel.
const RELAY_PORT = 18792
const RELAY_WS_URL = 'wss://relay.tuly.space/extension'

// ─── Token derivation ─────────────────────────────────────────────────────────

export async function deriveRelayToken(gatewayToken, port) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(gatewayToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(`openclaw-extension-relay-v1:${port}`)
  )
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function buildRelayWsUrl(_gatewayUrl, gatewayToken) {
  const token = String(gatewayToken || '').trim()
  if (!token) throw new Error('Missing gatewayToken')
  const relayToken = await deriveRelayToken(token, RELAY_PORT)
  return `${RELAY_WS_URL}?token=${encodeURIComponent(relayToken)}`
}

function reconnectDelayMs(attempt, opts = {}) {
  const baseMs = opts.baseMs ?? 1000
  const maxMs = opts.maxMs ?? 30000
  const jitterMs = opts.jitterMs ?? 1000
  const backoff = Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs)
  return backoff + jitterMs * Math.random()
}

// ─── Relay state ──────────────────────────────────────────────────────────────

/** @type {WebSocket|null} */
let relayWs = null
let relayConnectPromise = null
let relayGatewayToken = ''
let relayConnectRequestId = null

let nextSession = 1

/** @type {Map<number, {state:string, sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()
/** @type {Map<number|string, {resolve:Function, reject:Function}>} */
const pending = new Map()
/** @type {Set<number>} */
const tabOperationLocks = new Set()
/** @type {Set<number>} */
const reattachPending = new Set()

let reconnectAttempt = 0
let reconnectTimer = null

// Auto-follow mode: relay follows the active tab automatically
// Persisted in chrome.storage.session to survive SW restarts
let followMode = false

async function setFollowMode(v) {
  followMode = v
  try { await chrome.storage.session.set({ relayFollowMode: v }) } catch {}
}

export async function restoreFollowMode() {
  try {
    const s = await chrome.storage.session.get('relayFollowMode')
    followMode = !!s.relayFollowMode
  } catch {}
  return followMode
}

// Status broadcast to side panel
let statusCallback = null
export function onRelayStatus(cb) { statusCallback = cb }

async function getActiveTabTitle() {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    return active?.title || active?.url || null
  } catch { return null }
}

async function broadcastStatus() {
  const attachedTabs = []
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') attachedTabs.push(tabId)
  }
  let tabTitle = null
  if (followMode && attachedTabs.length > 0) {
    try {
      const tab = await chrome.tabs.get(attachedTabs[0])
      tabTitle = tab.title || tab.url || null
    } catch {}
  }
  statusCallback?.({
    connected: !!(relayWs && relayWs.readyState === WebSocket.OPEN),
    attachedTabs,
    followMode,
    tabTitle,
  })
}

// ─── Relay WebSocket ──────────────────────────────────────────────────────────

export function getRelayConnected() {
  return !!(relayWs && relayWs.readyState === WebSocket.OPEN)
}

export function getAttachedTabCount() {
  let n = 0
  for (const [, tab] of tabs) if (tab.state === 'connected') n++
  return n
}

// Resolves when the OpenClaw protocol handshake (connect req/res) completes
let handshakeResolve = null
let handshakeReject = null

export async function ensureRelayConnection(gatewayUrl, gatewayToken) {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const wsUrl = await buildRelayWsUrl(gatewayUrl, gatewayToken)

    const ws = new WebSocket(wsUrl)
    relayWs = ws
    relayGatewayToken = gatewayToken

    ws.onmessage = (evt) => onRelayMessage(String(evt.data || ''))

    // Wait for TCP/WS open
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket connect failed')) }
      ws.onclose = (ev) => { clearTimeout(t); reject(new Error(`WebSocket closed (${ev.code})`)) }
    })

    // Start OpenClaw protocol handshake immediately on open.
    // The gateway also emits connect.challenge right away, but waiting for it
    // adds an unnecessary round-trip and increases the chance of missing the
    // 3s gateway handshake window on remote connections.
    try {
      ensureGatewayHandshakeStarted()
    } catch (e) {
      throw new Error(e?.message || 'Failed to start handshake')
    }

    // Wait for OpenClaw protocol handshake (connect req → res).
    // If a connect.challenge arrives first, onRelayMessage() will call the same
    // starter again, which is safe because ensureGatewayHandshakeStarted() is idempotent.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        handshakeResolve = null
        handshakeReject = null
        reject(new Error('Handshake timeout'))
      }, 8000)
      handshakeResolve = () => { clearTimeout(t); handshakeResolve = null; handshakeReject = null; resolve() }
      handshakeReject = (e) => { clearTimeout(t); handshakeResolve = null; handshakeReject = null; reject(e) }
      // Handle WS close before handshake completes
      const origOnClose = ws.onclose
      ws.onclose = (ev) => { handshakeReject?.(new Error(`WS closed before handshake (${ev.code})`)); origOnClose?.(ev) }
    })

    ws.onclose = () => { if (ws === relayWs) onRelayClosed('closed') }
    ws.onerror = () => { if (ws === relayWs) onRelayClosed('error') }
  })()

  try {
    await relayConnectPromise
    reconnectAttempt = 0
    void broadcastStatus()
  } finally {
    relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  relayWs = null
  relayGatewayToken = ''
  relayConnectRequestId = null
  for (const [, p] of pending) p.reject(new Error(`Relay disconnected (${reason})`))
  pending.clear()
  reattachPending.clear()
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') setBadge(tabId, 'connecting')
  }
  void broadcastStatus()
  scheduleReconnect()
}

export let _scheduleReconnectGatewayUrl = ''
export let _scheduleReconnectToken = ''

function scheduleReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  const delay = reconnectDelayMs(reconnectAttempt)
  reconnectAttempt++
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    try {
      await ensureRelayConnection(_scheduleReconnectGatewayUrl, _scheduleReconnectToken)
      reconnectAttempt = 0
      await reannounceAttachedTabs()
    } catch {
      if (_scheduleReconnectToken) scheduleReconnect()
    }
  }, delay)
}

export function cancelRelayReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  reconnectAttempt = 0
}

// ─── Badge helpers ────────────────────────────────────────────────────────────

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

// ─── Relay persistence ────────────────────────────────────────────────────────

async function persistState() {
  try {
    const tabEntries = []
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
        tabEntries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId, attachOrder: tab.attachOrder })
      }
    }
    await chrome.storage.session.set({ persistedTabs: tabEntries, nextSession })
  } catch {}
}

export async function rehydrateRelayState() {
  // Restore follow mode from session storage (survives SW restart)
  await restoreFollowMode()
  try {
    const stored = await chrome.storage.session.get(['persistedTabs', 'nextSession'])
    if (stored.nextSession) nextSession = Math.max(nextSession, stored.nextSession)
    for (const entry of (stored.persistedTabs || [])) {
      tabs.set(entry.tabId, { state: 'connected', sessionId: entry.sessionId, targetId: entry.targetId, attachOrder: entry.attachOrder })
      tabBySession.set(entry.sessionId, entry.tabId)
      setBadge(entry.tabId, 'on')
    }
    for (const entry of (stored.persistedTabs || [])) {
      try {
        await chrome.tabs.get(entry.tabId)
        await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Runtime.evaluate', { expression: '1', returnByValue: true })
      } catch {
        tabs.delete(entry.tabId)
        tabBySession.delete(entry.sessionId)
        setBadge(entry.tabId, 'off')
      }
    }
  } catch {}
}

async function reannounceAttachedTabs() {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected' || !tab.sessionId || !tab.targetId) continue
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1', returnByValue: true })
    } catch {
      tabs.delete(tabId)
      tabBySession.delete(tab.sessionId)
      setBadge(tabId, 'off')
      continue
    }
    let targetInfo
    try {
      const info = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      targetInfo = info?.targetInfo
    } catch { targetInfo = tab.targetId ? { targetId: tab.targetId } : undefined }

    try {
      sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.attachedToTarget', params: { sessionId: tab.sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false } } })
      setBadge(tabId, 'on')
    } catch {
      setBadge(tabId, 'connecting')
    }
  }
  await persistState()
  void broadcastStatus()
}

// ─── Relay send ───────────────────────────────────────────────────────────────

function sendToRelay(payload) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) throw new Error('Relay not connected')
  relayWs.send(JSON.stringify(payload))
}

// ─── Relay message handler ────────────────────────────────────────────────────

function ensureGatewayHandshakeStarted(_payload) {
  if (relayConnectRequestId) return
  relayConnectRequestId = `ext-${Date.now()}`
  sendToRelay({
    type: 'req', id: relayConnectRequestId, method: 'connect',
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: 'chrome-relay-extension', version: '0.4.0', platform: 'chrome-extension', mode: 'webchat' },
      role: 'operator', scopes: ['operator.read', 'operator.write'],
      caps: [], commands: [],
      auth: relayGatewayToken ? { token: relayGatewayToken } : undefined,
    },
  })
}

async function onRelayMessage(text) {
  let msg
  try { msg = JSON.parse(text) } catch { return }

  if (msg?.type === 'event' && msg.event === 'connect.challenge') {
    try { ensureGatewayHandshakeStarted(msg.payload) } catch (e) {
      relayConnectRequestId = null
      handshakeReject?.(new Error('gateway connect failed'))
      relayWs?.close(4008, 'gateway connect failed')
    }
    return
  }

  if (msg?.type === 'res' && relayConnectRequestId && msg.id === relayConnectRequestId) {
    relayConnectRequestId = null
    if (!msg.ok) {
      handshakeReject?.(new Error('gateway connect rejected'))
      relayWs?.close(4008, 'gateway connect rejected')
    } else {
      handshakeResolve?.()
    }
    return
  }

  if (msg?.method === 'ping') {
    try { sendToRelay({ method: 'pong' }) } catch {}
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (e) {
      sendToRelay({ id: msg.id, error: e instanceof Error ? e.message : String(e) })
    }
  }
}

// ─── CDP command handler ──────────────────────────────────────────────────────

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => { for (const [id, t] of tabs.entries()) { if (t.state === 'connected') return id } return null })()

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try { await chrome.debugger.sendCommand(debuggee, 'Runtime.disable'); await new Promise(r => setTimeout(r, 50)) } catch {}
    return chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise(r => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const toClose = targetId ? getTabByTargetId(targetId) : tabId
    if (!toClose) return { success: false }
    try { await chrome.tabs.remove(toClose) } catch { return { success: false } }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const toActivate = targetId ? getTabByTargetId(targetId) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession = sessionId && mainSessionId && sessionId !== mainSessionId ? { ...debuggee, sessionId } : debuggee
  return chrome.debugger.sendCommand(debuggerSession, method, params)
}

// ─── Tab attach/detach ────────────────────────────────────────────────────────

async function attachTab(tabId, opts = {}) {
  await chrome.debugger.attach({ tabId }, '1.3')
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {})

  const info = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) throw new Error('Target.getTargetInfo returned no targetId')

  const sid = nextSession++
  const sessionId = `cb-tab-${sid}`
  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder: sid })
  tabBySession.set(sessionId, tabId)

  if (!opts.skipAttachedEvent) {
    sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false } } })
  }

  setBadge(tabId, 'on')
  await persistState()
  void broadcastStatus()
  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId !== tabId) continue
    try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: childSessionId, reason: 'parent_detached' } } }) } catch {}
    childSessionToTab.delete(childSessionId)
  }
  if (tab?.sessionId && tab?.targetId) {
    try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetId, reason } } }) } catch {}
  }
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  try { await chrome.debugger.detach({ tabId }) } catch {}
  setBadge(tabId, 'off')
  void chrome.action.setTitle({ tabId, title: 'OpenClaw Chat (click to open)' })
  await persistState()
  void broadcastStatus()
}

// ─── Toggle attach on active tab ──────────────────────────────────────────────

/** Find the best browsable active tab across all windows */
async function findBrowsableActiveTab() {
  // Try lastFocusedWindow first
  let candidates = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const browsable = candidates.filter(t =>
    t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  )
  if (browsable.length > 0) return browsable[0]

  // Fall back: any active tab across all windows
  const all = await chrome.tabs.query({ active: true })
  return all.find(t =>
    t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  ) || null
}

export async function toggleRelayOnActiveTab(gatewayUrl, gatewayToken) {
  // Toggle follow mode off
  if (followMode) {
    await setFollowMode(false)
    for (const [tabId] of [...tabs.entries()]) {
      try { await detachTab(tabId, 'follow-mode-off') } catch {}
    }
    void broadcastStatus()
    return { ok: true, attached: false }
  }

  // Turn on: connect relay and attach current browsable tab
  const active = await findBrowsableActiveTab()
  if (!active?.id) return { ok: false, error: 'No browsable tab found' }
  const tabId = active.id

  _scheduleReconnectGatewayUrl = gatewayUrl
  _scheduleReconnectToken = gatewayToken

  try {
    await ensureRelayConnection(gatewayUrl, gatewayToken)
  } catch (e) {
    return { ok: false, error: e.message }
  }

  if (tabOperationLocks.has(tabId)) return { ok: false, error: 'Operation in progress' }
  tabOperationLocks.add(tabId)

  try {
    await attachTab(tabId)
    await setFollowMode(true)
    void broadcastStatus()
    const tabInfo = await chrome.tabs.get(tabId).catch(() => null)
    return { ok: true, attached: true, tabTitle: tabInfo?.title || null, tabUrl: tabInfo?.url || null }
  } catch (e) {
    tabs.delete(tabId)
    return { ok: false, error: e.message }
  } finally {
    tabOperationLocks.delete(tabId)
  }
}

// ─── Auto-relay on side panel open ───────────────────────────────────────────

export async function autoStartRelay(gatewayUrl, gatewayToken) {
  if (!gatewayToken) return
  _scheduleReconnectGatewayUrl = gatewayUrl
  _scheduleReconnectToken = gatewayToken

  try {
    await ensureRelayConnection(gatewayUrl, gatewayToken)
  } catch {
    scheduleReconnect()
  }
}

// ─── Debugger listeners (called from background.js) ──────────────────────────

export function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }
  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try { sendToRelay({ method: 'forwardCDPEvent', params: { sessionId: source.sessionId || tab.sessionId, method, params } }) } catch {}
}

export async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId || !tabs.has(tabId)) return

  if (reason === 'canceled_by_user' || reason === 'replaced_with_devtools') {
    void detachTab(tabId, reason)
    return
  }

  let tabInfo
  try { tabInfo = await chrome.tabs.get(tabId) } catch {
    void detachTab(tabId, reason)
    return
  }

  if (tabInfo.url?.startsWith('chrome://') || tabInfo.url?.startsWith('chrome-extension://')) {
    void detachTab(tabId, reason)
    return
  }

  if (reattachPending.has(tabId)) return

  const oldTab = tabs.get(tabId)
  if (oldTab?.sessionId) tabBySession.delete(oldTab.sessionId)
  tabs.delete(tabId)
  for (const [cid, pid] of childSessionToTab.entries()) { if (pid === tabId) childSessionToTab.delete(cid) }

  if (oldTab?.sessionId && oldTab?.targetId) {
    try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: oldTab.sessionId, targetId: oldTab.targetId, reason: 'navigation-reattach' } } }) } catch {}
  }

  reattachPending.add(tabId)
  setBadge(tabId, 'connecting')

  const delays = [200, 500, 1000, 2000, 4000]
  for (const delay of delays) {
    await new Promise(r => setTimeout(r, delay))
    if (!reattachPending.has(tabId)) return
    try { await chrome.tabs.get(tabId) } catch { reattachPending.delete(tabId); setBadge(tabId, 'off'); return }
    const relayUp = relayWs && relayWs.readyState === WebSocket.OPEN
    try {
      await attachTab(tabId, { skipAttachedEvent: !relayUp })
      reattachPending.delete(tabId)
      if (!relayUp) setBadge(tabId, 'connecting')
      return
    } catch {}
  }

  reattachPending.delete(tabId)
  setBadge(tabId, 'off')
}

export function onTabRemoved(tabId) {
  reattachPending.delete(tabId)
  if (!tabs.has(tabId)) return
  const tab = tabs.get(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  for (const [cid, pid] of childSessionToTab.entries()) { if (pid === tabId) childSessionToTab.delete(cid) }
  if (tab?.sessionId && tab?.targetId) {
    try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetId, reason: 'tab_closed' } } }) } catch {}
  }
  void persistState()
}

export function onTabReplaced(addedTabId, removedTabId) {
  const tab = tabs.get(removedTabId)
  if (!tab) return
  tabs.delete(removedTabId)
  tabs.set(addedTabId, tab)
  if (tab.sessionId) tabBySession.set(tab.sessionId, addedTabId)
  for (const [cid, pid] of childSessionToTab.entries()) { if (pid === removedTabId) childSessionToTab.set(cid, addedTabId) }
  setBadge(addedTabId, 'on')
  void persistState()
}

export function onWebNavCompleted(tabId) {
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}

export async function onTabActivated(tabId) {
  // Auto-follow: detach all other tabs, attach to the newly active one
  if (followMode && relayWs && relayWs.readyState === WebSocket.OPEN) {
    // Skip chrome:// and extension pages (e.g. side panel window's own tab)
    try {
      const tab = await chrome.tabs.get(tabId)
      const url = tab.url || ''
      if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
          url.startsWith('about:') || url === 'chrome://newtab/') {
        return
      }
    } catch { return }

    // Detach any currently attached tabs (except the new one)
    for (const [attachedTabId, tabState] of tabs.entries()) {
      if (attachedTabId !== tabId && tabState.state === 'connected') {
        await detachTab(attachedTabId, 'follow-mode-switch')
      }
    }
    // broadcastStatus after detach → UI shows "connecting" briefly
    void broadcastStatus()

    // Small yield so the side panel renders the connecting state
    await new Promise(r => setTimeout(r, 80))

    // Attach to new tab if not already attached
    if (!tabs.has(tabId) || tabs.get(tabId).state !== 'connected') {
      if (!tabOperationLocks.has(tabId)) {
        tabOperationLocks.add(tabId)
        try {
          await attachTab(tabId)
          // attachTab calls broadcastStatus → UI shows "on"
        } catch (e) {
          console.warn('follow-mode attach failed:', e.message)
          void broadcastStatus()
        } finally {
          tabOperationLocks.delete(tabId)
        }
      }
    }
    return
  }

  // No follow mode: just refresh badge
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}

export function onTabTitleChanged(tabId) {
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') void broadcastStatus()
}

export async function relayKeepalive(gatewayUrl, gatewayToken) {
  if (tabs.size === 0) return
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    if (!relayConnectPromise && !reconnectTimer && gatewayToken) {
      await ensureRelayConnection(gatewayUrl, gatewayToken).catch(() => { if (!reconnectTimer) scheduleReconnect() })
    }
  }
  void broadcastStatus()
}
