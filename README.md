# API Recorder — Chrome extension

Record the XHR/fetch traffic of a web page into a named **scenario**, then replay the recorded
responses later — per tab, per request body — without the application noticing. A **Live mode**
button puts every request back on the real network at any time.

Built as a Manifest V3 extension using the Chrome Debugger API (CDP): recording is passive, replay
fulfills requests at the network layer, so no page-side monkey-patching is involved.

![icon](icons/icon128.png)

## Features

- **Scenario recording** — name a scenario, press *Start recording*, use the page normally. Every
  `fetch`/`XMLHttpRequest` response is stored with its request body, status, status text, MIME type
  and response headers.
- **Body-aware matching** — a recording is identified by `METHOD + normalized URL + exact request
  body`. `POST /api/items {"id":1}` and `POST /api/items {"id":2}` are two independent recordings.
- **Transparent replay** — while a scenario replays, matching requests are answered with the stored
  status/headers/body exactly as the server would have answered. Non-matching requests pass through
  live, so the app keeps working.
- **Smart fallback matching + live-pass diagnostics** — if no exact recording matches, replay falls
  back to the only recording for the same URL (or same path, ignoring query strings) when that choice
  is unambiguous. Requests that still go live are listed in the popup with the reason (no recording,
  body differs, ambiguous, …), and Settings → Troubleshooting can copy a debug report.
- **Editable payloads** — in Settings → Scenarios → *View requests*, every recorded request has an
  **Edit** button that opens the response payload in a dialog. Edit and save it to test different
  response shapes; the original payload is kept and can be restored with one click. Replay picks up
  edits immediately, even while a replay session is active.
- **Per-request deletion** — every row in the recorded-request table has a trash button; the
  extension asks for an explicit confirmation first, and the scenario's count and host list stay in
  sync after the removal.
- **Request filter** — the recorded-request table has a live filter box: type `post /api/orders`,
  `200`, `json`, a URL fragment or a body token to narrow the list before previewing or editing.
  Multiple space-separated terms must all match.
- **Per-host scenario list** — the popup shows only the scenarios that recorded requests on the
  current tab's host, with a **This host / All** toggle. New scenarios seed the current host
  automatically; scenarios recorded before this feature backfill their hosts from stored requests.
- **Import / export** — export a single scenario **or every scenario at once** to a JSON file
  (request metadata + response bodies) and import it on another machine or profile. Import accepts
  both single-scenario and bulk files. Match keys travel with the entries, so replay keeps working
  on the imported copies; name collisions get a `(imported N)` suffix and invalid entries are
  skipped with a reason.

  ![Payload editor dialog](docs/payload-editor.png)
- **Per-tab sessions** — a tab can record while another tab replays. A session survives page reloads
  on allowlisted sites and is bound to the tab it was started in.
- **Live mode** — one click disables replay interception on that tab; every request goes to the real
  network. Switching back to replay is instant and keeps the scenario selected.
- **Live counters** — toolbar badge (red = recording count, blue = replayed count, gray `LIVE`), plus
  an in-page HUD with recorded / replayed / passed-live counters and a recent-request feed.
- **Site allowlist** — the extension only runs on sites you add in Settings (per-host optional
  permissions). Nothing is injected into pages you did not enable.
- **GraphQL excluded** — GraphQL-looking requests (URL contains `graphql`, a `query` parameter, or a
  body containing a GraphQL `query`/`mutation`) are never recorded or replayed; they always go live.
  Can be toggled in Settings.
- **WebSockets (opt-in per setting, on by default)** — `ws://` / `wss://` connections are recorded
  frame by frame and replayed from an injected MAIN-world `WebSocket` shim. Protocol adapters add
  first-class **Socket.IO** (Engine.IO v3/v4) and **ASP.NET Core SignalR** (JSON) support: handshakes,
  `\x1e` framing, ping/pong keepalives and ack / `invocationId` rewriting. Editing a frame in
  Settings → Scenarios → *Frames* changes what replay delivers.
- **Only XHR/fetch and WebSockets** — documents, scripts, stylesheets, images, fonts, media and
  EventSource are never recorded.

## Install (unpacked, developer mode)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin **API Recorder** to the toolbar.

Chrome asks for the *debugger* permission at install time (needed for CDP) and shows an
"An extension is debugging this browser" infobar while a session is active. Host access is requested
per site, the first time you add it.

## Quick start

