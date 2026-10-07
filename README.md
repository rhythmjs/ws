# ws

`@rhythmjs/ws` adds WebSocket routes to [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework. `RhythmWs` is a pipeline you `mount()` into your app next to your routers: its `.ws(path, handlers)` routes upgrade matching requests with Bun's own `server.upgrade()`, you decide what each connection's typed `ws.data` is, and everything after that (handlers, `ServerWebSocket`, pub/sub) is plain Bun.

## Installation

```sh
bun add @rhythmjs/ws @rhythmjs/rhythm @rhythmjs/router
```

Requires Bun 1.2 or newer. `@rhythmjs/rhythm` and `@rhythmjs/router` are peer dependencies (0.0.20 or newer).

## Use it with Rhythm

A router and a `RhythmWs` mounted side by side, served by one `Bun.serve`:

```ts
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { RhythmWs, websocket } from "@rhythmjs/ws";

const http = new RhythmRouter()
  .get("/health", (ctx) => ctx.text("ok"))
  .post("/api/rooms/:id/announce", async (ctx) => {
    ctx.server?.publish(`room:${ctx.params.id}`, await ctx.request.text());
    ctx.json({ ok: true }, 201);
  });

const ws = new RhythmWs().ws("/ws/rooms/:id", {
  upgrade(ctx) {
    return { room: ctx.params.id, handle: crypto.randomUUID().slice(0, 6) };
  },
  open(peer) {
    peer.subscribe(`room:${peer.data.room}`);
  },
  message(peer, message) {
    peer.publish(`room:${peer.data.room}`, `${peer.data.handle}: ${String(message)}`);
  },
});

const app = new Rhythm().use(mount(http)).use(mount(ws));

Bun.serve({
  port: 3000,
  fetch: toFetchHandler(app),
  websocket,
});
```

`toFetchHandler(app)` hands Bun's server to the app as `ctx.server`, which is what `RhythmWs` upgrades with and what your HTTP routes publish through. See the [package guide](./packages/ws/README.md) for middleware, origin checks, pub/sub, tuning, and testing.

## Examples

Each example is a small `Bun.serve` app with a plain HTML and vanilla JS browser client in its `public/` folder.

- **[`examples/chat`](./examples/chat)** (`:3000`): rooms with `:id` route params, an auth middleware on the ws pipeline, ws and HTTP routes mounted in one app, Bun pub/sub fan-out, and an HTTP endpoint that announces into a room.
- **[`examples/cursors`](./examples/cursors)** (`:3001`): live shared mouse cursors over one topic, JSON messages, `createWebsocket({ publishToSelf: false })`.
- **[`examples/notifications`](./examples/notifications)** (`:3002`): one-way server push, per-user topics chosen at upgrade time, published from HTTP endpoints.

To run one from a checkout:

```sh
bun install
bun run --filter example-chat start  # or example-cursors / example-notifications
```

Open the printed URL in two tabs. `PORT` overrides the port.
