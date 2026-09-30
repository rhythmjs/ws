# @rhythmjs/ws

Cross-runtime WebSocket routing for Rhythm, built on [crossws](https://crossws.h3.dev). `RhythmWs` routes _connections_ by path with [rou3](https://github.com/h3js/rou3), the same matcher as `@rhythmjs/router` (a static segment always wins over a `:param` segment, and rou3's pattern syntax — `:name`, `:name?`, `*`, `**`, `**:name` — applies), and crossws hooks define what each connection does — on Node, Bun, Deno, and Cloudflare with one definition.

WebSocket upgrades never flow through the HTTP middleware chain: they divert _beside_ the app, per connection, and every ordinary request still belongs to your router.

## Example

```ts
import { RhythmWs } from "@rhythmjs/ws";

const ws = new RhythmWs({ prefix: "/ws" })
  .ws("/chat", {
    open(peer) {
      peer.subscribe("chat");
    },
    message(peer, message) {
      peer.publish("chat", message.text());
    },
  })
  .ws("/rooms/:id", (params) => ({
    open(peer) {
      peer.subscribe(`room:${params.id}`);
    },
  }));
```

- **`.ws(path, hooks)`** — register [crossws hooks](https://crossws.h3.dev/guide/hooks) (`open`, `message`, `close`, `error`, `upgrade`) for a path; patterns follow [rou3](https://github.com/h3js/rou3) conventions (`:param`, `:param?`, `*`, `**`, `**:name`).
- **`.ws(path, (params) => hooks)`** — a function handler receives the captured params. It runs **once per connection** (crossws caches the resolved hooks for the peer's lifetime), so an auth or database lookup here is one call, not one per message.
- **`.use(fn)`** — connection middleware `(request, next) => hooks | Response`, koa-shaped like the router's, but per **connection**, not per message: it runs once at upgrade time, around the endpoints registered **after** it (registration order matters). `return next()` continues resolution; returning or throwing a `Response` rejects the handshake; decorating the result of `await next()` wraps the connection's behavior:

  ```ts
  const ws = new RhythmWs({ prefix: "/ws" })
    .ws("/public", publicHooks) // before the middleware — unguarded
    .use(async (request, next) => {
      if (!(await isAuthorized(request.headers.get("cookie")))) {
        return new Response("Unauthorized", { status: 401 });
      }
      return next();
    })
    .use(async (request, next) => {
      const hooks = await next(); // decorate downstream hooks: per-message logging
      return { ...hooks, message: (peer, msg) => (log(msg), hooks.message?.(peer, msg)) };
    })
    .ws("/chat", chatHooks); // guarded and logged
  ```

- **`.middleware()`** — this `RhythmWs` compiled to a single connection middleware, following the router's convention: a nested `RhythmWs` mounts via `.use(child.middleware())`. On a miss the compiled child falls through to `next()`, so the parent's later middleware and endpoints still run. The mount is opaque, so the mounting instance's prefix is not applied — give the child its full prefix (`new RhythmWs({ prefix: "/ws/rooms" })`). Middleware registered before the mount wraps the child; the child's own middleware is kept inside it.
- **`.resolve`** — the terminal form the adapters consume, `(request) => Promise<hooks>`; crossws knows it as [`resolve`](https://crossws.h3.dev/guide). An unmatched path resolves to hooks whose `upgrade` throws a `404 Response`, which aborts the handshake. Adapters accept the instance or this function.

## Multiple apps on one server

Each server has exactly one upgrade entry point, so several WebSocket apps (chatbots, live dashboards) compose by mounting into one root — the same shape as multiple `RhythmRouter`s in one `Rhythm` app:

```ts
const root = new RhythmWs()
  .use(supportBot.middleware()) // RhythmWs with prefix "/ws/support"
  .use(salesBot.middleware()); // RhythmWs with prefix "/ws/sales"
```

Topics share one namespace per adapter instance — prefix them per app (`support:room:${id}`).

## Scaling to multiple instances

`peer.publish` only reaches peers on the same instance. For multiple replicas, pass a crossws [sync backplane](https://crossws.h3.dev) to the adapter and publishes relay cluster-wide:

```ts
import { redis } from "crossws/sync";

const adapter = handle(ws, { sync: redis(redisClient) });
```

## Serving per runtime

Each runtime has an adapter under `@rhythmjs/ws/adapters/*` whose `handle(ws, options?)` returns the crossws instance for that platform (`options` accepts everything crossws does except `resolve` — e.g. `idleTimeout`, shared `hooks`).

**Node** — upgrades arrive on the server's `upgrade` event, not the request listener; `attach` wires it:

```ts
import { createServer } from "node:http";
import { getRequestListener } from "@rhythmjs/router/adapters/node";
import { attach, handle } from "@rhythmjs/ws/adapters/node";

const server = createServer(getRequestListener(app));
attach(server, handle(ws));
server.listen(3000);
```

With `serve()` from `@rhythmjs/router/serve`, use the plugin seam: `serve(app, { plugins: [(s) => s.node?.server && attach(s.node.server, handle(ws))] })`.

**Bun** — pass the adapter's `websocket` to `Bun.serve`, and the instance itself to the router adapter's `websocket` option, which diverts upgrade requests before the app:

```ts
import { handle as handleApp } from "@rhythmjs/router/adapters/bun";
import { handle as handleWs } from "@rhythmjs/ws/adapters/bun";

const adapter = handleWs(ws);
Bun.serve({
  port: 3000,
  websocket: adapter.websocket,
  fetch: handleApp(app, { websocket: adapter }),
});
```

**Deno**

```ts
import { handle as handleApp } from "@rhythmjs/router/adapters/deno";
import { handle as handleWs } from "@rhythmjs/ws/adapters/deno";

Deno.serve({ port: 3000 }, handleApp(app, { websocket: handleWs(ws) }));
```

**Cloudflare Workers** — requires a [Durable Object binding](https://crossws.h3.dev/adapters/cloudflare) for the socket to live in:

```ts
import { handle as handleApp } from "@rhythmjs/router/adapters/cloudflare";
import { handle as handleWs } from "@rhythmjs/ws/adapters/cloudflare";

const adapter = handleWs(ws);
export default { fetch: handleApp(app, { websocket: adapter }) };
```

## Pushing from HTTP handlers

The adapter instance is a plain object — import it anywhere and publish to a topic from an ordinary route:

```ts
router.post("/api/rooms/:id/messages", async (ctx) => {
  adapter.publish(`room:${ctx.params.id}`, await ctx.request.text());
  ctx.json({ ok: true }, 201);
});
```
