// Same-origin proxy: /api/* → the super backend worker.
//
// Why: the game site is on pages.dev (reachable), but the backend lives on
// *.workers.dev, which mainland-China networks cannot resolve. The game page
// is also cross-origin isolated (COEP in public/_headers); same-origin fetch
// sidesteps every CORS/CORP question. This function runs on Cloudflare's
// edge, where the workers.dev origin is one internal hop away.
//
// Routed by public/_routes.json (include /api/*).

const ORIGIN = 'https://thehumanbox-api.yeyilin2010.workers.dev'
const PREFIX = '/api'

export async function onRequest(context) {
  const { request } = context
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

  const url = new URL(request.url)
  const target = ORIGIN + url.pathname.slice(PREFIX.length) + url.search

  // Forward the request as-is (method, headers, body stream). Only the URL
  // changes; the backend is stateless per request.
  const upstream = await fetch(target, new Request(request, { headers: cleanHeaders(request) }))

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  })
}

/** Drops hop/browser headers the backend has no use for. */
function cleanHeaders(request) {
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    if (/^(cookie|host|connection|keep-alive|transfer-encoding|upgrade|cf-connecting-ip)$/i.test(key)) continue
    headers.set(key, value)
  }
  return headers
}
