# @rhythmjs/ws

WebSocket routing for [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework, built on [Bun's own model](https://bun.com/docs/runtime/http/websockets) and nothing else. `RhythmWs` adds exactly the two things `Bun.serve` leaves to you (matching upgrade requests to endpoints, and deciding what each connection's `ws.data` is) with [rou3](https://github.com/h3js/rou3) route patterns (`:param`, `:param?`, `*`, `**`; a static segment beats a param segment). Everything else **is** Bun: handlers are Bun `WebSocketHandler` members receiving Bun's `ServerWebSocket`, `ws.data` is the object your route attached (typed per route), fan-out is Bun's native pub/sub, and the handshake is `server.upgrade()`.

## Example

```ts
import { RhythmWs } from "@rhythmjs/ws";

interface Chat {
  user: string;
  room: string;
}

const ws = new RhythmWs({ prefix: "/ws", idleTimeout: 120 })
  .use(async (ctx, next) => {
    if (authorized(ctx.request)) await next();
    else ctx.response = new Response("Unauthorized", { status: 401 });
  })
  .route<Chat>("/rooms/:id", {
    upgrade(request, params) {
      const user = userFrom(request);
      if (!user) return new Response("Forbidden", { status: 403 });
      return { user, room: params.id! }; // becomes ws.data
    },
    open(ws) {
      ws.subscribe(`room:${ws.data.room}`);
    },
    message(ws, message) {
      ws.publish(`room:${ws.data.room}`, `${ws.data.user}: ${message}`);
    },
    close(ws) {
      ws.publish(`room:${ws.data.room}`, `${ws.data.user} left`);
    },
  });

Bun.serve({
  port: 3000,
  fetch: (request, server) => ws.upgrade(request, server) ?? app(request),
  websocket: ws.websocket,
});
```

## The surface

- **`new RhythmWs(options?)`**: `prefix`, `origin`, plus Bun's websocket tuning, carried onto `.websocket`: `idleTimeout`, `maxPayloadLength`, `backpressureLimit`, `closeOnBackpressureLimit`, `sendPings`, `publishToSelf`, `perMessageDeflate`.
  - `origin` guards against cross-site WebSocket hijacking (browsers attach cookies to handshakes and are exempt from CORS). Default `"same-origin"`: a request carrying an `Origin` header must match its own `Host`, answered with `403` otherwise; requests without one (non-browser clients) pass. Also takes an exact-match allowlist (`["https://app.example"]`), a predicate `(origin, request) => boolean`, or `false` to opt out. The check runs before any middleware, using the options of the instance whose `upgrade` you pass to `Bun.serve` (a mounted child's `origin` option is not consulted).
- **`.route<Data>(path, handlers)`**: an endpoint. `handlers` is Bun's `WebSocketHandler` shape (`open`, `message`, `drain`, `close`, `ping`, `pong`; same signatures, same `ServerWebSocket`) plus two upgrade-time members:
  - `upgrade(request, params, server)`: computes this connection's `ws.data` (any object), or returns a `Response` to reject the handshake. Without it, `ws.data` is the route params, so `ws.data.id` on `/rooms/:id` just works.
  - `headers`: extra headers for the `101` response (subprotocol negotiation, cookies), a `HeadersInit` or `(request, params) =>` one.
- **`.use(fn)`**: Rhythm middleware over the upgrade context, exactly the router's convention: `(ctx, next)` with `ctx` = `{ request, server, response }` (`RhythmWsContext`). Set `ctx.response` to reject the handshake; call `next()` to continue toward the routes. Middleware and routes interleave in registration order, and middleware never runs for unmatched paths. Fail-closed: a middleware that returns without calling `next()` — or that sets a `response`, even if it still calls `next()` — rejects the handshake; the upgrade only happens when the chain reaches a matched route with no response set.
- **`.middleware()`**: compiles the instance (middleware + routes) into one mountable middleware, the router's composition convention. A parent mounts a child with `parent.use(child.middleware())`: the child's routes join the parent's matching (so `upgrade()` still answers `null` synchronously for unmatched paths), and the child's own middleware stays scoped inside its compiled pipeline. Like the router, the child declares its own full `prefix`; the parent's prefix is not prepended. Snapshot semantics: routes added to the child after `middleware()` stay out.
- **`.upgrade(request, server)`**: the fetch-side half, bound so you can pass it around. Returns **`null` synchronously** when the request is not a matching websocket upgrade (that's what makes `?? app(request)` work), otherwise a promise of `undefined` (upgraded) or the rejecting `Response` (a refused `server.upgrade()` answers `500 Upgrade failed`, Bun's own convention).
- **`.websocket`**: the one `websocket` behavior for `Bun.serve`. Dispatch is keyed on the `ws.data` object identity, so one behavior serves connections upgraded by *any* `RhythmWs` instance:

  ```ts
  Bun.serve({
    fetch: (req, server) => support.upgrade(req, server) ?? sales.upgrade(req, server) ?? app(req),
    websocket: support.websocket, // dispatches for sales too
  });
  ```

Because `data` keys the dispatch, `upgrade` must return an object (the default params already are one), fresh per connection.

## With `@rhythmjs/router`

There is no server wrapper anywhere in the ecosystem: the router's app is a fetch handler, and both halves plug into your own `Bun.serve`:

```ts
import { toFetchHandler } from "@rhythmjs/router/fetch";

const handler = toFetchHandler(app);

Bun.serve({
  port: 3000,
  fetch: (request, server) => ws.upgrade(request, server) ?? handler(request),
  websocket: ws.websocket,
});
```

## Pushing from HTTP handlers

Bun's server publishes to any topic; no socket in hand required:

```ts
router.post("/api/rooms/:id/messages", async (ctx) => {
  server.publish(`room:${ctx.params.id}`, await ctx.request.text());
  ctx.json({ ok: true }, 201);
});
```

## Scaling to multiple instances

Bun's pub/sub is in-process. For replicas, relay through a backplane you own (Redis pub/sub via `Bun.redis`, NATS) by calling `server.publish` in the subscriber.

## Testing

`@rhythmjs/testing/ws` drives upgrades without sockets: `upgradeWs(ws, "/rooms/7")` runs middleware, `upgrade`, and `headers` for real and hands back the attached `data`; `mockWs(data)` is a recording `ServerWebSocket`; `fireOpen`/`fireMessage`/`fireClose`/`fireDrain` dispatch through `.websocket` exactly like Bun would.

## Development

```sh
bun install
bun test
bun run check # prettier + oxlint + tsc
bun run build # bun build + tsc declarations
bun example/index.ts
```
