# @rhythmjs/ws

WebSocket routes for [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework, built on [Bun's own model](https://bun.com/docs/runtime/http/websockets) and nothing else. `RhythmWs` is a pipeline you `mount()` into any existing app, next to routers: its `.ws(path, handlers)` routes call `ctx.server.upgrade()` and decide what each connection's `ws.data` is. Everything else **is** Bun: handlers are Bun `WebSocketHandler` members receiving Bun's `ServerWebSocket`, `ws.data` is the object your route attached (typed per route), and fan-out is Bun's native pub/sub.

## Example

```ts
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { RhythmWs, createWebsocket } from "@rhythmjs/ws";

const ws = new RhythmWs()
  .use(requireSession()) // any Rhythm middleware, run only for matching upgrades
  .ws("/ws/rooms/:id", {
    upgrade(ctx) {
      return { user: ctx.user.name, room: ctx.params.id }; // becomes ws.data, typed
    },
    open(peer) {
      peer.subscribe(`room:${peer.data.room}`);
    },
    message(peer, message) {
      peer.publish(`room:${peer.data.room}`, `${peer.data.user}: ${message}`);
    },
    close(peer) {
      peer.publish(`room:${peer.data.room}`, `${peer.data.user} left`);
    },
  });

const app = new Rhythm().use(mount(router)).use(mount(ws)); // mount it into any app, beside routers

Bun.serve({
  port: 3000,
  fetch: toFetchHandler(app), // passes Bun's server through as ctx.server
  websocket: createWebsocket({ idleTimeout: 120 }),
});
```

## The surface

`RhythmWs` is a `Pipeline`, like `RhythmRouter`: the same `use()` middleware, the same `:param` paths, the same `mount(ws)`. A request reaches it as an ordinary HTTP request; a matching upgrade ends in Bun's own `ctx.server.upgrade(request, { data, headers })`.

- **`new RhythmWs(options?)`**: `name` labels failures (`type` defaults to `"ws"`); `origin` guards against cross-site WebSocket hijacking (browsers attach cookies to handshakes and are exempt from CORS). Default `"same-origin"`: a request carrying an `Origin` header must match its own `Host`, answered with `403` otherwise; requests without one (non-browser clients) pass. Also takes an exact-match allowlist (`["https://app.example"]`), a predicate `(origin, request) => boolean`, or `false` to opt out. The check runs before any middleware.
- **`.ws(path, handlers)`**: an endpoint, `GET` only, with [rou3](https://github.com/h3js/rou3) patterns as in the router (the path is complete; there is no prefix option; a static segment beats a param segment). `handlers` is Bun's `WebSocketHandler` shape (`open`, `message`, `drain`, `close`, `ping`, `pong`; same signatures, same `ServerWebSocket`) plus two upgrade-time members:
  - `upgrade(ctx)`: computes this connection's `ws.data` (any object). `ctx` is the full request context: `ctx.params` typed from the path, everything derived by earlier middleware, `ctx.server`. `ws.data` is typed from what it returns. To reject the handshake, write the response (`ctx.error(403)`, `ctx.json(...)`) or throw; the upgrade is skipped. Without `upgrade`, `ws.data` is the route params, so `peer.data.id` on `/rooms/:id` just works.
  - `headers`: extra headers for the `101` response (subprotocol negotiation, cookies), a `HeadersInit` or `(ctx) =>` one.
- **`.use(middleware)`**: the router's convention, `(ctx, next)` over the HTTP context. It runs only when an upgrade request matches one of the instance's routes, so it never touches ordinary HTTP requests or other paths. Call `next()` to continue, or write the response (`ctx.error(401)`) to reject the handshake. `derive(...)` and other extension middleware widen the context the routes see.
- **`createWebsocket(behavior?)` / `websocket`**: the one `websocket` object for `Bun.serve`. Bun's tuning options live here, because Bun applies them per server: `idleTimeout`, `maxPayloadLength`, `backpressureLimit`, `closeOnBackpressureLimit`, `sendPings`, `publishToSelf`, `perMessageDeflate`. Each connection carries its own route handlers, so one `websocket` serves every `RhythmWs` in the app; `websocket` is `createWebsocket()` with Bun's defaults.

Because the handlers are found by the `ws.data` object's identity, `upgrade` must return a new object for every connection (the default, the route params, already is one); returning a shared object throws.

The fetch handler must be given Bun's server, as `toFetchHandler(app)` does when you pass it as `fetch`. Calling it by hand without a server fails with a clear error.

## Pushing from HTTP handlers

Bun's server is `ctx.server` in every handler, and it publishes to any topic, no socket in hand required:

```ts
router.post("/api/rooms/:id/messages", async (ctx) => {
  ctx.server?.publish(`room:${ctx.params.id}`, await ctx.request.text());
  ctx.json({ ok: true }, 201);
});
```

## Scaling to multiple instances

Bun's pub/sub is in-process. For replicas, relay through a backplane you own (Redis pub/sub via `Bun.redis`, NATS) by calling `server.publish` in the subscriber.

## Testing

`@rhythmjs/testing/ws` drives upgrades without sockets: `upgradeWs(ws, "/rooms/7")` runs middleware, `upgrade`, and `headers` for real and hands back the attached `data` and a recording `peer` (a `ServerWebSocket` mock); `fireOpen`/`fireMessage`/`fireClose`/`fireDrain` dispatch through `websocket` exactly like Bun would.

## Development

From the monorepo root (`bun install` once, then `bun run build` so the examples resolve the built package):

```sh
bun test
bun run check # prettier + oxlint + tsc
bun run build # bun build + tsc declarations
```

See [`examples`](../../examples) for runnable browser demos.
