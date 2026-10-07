# ws

WebSocket routing for [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework.

- **[`packages/ws`](./packages/ws)**: `@rhythmjs/ws`, a mountable `RhythmWs` pipeline whose `.ws(path, handlers)` routes call `ctx.server.upgrade()`, with
  per-connection typed `ws.data`, on top of `Bun.serve`'s own WebSocket support.

## Examples

Each example is a small `Bun.serve` app with a plain HTML + vanilla JS browser client (no bundler, no framework) in
its `public/` folder.

- **[`examples/chat`](./examples/chat)** (`:3000`): rooms with `:id` route params, an auth middleware, ws and HTTP routes mounted in one app, Bun pub/sub
  fan-out, and an HTTP endpoint that announces into a room.
- **[`examples/cursors`](./examples/cursors)** (`:3001`): live shared mouse cursors over one topic, JSON messages,
  `createWebsocket({ publishToSelf: false })`.
- **[`examples/notifications`](./examples/notifications)** (`:3002`): one-way server push, per-user topics selected at
  upgrade time, published from an HTTP endpoint.

```sh
bun install
bun run build                        # examples import the built package
bun run --filter example-chat start  # or example-cursors / example-notifications
```

Open the printed URL in two tabs. `PORT` overrides the port.

## Development

Bun workspaces, `bun test`, `bun build`, oxlint, prettier.

```sh
bun install
bun run check   # prettier, oxlint, tsc
bun test
bun run build
```
