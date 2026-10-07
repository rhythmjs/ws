import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { RhythmWs, createWebsocket } from "@rhythmjs/ws";

const ws = new RhythmWs()
  .use(async (ctx, next) => {
    if (new URL(ctx.request.url).searchParams.get("token") === "demo") await next();
    else ctx.error(401);
  })
  .ws("/ws/rooms/:id", {
    upgrade(ctx) {
      const room = ctx.params.id;
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

const page = (file: string) => Bun.file(new URL(`../public/${file}`, import.meta.url));

const http = new RhythmRouter()
  .get("/", (ctx) => {
    ctx.response.headers.set("content-type", "text/html; charset=utf-8");
    ctx.response.body = page("index.html");
  })
  .get("/app.js", (ctx) => {
    ctx.response.headers.set("content-type", "text/javascript; charset=utf-8");
    ctx.response.body = page("app.js");
  })
  .post("/api/rooms/:id/announce", async (ctx) => {
    ctx.server?.publish(`room:${ctx.params.id}`, `announcement: ${await ctx.request.text()}`);
    ctx.json({ ok: true }, 201);
  });

const app = new Rhythm().use(mount(ws)).use(mount(http));

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: toFetchHandler(app),
  websocket: createWebsocket({ idleTimeout: 120 }),
});

console.log(`chat listening on ${server.url} (open two tabs, or #room-name for other rooms)`);
console.log(`announce: curl -X POST ${server.url}api/rooms/lobby/announce -d "hello everyone"`);
