// Same-origin proxy: /agent/* → the DevAgent worker (Cloudflare Agents SDK).
//
// /agent/ws            → wss DevAgent route (WebSocket upgrade, manually spliced)
// /agent/health        → liveness
// /agent/models        → curated model catalog
// /agent/chat          → single-shot HTTP chat
// /agent/anything-else → forwarded verbatim to the worker's own routes
//
// Why: *.workers.dev is not resolvable on mainland-China networks, so the
// in-game agent panel talks to this same-origin path instead. WS proxying
// splices two accepted sockets in JavaScript (browser side from a
// WebSocketPair, agent side from fetch() with `Upgrade: websocket`):
// returning the fetched socket in a 101 Response does NOT keep the pipe
// alive once the handler returns, explicit forwarding does, and the
// function invocation then lives exactly as long as the connection.
//
// Routed by public/_routes.json (include /agent/*).

const ORIGIN = 'https://thehumanbox-agent.yeyilin2010.workers.dev'
const PREFIX = '/agent'
const WS_ROUTE = '/agents/dev-agent/main'

export async function onRequest(context) {
  const { request } = context
  const url = new URL(request.url)
  const rest = url.pathname.slice(PREFIX.length) || '/'

  // ── WebSocket: /agent/ws → the Durable Object's agents route ──────────
  if (request.headers.get('Upgrade') === 'websocket') {
    let target
    if (rest === '/ws' || rest === '/agents/dev-agent/main') {
      target = ORIGIN + WS_ROUTE
    } else {
      target = ORIGIN + rest
    }
    let upstream
    try {
      const wsHeaders = { Upgrade: 'websocket' }
      const proto = request.headers.get('Sec-WebSocket-Protocol')
      if (proto) wsHeaders['Sec-WebSocket-Protocol'] = proto
      upstream = await fetch(target, { headers: wsHeaders })
    } catch (error) {
      return new Response('agent upstream unreachable: ' + String(error?.message ?? error), { status: 502 })
    }
    const upWs = upstream.webSocket
    if (!upWs) {
      return new Response('agent worker refused the websocket upgrade', { status: 502 })
    }

    // Manual splice. Returning a fetched socket in a 101 Response does not
    // keep the pipe alive after the handler returns (verified live: frames
    // flow for a moment, then the invocation is reaped). Instead we accept
    // both sockets in JavaScript and forward frames explicitly — the
    // function invocation then lives exactly as long as the connection.
    upWs.accept()
    const [clientWs, serverWs] = Object.values(new WebSocketPair())
    serverWs.accept()
    let closed = false
    const closeBoth = () => {
      if (closed) return
      closed = true
      try { upWs.close() } catch {}
      try { serverWs.close() } catch {}
    }
    serverWs.addEventListener('message', (ev) => {
      try { upWs.send(ev.data) } catch { closeBoth() }
    })
    upWs.addEventListener('message', (ev) => {
      try { serverWs.send(ev.data) } catch { closeBoth() }
    })
    serverWs.addEventListener('close', closeBoth)
    upWs.addEventListener('close', closeBoth)
    serverWs.addEventListener('error', closeBoth)
    upWs.addEventListener('error', closeBoth)
    return new Response(null, { status: 101, webSocket: clientWs })
  }

  // ── Plain HTTP passthrough ─────────────────────────────────────────────
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }
  const target = ORIGIN + rest + url.search
  const upstream = await fetch(target, new Request(request, { headers: cleanHeaders(request) }))
  return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
}

/** Drops hop/browser headers the agent worker has no use for. */
function cleanHeaders(request) {
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    if (/^(cookie|host|connection|keep-alive|transfer-encoding|upgrade|cf-connecting-ip)$/i.test(key)) continue
    headers.set(key, value)
  }
  return headers
}
