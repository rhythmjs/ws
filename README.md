# @rhythmjs/ws

WebSocket routing for [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework, built on [Bun's own model](https://bun.com/docs/runtime/http/websockets) and nothing else. `RhythmWs` adds exactly the two things `Bun.serve` leaves to you — matching upgrade requests to endpoints, and deciding what each connection's `ws.data` is — with [rou3](https://github.com/h3js/rou3) route patterns (`:param`, `:param?`, `*`, `**`; a static segment beats a param segment). Everything else **is** Bun: handlers are Bun `WebSocketHandler` members receiving Bun's `ServerWebSocket`, `ws.data` is the object your route attached (typed per route), fan-out is Bun's native pub/sub, and the handshake is `server.upgrade()`.

## Example

```ts
import { RhythmWs } from "@rhythmjs/ws";

interface Chat {
  user: string;
  room: string;
}

const ws = new RhythmWs({ prefix: "/ws", idleTimeout: 120 })
  .guard((request) => (authorized(request) ? undefined : new Response("Unauthorized", { status: 401 })))
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

- **`new RhythmWs(options?)`** — `prefix` plus Bun's websocket tuning, carried onto `.websocket`: `idleTimeout`, `maxPayloadLength`, `backpressureLimit`, `closeOnBackpressureLimit`, `sendPings`, `publishToSelf`, `perMessageDeflate`.
- **`.route<Data>(path, handlers)`** — an endpoint. `handlers` is Bun's `WebSocketHandler` shape (`open`, `message`, `drain`, `close`, `ping`, `pong` — same signatures, same `ServerWebSocket`) plus two upgrade-time members:
  - `upgrade(request, params, server)` — computes this connection's `ws.data` (any object), or returns a `Response` to reject the handshake. Without it, `ws.data` is the route params, so `ws.data.id` on `/rooms/:id` just works.
  - `headers` — extra headers for the `101` response (subprotocol negotiation, cookies), a `HeadersInit` or `(request, params) =>` one.
- **`.guard(fn)`** — `(request, server) => Response | undefined`, runs in order before every matched route of the instance; a `Response` rejects the handshake. Guards never run for unmatched paths.
- **`.merge(child)`** — mounts another instance's routes under this prefix (`/ws` + `/rooms/:id` → `/ws/rooms/:id`), keeping the child's guards nested inside this instance's own. Snapshot semantics: later changes to the child stay out.
- **`.upgrade(request, server)`** — the fetch-side half, bound so you can pass it around. Returns **`null` synchronously** when the request is not a matching websocket upgrade — that's what makes `?? app(request)` work — otherwise a promise of `undefined` (upgraded) or the rejecting `Response` (a refused `server.upgrade()` answers `500 Upgrade failed`, Bun's own convention).
- **`.websocket`** — the one `websocket` behavior for `Bun.serve`. Dispatch is keyed on the `ws.data` object identity, so one behavior serves connections upgraded by *any* `RhythmWs` instance:

  ```ts
  Bun.serve({
    fetch: (req, server) => support.upgrade(req, server) ?? sales.upgrade(req, server) ?? app(req),
    websocket: support.websocket, // dispatches for sales too
  });
  ```

Because `data` keys the dispatch, `upgrade` must return an object (the default params already are one), fresh per connection.

## With `@rhythmjs/router`

```ts
import { serve } from "@rhythmjs/router/serve";

serve(app, { port: 3000, upgrade: ws.upgrade, websocket: ws.websocket });
```

`serve()` understands the same three-way result: `Response` rejects, `undefined` means upgraded, `null` falls through to the HTTP app.

## Pushing from HTTP handlers

Bun's server publishes to any topic — no socket in hand required:

```ts
router.post("/api/rooms/:id/messages", async (ctx) => {
  server.publish(`room:${ctx.params.id}`, await ctx.request.text());
  ctx.json({ ok: true }, 201);
});
```

## Scaling to multiple instances

Bun's pub/sub is in-process. For replicas, relay through a backplane you own (Redis pub/sub via `Bun.redis`, NATS) by calling `server.publish` in the subscriber.

## Testing

`@rhythmjs/testing/ws` drives upgrades without sockets: `upgradeWs(ws, "/rooms/7")` runs guards, `upgrade`, and `headers` for real and hands back the attached `data`; `mockWs(data)` is a recording `ServerWebSocket`; `fireOpen`/`fireMessage`/`fireClose`/`fireDrain` dispatch through `.websocket` exactly like Bun would.

## Development

```sh
bun install
bun test
bun run check      # prettier + oxlint + tsc
bun run build      # bun build + tsc declarations
bun example/index.ts
```