1. Open **Settings** (popup → Settings) and add the site you want to work with, e.g. `app.example.com`
   or `localhost:3000`. Chrome asks for host access; accept.
2. Open the page, click the extension icon.
3. Type a scenario name and press **Create**, then **Start recording**. The badge and in-page HUD
   show how many requests have been captured.
4. Use the page to trigger the API calls you care about, then press **Stop recording** (HUD or
   popup). The requests are already saved at that point.
5. Select the scenario and press **Start replay**, then reload/interact with the page. Matching
   requests are served from the recording (no server hit); everything else goes live.
6. Press **Go live** in the HUD (or popup) to bypass the recording, and **Resume replay** to return.
7. To test a different response, open **Settings → Scenarios → View requests**, use the filter box
   (e.g. `post /api/orders`) to find the request, press **Edit** next to it, change the payload and
   press **Save payload**. Replay now serves the edited body; **Restore original** brings the recorded
   body back.

### Sharing a scenario

- **Export**: Settings → Scenarios → **Export** downloads `api-recorder-scenario-<name>-<date>.json`;
  **Export all** downloads `api-recorder-scenarios-<date>.json` with every scenario that has recorded
  requests.
- **Import**: Settings → Scenarios → **Import recordings…** accepts both kinds of files — one scenario
  or many. Every imported scenario gets a fresh id and name-collisions are renamed (`(imported N)`);
  response bodies are validated against the “Max response size” setting and entries that fail
  validation are skipped with a reason.
- The per-request match key is preserved verbatim — it was derived from the original request body and
  cannot be recomputed from the export — so replay and body-aware matching work exactly as recorded.
- The file contains only local data (method, URL, status, headers, body previews and the response
  body). Review it before sharing; response bodies can contain sensitive application data.

## How it works

- **Recording** attaches `chrome.debugger` and enables the CDP `Network` domain. On
  `requestWillBeSent` → `responseReceived` → `loadingFinished`, only resources of type `XHR`/`Fetch`
  are kept. The exact request body is read with `Network.getRequestPostData` and the response body
  with `Network.getResponseBody`; the pair is written to IndexedDB. Nothing is blocked, so recording
  cannot break the page.
- **Replay** enables the CDP `Fetch` domain (request stage). Each paused request is matched against
  an in-memory `matchKey → entry` index; a hit is fulfilled via `Fetch.fulfillRequest`, a miss is
  forwarded via `Fetch.continueRequest`. Stored response bodies are decompressed already, so
  `content-encoding`/`content-length`/`transfer-encoding` are dropped before fulfillment; `Set-Cookie`
  is not replayed by default (toggle in Settings).
- **Live mode** disables the `Fetch` domain, leaving the debugger attached, so toggling back is
  instant.
- **Payload editing** rewrites the stored response body in IndexedDB (the first edit keeps a copy of
  the original body) and refreshes the match index/cache of active replay sessions for that scenario,
  so the next intercepted request gets the new bytes. Status and response headers stay unchanged;
  the browser recalculates `content-length` when fulfilling.
- **Per-tab sessions** are tracked in the service worker and snapshotted to `chrome.storage.session`,
  so a restarted service worker can reattach and recover. A keepalive ping from the in-page HUD keeps
  the MV3 worker alive while a session is active.

```
manifest.json
src/
  background/        service worker: message API, session lifecycle, CDP engines, storage
    service-worker.js  message router + chrome event wiring + state snapshot
    sessions.js        one session per tab, badge/broadcasts/recovery, engine hooks
    recorder.js        passive CDP Network recorder
    wsRecorder.js      passive CDP Network.webSocket* recorder
    replay.js          CDP Fetch interceptor + fulfill/continue
    wsReplay.js        CDP Page/Runtime bridge + WebSocket timeline playback
    wsShim.js          injectable MAIN-world WebSocket shim
    db.js              IndexedDB metadata, response body and WS frame stores
    store.js           chrome.storage for sites/scenarios/settings
    sites.js           optional host permissions + dynamic content-script registration
    cdp.js             chrome.debugger wrapper with friendly errors
    broadcast.js       tab/extension-page broadcasts
  content/overlay.js   in-page HUD (shadow DOM)
  popup/               toolbar popup: scenario management, record/replay/live, enable site
  options/             settings page: sites, settings, scenario management
  shared/              pure helpers: match keys, URL normalization, headers, patterns, entry bodies,
                       scenario hosts, import/export format, filters, messages
    wsAdapters/        Socket.IO / SignalR / generic protocol adapters
    wsReplayPlan.js    pure WS timeline compiler + frame matcher
test/unit/             Node test runner tests for the pure logic
test/e2e/              real Chrome for Testing end-to-end suite
```

