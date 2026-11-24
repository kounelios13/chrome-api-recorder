/**
 * Local fixture server for the end-to-end tests.
 *
 * Serves a page that issues a mix of fetch/XHR/GraphQL/image requests and
 * records their results on `window.__test`, plus a mutable API "version" so the
 * tests can prove a replayed response comes from storage and not the server.
 */
import http from 'node:http';
import { acceptUpgrade, createSid } from './ws-server.mjs';

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
    window.__probe = (tag, url, options) => {
      const record = { done: false, status: 0, body: '', contentType: '', error: null };
      window.__test.probes[tag] = record;
      fetch(url, options ?? {})
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

    window.__ws = { probes: {} };
    window.__wsProbe = (tag, url, options) => {
      const config = options || {};
      const record = { tag, state: 'connecting', received: [], receivedBinary: [], error: null, closed: null };
      window.__ws.probes[tag] = record;
      const protocols = config.protocols || [];
      const socket = protocols.length > 0 ? new WebSocket(url, protocols) : new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      record.socket = socket;
      socket.onopen = () => {
        record.state = 'open';
        for (const message of config.messages || []) socket.send(message);
        if (config.binary) socket.send(new Uint8Array(config.binary));
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') record.received.push(event.data);
        else record.receivedBinary.push(Array.from(new Uint8Array(event.data)));
      };
      socket.onerror = () => { record.error = 'error'; };
      socket.onclose = (event) => {
        record.state = 'closed';
        record.closed = { code: event.code, reason: event.reason };
      };
      return true;
    };
    window.__wsSend = (tag, data) => {
      const record = window.__ws.probes[tag];
      if (!record || !record.socket) return false;
      record.socket.send(data);
      return true;
    };
    window.__wsClose = (tag, code) => {
      const record = window.__ws.probes[tag];
      if (!record || !record.socket) return false;
      record.socket.close(code || 1000);
      return true;
    };
    window.__wsSnapshot = (tag) => {
      const record = window.__ws.probes[tag];
      if (!record) return null;
      return { state: record.state, received: record.received, receivedBinary: record.receivedBinary, error: record.error, closed: record.closed };
    };

    function wsUrl(path) {
      const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
      return scheme + location.host + path;
    }
    function wsOpen(socket) {
      return new Promise((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
      });
    }
    function waitWsMessage(socket, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('websocket message timeout')), timeoutMs || 5000);
        socket.addEventListener('message', (event) => { clearTimeout(timer); resolve(event.data); }, { once: true });
      });
    }
    function waitWsClose(socket) {
      return new Promise((resolve) => {
        socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
      });
    }

    async function runRawWs() {
      const socket = new WebSocket(wsUrl('/ws/echo'));
      socket.binaryType = 'arraybuffer';
      await wsOpen(socket);
      const hello = await waitWsMessage(socket);
      socket.send('ping');
      const echo = await waitWsMessage(socket);
      socket.send(new Uint8Array([1, 2, 3]));
      const binary = Array.from(new Uint8Array(await waitWsMessage(socket)));
      socket.close(1000);
      const closed = await waitWsClose(socket);
      return { hello: hello, echo: echo, binary: binary, closed: closed };
    }

    async function runSocketIoWs() {
      const stamp = () => 't=' + Date.now() + Math.random();
      const open = await (await fetch(location.origin + '/socket.io/?EIO=4&transport=polling&' + stamp())).text();
      const sid = JSON.parse(open.slice(1)).sid;
      const connect = await (await fetch(location.origin + '/socket.io/?EIO=4&transport=polling&' + stamp() + '&sid=' + sid)).text();
      await fetch(location.origin + '/socket.io/?EIO=4&transport=polling&' + stamp() + '&sid=' + sid, { method: 'POST', body: '40' });
      const socket = new WebSocket(wsUrl('/socket.io/?EIO=4&transport=websocket&sid=' + sid));
      await wsOpen(socket);
      socket.send('2probe');
      const probe = await waitWsMessage(socket);
      socket.send('5');
      const welcomeFrame = String(await waitWsMessage(socket));
      socket.send('42["echo",{"id":7}]');
      const echoedFrame = String(await waitWsMessage(socket));
      socket.close(1000);
      return {
        openPrefix: open.slice(0, 1),
        sid: sid,
        connectPrefix: connect.slice(0, 2),
        probe: probe,
        welcome: JSON.parse(welcomeFrame.slice(2)),
        echoed: JSON.parse(echoedFrame.slice(2)),
      };
    }

    async function runSignalRWs() {
      const negotiate = await (await fetch(location.origin + '/hub/negotiate?negotiateVersion=1', { method: 'POST' })).json();
      const socket = new WebSocket(wsUrl('/hub'), ['json']);
      await wsOpen(socket);
      const separator = String.fromCharCode(30);
      socket.send('{"protocol":"json","version":1}' + separator);
      const handshake = await waitWsMessage(socket);
      socket.send('{"type":1,"invocationId":"9","target":"Echo","arguments":[1,2]}' + separator);
      // The reply may arrive batched in one frame or as separate frames; both
      // are valid SignalR, so collect until the completion message shows up.
      const messages = [];
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const frame = String(await waitWsMessage(socket, Math.max(500, deadline - Date.now())));
        for (const part of frame.split(separator)) {
          if (!part) continue;
          try { messages.push(JSON.parse(part)); } catch (error) { /* ignore partial */ }
        }
        if (messages.some((message) => Number(message.type) === 3)) break;
      }
      socket.close(1000);
      return { token: Boolean(negotiate.connectionToken), handshake: handshake, messages: messages };
    }

    async function runGraphqlWs() {
      const socket = new WebSocket(wsUrl('/graphql'));
      await wsOpen(socket);
      const greeting = await waitWsMessage(socket);
      socket.close(1000);
      return { greeting: greeting };
    }

    window.__wsScenario = async (which) => {
      const out = { errors: [] };
      const want = which || 'all';
      const core = want === 'all' || want === 'core';
      window.__test.wsDone = false;
      if (core || want === 'raw') {
        try { out.raw = await runRawWs(); } catch (error) { out.errors.push('raw:' + error.message); }
      }
      if (core || want === 'socketio') {
        try { out.socketio = await runSocketIoWs(); } catch (error) { out.errors.push('socketio:' + error.message); }
      }
      if (core || want === 'signalr') {
        try { out.signalr = await runSignalRWs(); } catch (error) { out.errors.push('signalr:' + error.message); }
      }
      if (want === 'all' || want === 'graphql') {
        try { out.graphql = await runGraphqlWs(); } catch (error) { out.errors.push('graphql:' + error.message); }
      }
      window.__test.ws = out;
      window.__test.wsDone = true;
      return true;
    };

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
  const state = {
    version: 'v1',
    hits: {},
    log: [],
    /** When false, WebSocket upgrades are refused (offline-replay assertions). */
    wsEnabled: true,
    socketioConnected: new Set(),
    upgrades: 0,
  };

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, state);
  });

  server.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket, head, state);
  });

  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
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
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
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

  if (url.pathname === '/socket.io/') {
    await handleSocketIoHttp(request, response, url, state);
    return;
  }

  if (url.pathname === '/hub/negotiate') {
    const connectionId = createSid();
    sendJson(response, {
      negotiateVersion: 1,
      connectionId,
      connectionToken: `${connectionId}-token`,
      availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text', 'Binary'] }],
    });
    return;
  }

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

