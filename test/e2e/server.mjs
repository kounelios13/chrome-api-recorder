/**
 * Local fixture server for the end-to-end tests.
 *
 * Serves a page that issues a mix of fetch/XHR/GraphQL/image requests and
 * records their results on `window.__test`, plus a mutable API "version" so the
 * tests can prove a replayed response comes from storage and not the server.
 */
import http from 'node:http';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>API Recorder E2E fixture</title></head>
<body>
  <h1>API Recorder E2E fixture</h1>
  <script>
    window.__test = { results: {}, errors: [], done: false };

    window.__capture = async (tag, fn) => {
      try {
        window.__test.results[tag] = await fn();
      } catch (error) {
        window.__test.errors.push(tag + ': ' + ((error && error.message) || error));
      }
    };

    window.__test.probes = {};
    window.__probe = (tag, url) => {
      const record = { done: false, status: 0, body: '', contentType: '', error: null };
      window.__test.probes[tag] = record;
      fetch(url)
        .then(async (response) => {
          record.status = response.status;
          record.contentType = response.headers.get('content-type') || '';
          record.body = await response.text();
          record.done = true;
        })
        .catch((error) => {
          record.error = String((error && error.message) || error);
          record.done = true;
        });
    };

    async function run() {
      window.__test.results = {};
      window.__test.errors = [];
      window.__test.done = false;

      await window.__capture('greeting', async () => {
        const response = await fetch('/api/greeting');
        return { status: response.status, contentType: response.headers.get('content-type'), body: await response.json() };
      });

      for (const id of [1, 2]) {
        await window.__capture('echo' + id, async () => {
          const response = await fetch('/api/echo', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          return { status: response.status, body: await response.json() };
        });
      }

      await window.__capture('xhr', () => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/xhr');
        xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
        xhr.onerror = () => reject(new Error('xhr failed'));
        xhr.send();
      }));

      await window.__capture('graphql', async () => {
        const response = await fetch('/api/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ ping }' }),
        });
        return { status: response.status, body: await response.json() };
      });

      await window.__capture('image', () => new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.width });
        image.onerror = () => resolve({ error: true });
        image.src = '/img.png?n=' + Date.now();
      }));

      window.__test.done = true;
    }

    window.__testRerun = run;
    run();
  </script>
</body>
</html>`;

/**
 * @returns {Promise<{
 *   origin: string,
 *   port: number,
 *   state: {version: string, hits: Record<string, number>, log: Array<{method:string,path:string}>},
 *   hitsOf: (method: string, pathname: string) => number,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startTestServer() {
  const state = { version: 'v1', hits: {}, log: [] };

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, state);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    state,
    hitsOf: (method, pathname) => state.hits[`${method} ${pathname}`] ?? 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 * @param {{version: string, hits: Record<string, number>, log: Array<object>}} state
 */
async function handleRequest(request, response, state) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const method = request.method ?? 'GET';
  const key = `${method} ${url.pathname}`;
  state.hits[key] = (state.hits[key] ?? 0) + 1;
  state.log.push({ method, path: url.pathname });

  if (url.pathname === '/') {
    send(response, 200, 'text/html; charset=utf-8', PAGE_HTML);
    return;
  }

  if (url.pathname === '/api/greeting') {
    sendJson(response, { message: `hello-${state.version}`, version: state.version });
    return;
  }

  if (url.pathname === '/api/echo') {
    const body = await readBody(request);
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* echo raw text */
    }
    sendJson(response, { echo: parsed, version: state.version });
    return;
  }

  if (url.pathname === '/api/xhr') {
    send(response, 200, 'text/plain; charset=utf-8', `xhr-${state.version}`);
    return;
  }

  if (url.pathname === '/api/live-only') {
    sendJson(response, { live: state.version });
    return;
  }

  if (url.pathname === '/api/graphql') {
    sendJson(response, { data: { ping: state.version } });
    return;
  }

  if (url.pathname === '/img.png') {
    send(response, 200, 'image/png', PNG_1X1);
    return;
  }

  if (url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  sendJson(response, { error: `not found: ${url.pathname}` }, 404);
}

/** @param {http.IncomingMessage} request */
function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function sendJson(response, value, status = 200) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function send(response, status, contentType, body) {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(body);
}