### WebSocket replay

CDP can record WebSockets natively but cannot intercept them, so replay uses a two-part bridge:

- `Page.addScriptToEvaluateOnNewDocument` installs a MAIN-world `WebSocket` wrapper before any page
  script runs (CSP/Trusted-Types safe, and scoped to the replayed tab), and `Runtime.addBinding`
  gives that wrapper a private channel back to the service worker. The binding is captured and
  deleted immediately so page code cannot call it.
- Each recorded connection is compiled into a plan: frames the server sent before the first client
  frame are delivered on open, every client frame is a trigger whose recorded server frames are
  replayed with relative timing, and unmatched sockets pass straight through to the native
  `WebSocket`.
- **Timing** is configurable in Settings: *capped* keeps the recorded ordering but limits every
  delay (`Max frame delay`, default 1500 ms), *exact* uses the recorded delays, *instant* delivers
  immediately.
- **Keepalives are synthesized** so replayed clients never time out: Engine.IO v4 pings, Engine.IO v3
  pong replies, SignalR `{"type":6}` server pings.
- **Go live** closes mocked sockets with code `1001` (Going Away), so Socket.IO / SignalR reconnect
  on their own and the reconnecting socket passes through to the real server.
- **Per-frame routing**: sockets are keyed by execution context plus connection id, so a widget in a
  same-origin iframe replays independently instead of colliding with the top frame. A frame that has
  no recorded reply is reported to the page as an `error` event (and to the popup diagnostics) rather
  than vanishing silently.
- **Offline HTTP handshake**: Socket.IO polling (`GET/POST /socket.io/?EIO=…&transport=polling`) and
  SignalR `/negotiate` requests are matched by a canonical bucket that ignores the `t` cache-buster
  and replays the recorded polling sequence in order, so a scenario can replay with no backend
  running.
- **Latest non-empty connection wins**: re-recording the same endpoint replaces the previous
  recording only when the new connection captured at least one frame.

WebSocket frame recording is bounded: frames above 1 MB, connections above 20 MB or 2000 frames are
marked truncated instead of exhausting storage. GraphQL sockets (`graphql-ws`,
`graphql-transport-ws`, or a URL containing `graphql`) follow the existing GraphQL exclusion toggle.

### Matching rules

| Request | Key |
| --- | --- |
| `GET /api/items?b=2&a=1` | `GET` + `…/api/items?a=1&b=2` + empty body |
| `POST /api/items {"id":1}` | `POST` + `…/api/items` + `{"id":1}` bytes |
| `POST /api/items {"id":2}` | `POST` + `…/api/items` + `{"id":2}` bytes (different entry) |

The fragment is ignored and query parameters are sorted; the body is compared byte-for-byte. Bodies
above 2 MB are skipped during recording because they cannot be keyed reliably. If a request body
cannot be observed by Chrome, that request is not recorded (recording never stores an ambiguous key).

On replay the lookup is tiered to survive real-world APIs that embed timestamps/tokens in bodies or
cache-busting values in query strings:

1. **exact** — method + normalized URL + exact request body (the recorded key).
2. **same URL** — method + normalized URL, used only when exactly one recording exists for it.
3. **same endpoint** — method + origin + path, ignoring the query string, used only when exactly one
   recording exists for it.

Fallback tiers are controlled by the **Smart fallback matching** setting (on by default) and never
guess: if several recordings could apply, the request goes live and the popup reports it. Disable the
setting for strict exact matching.

## Data & privacy

Everything is stored locally in the extension (`chrome.storage.local` for metadata, IndexedDB for
recorded bodies and WebSocket frames; `unlimitedStorage` is requested so scenarios are not
size-constrained). Nothing is uploaded anywhere. Deleting a scenario permanently removes its
recorded data.

Scenario exports include **WebSocket frame payloads verbatim** — these routinely contain session
tokens, `sid`s and user data, just like response bodies do. Treat an exported file as sensitive, and
redact it before pasting it into an issue. Avoid recording third-party WebSocket traffic on
production credentials if that matters to you.

## Limitations / troubleshooting