/**
 * Socket.IO HTTP polling handshake: open packet, namespace connect, then pings.
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 * @param {URL} url
 * @param {any} state
 */
async function handleSocketIoHttp(request, response, url, state) {
  const method = request.method ?? 'GET';
  const sid = url.searchParams.get('sid');

  if (method === 'POST') {
    await readBody(request);
    send(response, 200, 'text/html; charset=utf-8', 'ok');
    return;
  }

  if (!sid) {
    const newSid = createSid();
    send(
      response,
      200,
      'text/plain; charset=utf-8',
      `0${JSON.stringify({
        sid: newSid,
        upgrades: ['websocket'],
        pingInterval: 25000,
        pingTimeout: 20000,
        maxPayload: 1000000,
      })}`,
    );
    return;
  }

  if (!state.socketioConnected.has(sid)) {
    state.socketioConnected.add(sid);
    send(response, 200, 'text/plain; charset=utf-8', `40${JSON.stringify({ sid })}`);
    return;
  }

  // No queued packets: a keepalive ping keeps the client from stalling.
  send(response, 200, 'text/plain; charset=utf-8', '2');
}

/**
 * WebSocket routes: raw echo, Socket.IO upgrade, SignalR hub.
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {any} state
 */
function handleUpgrade(request, socket, head, state) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  state.upgrades += 1;
  state.hits[`UPGRADE ${url.pathname}`] = (state.hits[`UPGRADE ${url.pathname}`] ?? 0) + 1;

  if (!state.wsEnabled) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }

  const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (url.pathname === '/ws/echo') {
    const connection = acceptUpgrade(request, socket, head);
    connection.sendText(`hello-${state.version}`);
    connection.onMessage((message) => {
      if (message.opcode === 2) {
        connection.sendBinary(message.data);
        return;
      }
      if (message.text === 'bye') {
        connection.close(1000, 'bye');
        return;
      }
      connection.sendText(`echo:${message.text}`);
    });
    return;
  }

  if (url.pathname === '/socket.io/') {
    const connection = acceptUpgrade(request, socket, head);
    connection.onMessage((message) => {
      if (message.opcode !== 1) return;
      const text = message.text ?? '';
      if (text === '2probe') {
        connection.sendText('3probe');
        return;
      }
      if (text === '5') {
        connection.sendText(`42["welcome",{"version":"${state.version}"}]`);
        return;
      }
      const echo = /^42\["echo",(\{.*\})\]$/.exec(text);
      if (echo) {
        connection.sendText(`42["echoed",${JSON.stringify({ ...JSON.parse(echo[1]), version: state.version })}]`);
      }
    });
    return;
  }

  if (url.pathname === '/graphql') {
    const connection = acceptUpgrade(request, socket, head, protocols);
    connection.sendText(`graphql-${state.version}`);
    connection.onMessage((message) => {
      if (message.opcode === 1) connection.sendText(`graphql-echo:${message.text}`);
    });
    return;
  }

  if (url.pathname === '/hub') {
    const connection = acceptUpgrade(request, socket, head);
    connection.onMessage((message) => {
      if (message.opcode !== 1) return;
      for (const part of String(message.text ?? '').split('\u001e')) {
        if (!part) continue;
        let parsed;
        try {
          parsed = JSON.parse(part);
        } catch {
          continue;
        }
        if (typeof parsed.protocol === 'string') {
          connection.sendText(`{}\u001e`);
          continue;
        }
        if (Number(parsed.type) === 1) {
          const invocationId = parsed.invocationId ?? null;
          // Two logical messages in one frame, exercising batched framing.
          connection.sendText(
            `{"type":2,"invocationId":${JSON.stringify(invocationId)},"item":{"version":"${state.version}"}}\u001e` +
              `{"type":3,"invocationId":${JSON.stringify(invocationId)},"result":{"echo":${JSON.stringify(
                parsed.arguments ?? [],
              )},"version":"${state.version}"}}\u001e`,
          );
        }
      }
    });
    return;
  }

  socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
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
