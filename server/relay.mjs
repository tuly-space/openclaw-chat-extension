/**
 * ws-relay.mjs — WebSocket relay for OpenClaw Chrome Extension
 *
 * Chrome extension → relay (ws://localhost:PORT) → gateway (wss://...)
 *
 * Why: Gateway clears scopes for webchat clients without device identity.
 * Fix: Relay intercepts the `connect` request frame and rewrites client.id
 *      to "openclaw-control-ui" so gateway treats it as a Control UI client
 *      and retains the declared scopes (operator.write etc.).
 *
 * Usage:
 *   node relay.mjs [--port 18790] [--gateway wss://your-gateway/]
 *   OC_RELAY_PORT=18790 OC_GATEWAY_URL=wss://... node relay.mjs
 */

import { WebSocketServer, WebSocket } from 'ws'
import http from 'node:http'

// Use backend client identity so gateway treats this as a local backend client:
// - No origin check (not control-ui or webchat)
// - shouldSkipBackendSelfPairing = true (isLocalClient + no Origin header + token auth)
// - Scopes not cleared (not webchat, not unbound device-less client)
const BACKEND_CLIENT_ID = 'gateway-client'
const BACKEND_CLIENT_MODE = 'backend'

const PORT = parseInt(process.env.OC_RELAY_PORT || '18790', 10)
const GATEWAY_URL = process.env.OC_GATEWAY_URL || null

// Parse CLI args
const args = process.argv.slice(2)
let gatewayUrl = GATEWAY_URL
let port = PORT

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10)
  if (args[i] === '--gateway' && args[i + 1]) gatewayUrl = args[++i]
}

if (!gatewayUrl) {
  console.error('[relay] Error: gateway URL required (--gateway wss://... or OC_GATEWAY_URL=...)')
  process.exit(1)
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, gateway: gatewayUrl }))
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server })

wss.on('connection', (clientWs, req) => {
  const connId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  console.log(`[relay] client connected conn=${connId}`)

  // Do NOT forward Origin header — backend clients connect without Origin,
  // which is required for shouldSkipBackendSelfPairing to fire correctly.
  const gatewayWs = new WebSocket(gatewayUrl)

  let clientBuffer = []
  let gatewayBuffer = []
  let gatewayReady = false
  let clientReady = true // client is already connected

  // ── Client → Gateway ──────────────────────────────────────────────────────

  clientWs.on('message', (data) => {
    const raw = data.toString()
    let frame
    try { frame = JSON.parse(raw) } catch { frame = null }

    // Intercept connect request: rewrite to backend client identity
    // gateway-client + mode=backend + no Origin + localhost → shouldSkipBackendSelfPairing=true
    if (frame?.type === 'req' && frame?.method === 'connect') {
      if (frame.params?.client) {
        const originalId = frame.params.client.id
        const originalMode = frame.params.client.mode
        frame.params.client.id = BACKEND_CLIENT_ID
        frame.params.client.mode = BACKEND_CLIENT_MODE
        console.log(`[relay] conn=${connId} connect: rewrote client id=${originalId}→${BACKEND_CLIENT_ID} mode=${originalMode}→${BACKEND_CLIENT_MODE}`)
      }
      const patched = JSON.stringify(frame)
      if (gatewayReady) {
        gatewayWs.send(patched)
      } else {
        gatewayBuffer.push(patched)
      }
      return
    }

    // All other frames: pass through as-is
    if (gatewayReady) {
      gatewayWs.send(raw)
    } else {
      gatewayBuffer.push(raw)
    }
  })

  clientWs.on('close', (code, reason) => {
    console.log(`[relay] client closed conn=${connId} code=${code}`)
    if (gatewayWs.readyState === WebSocket.OPEN || gatewayWs.readyState === WebSocket.CONNECTING) {
      gatewayWs.close(code, reason)
    }
  })

  clientWs.on('error', (err) => {
    console.error(`[relay] client error conn=${connId}`, err.message)
  })

  // ── Gateway → Client ──────────────────────────────────────────────────────

  gatewayWs.on('open', () => {
    gatewayReady = true
    // Flush buffered messages from client
    for (const msg of gatewayBuffer) gatewayWs.send(msg)
    gatewayBuffer = []
    console.log(`[relay] gateway connected conn=${connId}`)
  })

  gatewayWs.on('message', (data) => {
    const raw = data.toString()
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(raw)
    } else {
      clientBuffer.push(raw)
    }
  })

  gatewayWs.on('close', (code, reason) => {
    console.log(`[relay] gateway closed conn=${connId} code=${code}`)
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(code, reason)
    }
  })

  gatewayWs.on('error', (err) => {
    console.error(`[relay] gateway error conn=${connId}`, err.message)
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, 'gateway error')
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[relay] listening on ws://127.0.0.1:${port}`)
  console.log(`[relay] forwarding to ${gatewayUrl}`)
})

process.on('SIGINT', () => { server.close(); process.exit(0) })
process.on('SIGTERM', () => { server.close(); process.exit(0) })
