/**
 * gateway-ws.js — Minimal OpenClaw Gateway WebSocket client
 *
 * Handles: Ed25519 device auth, connect handshake, RPC calls.
 * Used for sessions.list and chat.history (read-only, no streaming).
 */

const DEVICE_KEY = 'oc_device_identity'

// ─── Device identity ──────────────────────────────────────────────────────────

async function getOrCreateDeviceIdentity() {
  const stored = await chrome.storage.local.get(DEVICE_KEY)
  if (stored[DEVICE_KEY]) return stored[DEVICE_KEY]

  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])

  const pubRaw = await crypto.subtle.exportKey('raw', kp.publicKey)
  const privPkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey)

  const pubHex = [...new Uint8Array(pubRaw)].map(b => b.toString(16).padStart(2, '0')).join('')
  const privBase64 = btoa(String.fromCharCode(...new Uint8Array(privPkcs8)))

  // Device ID = first 16 chars of sha256(pubkey)
  const hash = await crypto.subtle.digest('SHA-256', pubRaw)
  const deviceId = 'ext-' + [...new Uint8Array(hash)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')

  const identity = { deviceId, pubHex, privBase64 }
  await chrome.storage.local.set({ [DEVICE_KEY]: identity })
  return identity
}

function normalizeForAuth(v) {
  if (!v || v === 'null' || v === 'undefined') return ''
  return String(v).trim().toLowerCase().replace(/[^a-z0-9_\-. ]/g, '').trim() || ''
}

async function signPayload(privBase64, payload) {
  const privBuf = Uint8Array.from(atob(privBase64), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', privBuf, { name: 'Ed25519' }, false, ['sign'])
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(payload))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

// ─── Gateway WS client ────────────────────────────────────────────────────────

export class GatewayWsClient {
  #ws = null
  #pending = new Map()
  #reqId = 1
  #ready = false
  #readyResolve = null
  #readyReject = null
  #readyPromise = null

  async connect(gatewayWsUrl, token) {
    if (this.#ws?.readyState === WebSocket.OPEN) return
    this.#ready = false
    this.#readyPromise = new Promise((res, rej) => { this.#readyResolve = res; this.#readyReject = rej })

    const identity = await getOrCreateDeviceIdentity()
    this.#ws = new WebSocket(gatewayWsUrl)

    this.#ws.onmessage = async (evt) => {
      let msg
      try { msg = JSON.parse(evt.data) } catch { return }

      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        try {
          const nonce = String(msg.payload?.nonce || '')
          const signedAtMs = Date.now()
          const scopes = ['operator.read', 'operator.write']
          const payloadStr = [
            'v3',
            identity.deviceId,
            'openclaw-chat-extension',
            'webchat',
            'operator',
            scopes.join(','),
            String(signedAtMs),
            token ?? '',
            nonce,
            normalizeForAuth('chrome-extension'),
            normalizeForAuth('browser'),
          ].join('|')

          const sig = await signPayload(identity.privBase64, payloadStr)

          this.#ws.send(JSON.stringify({
            type: 'req', id: 'connect', method: 'connect',
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: 'webchat-ui', version: '1.2.0', platform: 'chrome-extension', mode: 'webchat', deviceFamily: 'browser' },
              role: 'operator', scopes, caps: [], commands: [],
              auth: { token },
              device: {
                id: identity.deviceId,
                publicKey: identity.pubHex,
                signature: sig,
                signedAt: signedAtMs,
                nonce,
              },
            },
          }))
        } catch (e) {
          this.#readyReject?.(e)
          this.#ws.close()
        }
        return
      }

      if (msg.type === 'res' && msg.id === 'connect') {
        if (msg.ok) {
          this.#ready = true
          this.#readyResolve?.()
        } else {
          this.#readyReject?.(new Error(`Gateway connect failed: ${msg.error?.message || JSON.stringify(msg.error)}`))
          this.#ws.close()
        }
        return
      }

      if (msg.type === 'res') {
        const p = this.#pending.get(msg.id)
        if (!p) return
        this.#pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error?.message || 'RPC error'))
      }
    }

    this.#ws.onerror = () => {
      this.#readyReject?.(new Error('WebSocket error'))
    }
    this.#ws.onclose = () => {
      this.#ready = false
      for (const [, p] of this.#pending) p.reject(new Error('WebSocket closed'))
      this.#pending.clear()
    }

    await Promise.race([
      this.#readyPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Gateway WS connect timeout')), 10000))
    ])
  }

  async call(method, params) {
    if (!this.#ready || this.#ws?.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected')
    }
    const id = `rpc-${this.#reqId++}`
    const result = await Promise.race([
      new Promise((resolve, reject) => {
        this.#pending.set(id, { resolve, reject })
        this.#ws.send(JSON.stringify({ type: 'req', id, method, params }))
      }),
      new Promise((_, rej) => setTimeout(() => {
        this.#pending.delete(id)
        rej(new Error(`RPC timeout: ${method}`))
      }, 15000))
    ])
    return result
  }

  close() {
    this.#ws?.close()
    this.#ws = null
    this.#ready = false
  }

  get connected() { return this.#ready && this.#ws?.readyState === WebSocket.OPEN }
}

// ─── Public helpers ───────────────────────────────────────────────────────────

let _client = null

function getWsUrl(gatewayUrl) {
  // Convert https:// → wss://, http:// → ws://
  return gatewayUrl.replace(/^https?:\/\//, (m) => m.startsWith('https') ? 'wss://' : 'ws://')
}

async function getClient(settings) {
  if (_client?.connected) return _client
  if (_client) { _client.close(); _client = null }
  _client = new GatewayWsClient()
  await _client.connect(getWsUrl(settings.gatewayUrl), settings.token)
  return _client
}

/** List sessions from gateway with titles + last message preview */
export async function listGatewaySessions(settings, opts = {}) {
  const client = await getClient(settings)
  const result = await client.call('sessions.list', {
    limit: opts.limit || 30,
    includeDerivedTitles: true,
    includeLastMessage: true,
    agentId: settings.agentId || 'main',
  })
  return result?.sessions || []
}

/** Load chat history for a session key */
export async function loadGatewayChatHistory(settings, sessionKey, limit = 100) {
  const client = await getClient(settings)
  const result = await client.call('chat.history', { sessionKey, limit })
  return result?.messages || result || []
}