- **DevTools cannot be open on the tab** while recording/replaying (Chrome allows one debugger client
  per tab). Close DevTools for that tab and retry. Other debugger extensions conflict too.
- The **debugger infobar** is shown while a session is active; that is Chrome's requirement for the
  Debugger API.
- Recording covers `fetch`/`XMLHttpRequest` and WebSockets of the page and its frames. Traffic made
  by service workers or dedicated workers is not captured (the WebSocket shim is injected into
  window contexts only). EventSource responses are skipped.
- **WebSocket replay** cannot adopt sockets that were opened *before* replay started — reload the
  page (or let the app reconnect) after pressing *Start replay*. The same applies to *recording*:
  only connections created after recording starts are captured. Binary frames (SignalR MessagePack,
  Socket.IO binary attachments, raw binary sockets) round-trip byte for byte but cannot be edited as
  text or field-rewritten in v1. A connection is only replaced in storage when the new recording
  contains at least one frame, so a failed reconnect cannot erase a good capture.
- **Cross-process iframes are not intercepted.** Replay script and the page bridge are attached to
  the replayed tab's target; a cross-site iframe runs in its own target, so its sockets keep using
  the native WebSocket and can reach the real network during an "offline" replay. Same-origin
  iframes are covered. Related: WebSocket recordings are keyed on origin + path only, so two sockets
  on the same endpoint that differ only in query string (for example different `sid` or tenant
  tokens) share one recording and the latest capture wins.
- Cross-origin requests still perform their CORS preflight against the real server; recorded CORS
  headers are replayed so the actual request/response works offline from the recording.
- Navigating a recording/replay tab to a site that is not allowlisted stops the session (recorded
  data is kept). The same happens if the page is closed or DevTools/replaced debugger detaches.
- Deleting a recorded request is permanent (the trash button asks for confirmation first); binary
  response bodies cannot be edited as text (the dialog explains this); text formats such as
  JSON, XML, HTML and plain text are fully editable. Edits are written byte-for-byte and are not
  JSON-validated, so you can intentionally test malformed payloads (the dialog warns about invalid
  JSON but still lets you save).
- Chrome match patterns ignore ports: adding `localhost:3000` allowlists every port on `localhost`.
- `start`/`stop` are per tab. One active session per tab; switching modes stops the previous one.

### Replay reports requests as “stayed live”

1. Keep the popup open briefly during replay: the Session card shows **“N requests stayed live”**.
   Expand it to see the method, shortened URL and reason for each (no recording, body differs, URL
   differs, ambiguous candidates, body unavailable, replay error).
2. Compare those URLs with **Settings → Scenarios → View requests**. If the recorded URL/body differs
   (dynamic query values, CSRF tokens, timestamps in JSON bodies, redirect targets), keep **Smart
   fallback matching** enabled (default) or re-record the request.
3. If several recordings share an endpoint, matching is refused as ambiguous. Re-record the scenario
   while hitting the endpoint once, or edit/remove the extra recordings.
4. If replay still pass-throughs everything, use **Settings → Troubleshooting → Copy debug report**
(it includes settings, allowed sites, recorded request signatures and live-pass diagnostics), and
   make sure you reloaded the unpacked extension after updating it (chrome://extensions → Reload).

## Development

```bash
npm test            # unit tests (Node built-in test runner, no dependencies)
npm run e2e:install # one-time: download Chrome for Testing into .e2e/ (branded Chrome 137+ can no
                    # longer load unpacked extensions via --load-extension)
npm run test:e2e    # real-Chrome end-to-end suite (CHROME_BIN to override the binary)
npm run verify      # units + e2e
npm run icons       # regenerate icons/
```

The e2e suite drives a real headless Chrome for Testing with the unpacked extension loaded against a
local fixture server and asserts, among others: only XHR/fetch is recorded, two POST bodies to the
same endpoint are stored separately, replayed responses are served from storage while the server
version is bumped to prove no network hit, GraphQL and images stay live, Live mode hits the server,
unrecorded requests pass through, replay can be resumed, counters/badges are correct, and the popup
and options pages load without uncaught errors. The payload editor is exercised through the real
Settings UI: the recorded response is edited, replay serves the edited bytes, the original is restored
from the dialog, and the next replay serves the original again. Smart fallback is covered as well:
an ambiguous request is left live while an unambiguous URL/path match is replayed from storage, and
the popup/debug-report diagnostics are validated (83 checks).

## License

MIT
