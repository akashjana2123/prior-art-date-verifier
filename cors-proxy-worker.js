/**
 * Minimal CORS proxy for Prior-Art Date Verifier (Cloudflare Worker).
 *
 * web.archive.org does not send CORS headers, so a page on GitHub Pages cannot
 * read the Wayback CDX index or archived pages directly. This Worker forwards
 * GET requests to a short allowlist of hosts and adds the missing headers.
 * It is deliberately not an open proxy: every other host is refused.
 *
 * Use:  https://<your-worker>.workers.dev/?url=<encoded target URL>
 * In the app, paste  https://<your-worker>.workers.dev/?url=  as the proxy prefix.
 */

// Hosts the Worker will fetch. Nothing else is allowed.
const ALLOWED_HOSTS = ['web.archive.org', 'archive.org', 'archive.softwareheritage.org'];

// Google Search grounding returns redirect links on this host. For these the Worker
// only reads the Location header and returns it; it never fetches the target page.
const REDIRECT_HOSTS = ['vertexaisearch.cloud.google.com'];

// Optional: restrict which sites may use the Worker, for example
// ['https://your-name.github.io']. Leave empty to allow any origin.
const ALLOWED_ORIGINS = [];

const MAX_REDIRECTS = 5;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.length ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'x-final-url, retry-after',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function reply(status, message, origin) {
  return new Response(message, { status, headers: { ...corsHeaders(origin), 'Content-Type': 'text/plain; charset=utf-8' } });
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) return reply(403, 'This origin may not use the proxy.', origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return reply(405, 'Only GET requests are forwarded.', origin);

    let target;
    try { target = new URL(new URL(request.url).searchParams.get('url') || ''); } catch (e) { return reply(400, 'Add ?url= with a full, encoded URL.', origin); }
    if (!['http:', 'https:'].includes(target.protocol)) return reply(400, 'Only http and https URLs are forwarded.', origin);

    // Search redirect links: return where they point, without following them.
    if (REDIRECT_HOSTS.includes(target.hostname)) {
      const res = await fetch(target.toString(), { method: 'GET', redirect: 'manual' });
      const location = res.headers.get('Location') || '';
      return new Response(JSON.stringify({ location }), { status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
    }

    if (!ALLOWED_HOSTS.includes(target.hostname)) return reply(403, `The proxy does not forward to ${target.hostname}.`, origin);

    // Follow redirects by hand so that a redirect cannot lead to a host outside the allowlist.
    let url = target.toString();
    let upstream;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      upstream = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'prior-art-date-verifier-proxy' } });
      const location = upstream.headers.get('Location');
      if (![301, 302, 303, 307, 308].includes(upstream.status) || !location) break;
      const next = new URL(location, url);
      if (!ALLOWED_HOSTS.includes(next.hostname)) return reply(403, `Redirect to ${next.hostname} refused.`, origin);
      url = next.toString();
      if (hop === MAX_REDIRECTS) return reply(508, 'Too many redirects.', origin);
    }

    const headers = new Headers();
    for (const name of ['content-type', 'retry-after', 'last-modified', 'memento-datetime']) {
      const v = upstream.headers.get(name);
      if (v) headers.set(name, v);
    }
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
    headers.set('x-final-url', url);
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
