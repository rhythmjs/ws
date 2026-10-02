import { RhythmWs } from "@rhythmjs/ws";

interface Chat {
  handle: string;
  room: string;
  topic: string;
}

const ws = new RhythmWs({ prefix: "/ws", idleTimeout: 120 })
  .use(async (ctx, next) => {
    if (new URL(ctx.request.url).searchParams.get("token") === "demo") await next();
    else ctx.response = new Response("Unauthorized", { status: 401 });
  })
  .route<Chat>("/rooms/:id", {
    upgrade(_request, params) {
      const room = params.id!;
      return { handle: Math.random().toString(36).slice(2, 8), room, topic: `room:${room}` };
    },
    open(peer) {
      peer.subscribe(peer.data.topic);
      peer.send(`joined ${peer.data.room} as ${peer.data.handle}`);
      peer.publish(peer.data.topic, `${peer.data.handle} joined`);
    },
    message(peer, message) {
      const line = `${peer.data.handle}: ${String(message)}`;
      peer.send(line);
      peer.publish(peer.data.topic, line);
    },
    close(peer) {
      peer.publish(peer.data.topic, `${peer.data.handle} left`);
    },
  });

const files: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(request, srv) {
    const upgrade = ws.upgrade(request, srv);
    if (upgrade !== null) return upgrade;

    const { pathname } = new URL(request.url);
    const announce = pathname.match(/^\/api\/rooms\/([^/]+)\/announce$/);
    if (request.method === "POST" && announce) {
      srv.publish(`room:${announce[1]}`, `announcement: ${await request.text()}`);
      return Response.json({ ok: true }, { status: 201 });
    }

    const file = files[pathname];
    return file
      ? new Response(Bun.file(new URL(`../public/${file}`, import.meta.url)))
      : new Response("Not Found", { status: 404 });
  },
  websocket: ws.websocket,
});

console.log(`chat listening on ${server.url} (open two tabs, or #room-name for other rooms)`);
console.log(`announce: curl -X POST ${server.url}api/rooms/lobby/announce -d "hello everyone"`);
