# @rhythmjs/ws

WebSocket routes for [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework, built on [Bun's own WebSocket model](https://bun.com/docs/runtime/http/websockets) and nothing else. `RhythmWs` is a pipeline you `mount()` into an app beside your routers. Its `.ws(path, handlers)` routes decide what each connection's `ws.data` is and call Bun's `server.upgrade()`. After that, handlers are Bun's `WebSocketHandler` members receiving Bun's `ServerWebSocket`, and fan-out is Bun's native pub/sub.

## Installation

```sh
bun add @rhythmjs/ws @rhythmjs/rhythm @rhythmjs/router
```

Requires Bun 1.2 or newer. `@rhythmjs/rhythm` and `@rhythmjs/router` are peer dependencies (0.0.20 or newer).

## Quick start

```ts
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { RhythmWs, createWebsocket } from "@rhythmjs/ws";

const http = new RhythmRouter().get("/health", (ctx) => ctx.text("ok"));

const ws = new RhythmWs().ws("/ws/rooms/:id", {
  upgrade(ctx) {
    return { room: ctx.params.id, handle: crypto.randomUUID().slice(0, 6) }; // becomes ws.data
  },
  open(peer) {
    peer.subscribe(`room:${peer.data.room}`);
  },
  message(peer, message) {
    peer.publish(`room:${peer.data.room}`, `${peer.data.handle}: ${String(message)}`);
  },
  close(peer) {
    peer.publish(`room:${peer.data.room}`, `${peer.data.handle} left`);
  },
});

const app = new Rhythm().use(mount(http)).use(mount(ws));

Bun.serve({
  port: 3000,
  fetch: toFetchHandler(app), // passes Bun's server through as ctx.server
  websocket: createWebsocket({ idleTimeout: 120 }),
});
```

## How it works

`RhythmWs` is a `Pipeline`, like `RhythmRouter`: the same `use()` middleware, the same `:param` paths, mounted the same way with `mount(ws)`. Paths are complete; there is no prefix option.

For every request, the pipeline does the following:

1. If the request is not a `GET` with `Upgrade: websocket`, or no `.ws()` route matches its path, it passes through untouched to the rest of the app (so a router mounted after it can answer, or the app returns 404). Middleware never runs for these.
2. The origin check runs (see [Origin checks](#origin-checks)). A refused origin answers `403`.
3. The `use()` middleware runs, in order, over the HTTP context. A middleware can reject the handshake by writing a response (`ctx.error(401)`) instead of calling `next()`.
4. The route's `upgrade(ctx)` hook runs and returns this connection's `ws.data`. It can also reject by writing a response or throwing.
5. The route's `headers` (if any) are resolved, then `ctx.server.upgrade(request, { data, headers })` is called and the response status is set to `101`. If Bun refuses the upgrade, the request answers `500`.

`ctx.server` is Bun's server. It is there because `toFetchHandler(app)` calls your app as `fetch(request, server)`. If you call the handler by hand without a server, the upgrade throws `ctx.server is undefined: call the fetch handler with Bun's server`.

Each connection carries its own route's handlers, found by the identity of its `ws.data` object. That is why the single `websocket` object serves every `RhythmWs` in the app, and why `upgrade` must return a new object for every connection (returning a shared object throws a `TypeError`). The default `ws.data`, the route params, is already a fresh object each time.

## API

### `new RhythmWs(options?)`

Options extend the pipeline options (`name` labels failures; `type` defaults to `"ws"`) with:

- `origin`: see [Origin checks](#origin-checks). Defaults to `"same-origin"`.

### `.ws(path, handlers)`

Registers an endpoint and returns the instance, so calls chain. `GET` only. `path` must start with `/` (a `TypeError` otherwise) and uses [rou3](https://github.com/h3js/rou3) patterns, as the router does; a static segment beats a param segment (`/rooms/lobby` wins over `/rooms/:id`). URL-encoded params are decoded; a malformed encoding makes the request pass through unmatched.

`handlers` is an object with Bun's `WebSocketHandler` members plus two upgrade-time members:

| Member                              | Purpose                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `upgrade(ctx)`                      | Returns this connection's `ws.data` (any object). May be async. Write a response (`ctx.error(403)`) or throw to refuse the handshake. |
| `headers`                           | Extra headers for the `101` response (subprotocol negotiation, cookies): a `HeadersInit`, or `(ctx) =>` one, sync or async.           |
| `open(ws)`                          | The connection opened.                                                                                                                |
| `message(ws, message)`              | A message arrived; `message` is `string \| Buffer`.                                                                                   |
| `drain(ws)`                         | The socket is writable again after backpressure.                                                                                      |
| `close(ws, code, reason)`           | The connection closed.                                                                                                                |
| `ping(ws, data)` / `pong(ws, data)` | A ping or pong frame arrived (`data` is a `Buffer`).                                                                                  |

Every member is optional. `ws` is Bun's `ServerWebSocket<Data>` (`send`, `subscribe`, `publish`, `close`, ...); the examples name it `peer`.

`ctx` in `upgrade` and `headers` is the full request context: `ctx.request`, `ctx.params` typed from the path, `ctx.server`, and everything derived by earlier middleware.

`ws.data` is typed from what `upgrade` returns. Without `upgrade`, `ws.data` is the route params, so `peer.data.id` on `/rooms/:id` just works.

```ts
new RhythmWs().ws("/rooms/:id", {
  upgrade: () => ({ user: "ada" }),
  open(peer) {
    peer.data.user; // string
    // peer.data.id is a type error: not in the data the hook returns
  },
});
```

### `.use(middleware)`

The router's convention: `(ctx, next)` over the HTTP context. It runs only when an upgrade request matches one of the instance's routes. Call `next()` to continue or write the response to reject the handshake. `derive(...)` and other extension middleware widen the context that later `use()` calls and every route's `upgrade` see.

### `createWebsocket(behavior?)` and `websocket`

The one `websocket` object for `Bun.serve`. `websocket` is `createWebsocket()` with Bun's defaults; call `createWebsocket` to tune Bun's per-server options:

| Option                     | Meaning (Bun's)                                    |
| -------------------------- | -------------------------------------------------- |
| `maxPayloadLength`         | Largest message accepted, in bytes.                |
| `idleTimeout`              | Seconds of inactivity before the socket is closed. |
| `backpressureLimit`        | Buffered bytes before `send` reports backpressure. |
| `closeOnBackpressureLimit` | Close the connection when the limit is exceeded.   |
| `sendPings`                | Send automatic pings.                              |
| `publishToSelf`            | Whether `peer.publish` also delivers to the peer.  |
| `perMessageDeflate`        | Compression settings.                              |

```ts
Bun.serve({
  fetch: toFetchHandler(app),
  websocket: createWebsocket({ maxPayloadLength: 64 * 1024, idleTimeout: 60, publishToSelf: false }),
});
```

## Middleware and other Rhythm pieces

`RhythmWs` middleware is ordinary Rhythm HTTP middleware, so the pieces you already use for routers work on upgrades too. It runs over the handshake request, which carries cookies and headers like any other `GET`.

```ts
import { session } from "@rhythmjs/http/session";

const ws = new RhythmWs().use(session()).ws("/ws/inbox", {
  upgrade(ctx) {
    return { userId: ctx.session.get<string>("userId") ?? "anonymous" };
  },
});
```

- **Session and cookies from `@rhythmjs/http`**: `session()` and `cookies()` are extension middleware; `.use(...)` them and `ctx.session` / cookie helpers are available in `upgrade` and `headers`.
- **Rate limiting from `@rhythmjs/security`**: `rateLimit` works as on a router. Your own authentication guards (a `derive` step that resolves the user, then a `(ctx, next)` guard) go in the same `use()` slot.
- **`@rhythmjs/better-auth`**: `withSession()` / `requireSession()` apply with `.use(...)` like any other middleware, and need the same `ctx.auth` that its module provides to the app.

Order matters, as everywhere in Rhythm: middleware runs in the order you call `use()`, after the origin check and before the route's `upgrade`. Put guards (rate limit, authentication) before anything expensive, and put whatever `upgrade` depends on before the route.

Do authentication in middleware or in `upgrade`, not in `message`: once the socket is open the handshake is over, and `ws.data` is the identity you carry for the connection's lifetime.

## Origin checks

Browsers attach cookies to WebSocket handshakes and are exempt from CORS, so a page on another site can open a socket as your logged-in user (cross-site WebSocket hijacking). `RhythmWs` checks the `Origin` header before running any middleware:

```ts
new RhythmWs(); // "same-origin" (default)
new RhythmWs({ origin: ["https://app.example"] }); // exact-match allowlist
new RhythmWs({ origin: (origin, request) => origin.endsWith(".example") }); // predicate, sync or async
new RhythmWs({ origin: false }); // no check
```

- `"same-origin"`: a request with an `Origin` header must have the same host as the request's own `Host`; otherwise it answers `403`.
- A request with no `Origin` header (non-browser clients) always passes.

## Pub/sub

Fan-out is Bun's native topic pub/sub. A peer subscribes in `open` and publishes to the topic; every subscribed peer receives it:

```ts
open(peer) {
  peer.subscribe(`room:${peer.data.room}`);
},
message(peer, message) {
  peer.publish(`room:${peer.data.room}`, String(message));
},
```

`peer.publish` delivers to every other subscriber of the topic; set `publishToSelf: true` in `createWebsocket` to include the sender. Call `peer.send` to answer one socket only.

Bun's server is `ctx.server` in every HTTP handler, and it publishes to any topic with no socket in hand:

```ts
const http = new RhythmRouter().post("/api/rooms/:id/messages", async (ctx) => {
  ctx.server?.publish(`room:${ctx.params.id}`, await ctx.request.text());
  ctx.json({ ok: true }, 201);
});
```

Per-user push works the same way: subscribe each connection to `user:${peer.data.user}` at open, then publish to that topic from anywhere.

## Joining a room by message

Instead of a path param per room (`/ws/rooms/:id`), keep a single endpoint and let the client say which room it wants. This is the recommended shape for most apps: one socket survives switching rooms, rooms are validated in one place, and the route's `upgrade` stays about identity.

```ts
import { RhythmWs } from "@rhythmjs/ws";

const ws = new RhythmWs().ws("/ws", {
  upgrade() {
    return { handle: crypto.randomUUID().slice(0, 6), room: undefined as string | undefined };
  },
  message(peer, message) {
    const command = JSON.parse(String(message)) as { type: "join"; room: string } | { type: "say"; text: string };

    if (command.type === "join") {
      if (peer.data.room) {
        peer.unsubscribe(`room:${peer.data.room}`);
        peer.publish(`room:${peer.data.room}`, `${peer.data.handle} left`);
      }
      peer.data.room = command.room;
      peer.subscribe(`room:${command.room}`);
      peer.publish(`room:${command.room}`, `${peer.data.handle} joined`);
      return;
    }

    if (peer.data.room) peer.publish(`room:${peer.data.room}`, `${peer.data.handle}: ${command.text}`);
  },
  close(peer) {
    if (peer.data.room) peer.publish(`room:${peer.data.room}`, `${peer.data.handle} left`);
  },
});
```

Because `ws.data` is a mutable per-connection object, tracking the current room on it is safe. Validate and authorize the room name in the `join` branch (and parse defensively: `JSON.parse` throws on bad input).

## Scaling to multiple instances

Bun's pub/sub is in-process: a topic only reaches sockets connected to the same server. For replicas, relay through a backplane you own (Redis pub/sub, NATS): publish to the backplane from your handlers, and in the subscriber call `server.publish` so each instance fans out to its own sockets.

## Testing

`@rhythmjs/testing/ws` drives upgrades and handlers without opening sockets.

- `upgradeWs(ws, path)`: runs the origin check, middleware, `upgrade`, and `headers` for real against a fake Bun server. `path` is a string (sent as a websocket upgrade `GET` to `http://localhost`) or a `Request`. It returns `{ upgraded, response, data, headers, peer }`: when accepted, `upgraded` is `true` with the attached `data` and a recording `peer`; when rejected or unmatched, `response` holds the answer and `peer` is `null`.
- `peer`: a mock `ServerWebSocket` that records what happened: `sent`, `published`, `topics`, `closed`, `terminated`, plus `isSubscribed(topic)`.
- `fireOpen(peer)`, `fireMessage(peer, data)`, `fireClose(peer, code?, reason?)`, and `fireDrain(peer)`: dispatch through the real `websocket` handler like Bun would. `fireMessage` accepts a string, bytes, or an object (sent as JSON).

```ts
import { expect, test } from "bun:test";
import { fireMessage, fireOpen, upgradeWs } from "@rhythmjs/testing/ws";

test("a message is published to the room", async () => {
  const { upgraded, peer } = await upgradeWs(ws, "/ws/rooms/7");
  expect(upgraded).toBe(true);

  await fireOpen(peer!);
  await fireMessage(peer!, "hi");

  expect(peer!.isSubscribed("room:7")).toBe(true);
  expect(peer!.published.at(-1)?.topic).toBe("room:7");
});

test("an upgrade without a token is rejected", async () => {
  const result = await upgradeWs(guardedWs, "/guarded");
  expect(result.upgraded).toBe(false);
  expect(result.response?.status).toBe(401);
});
```

## Examples

See [`examples`](../../examples) for runnable browser demos: a chat with rooms, shared live cursors, and per-user push notifications.
