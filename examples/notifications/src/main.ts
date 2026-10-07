import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { RhythmWs, websocket } from "@rhythmjs/ws";

// Server push: browsers only listen, other code (here an HTTP endpoint) publishes to user topics.
const ws = new RhythmWs()
  .use(async (ctx, next) => {
    if (new URL(ctx.request.url).searchParams.get("user")) await next();
    else ctx.error(400, "Missing ?user=");
  })
  .ws("/ws/inbox", {
    upgrade(ctx) {
      return { user: new URL(ctx.request.url).searchParams.get("user")! };
    },
    open(peer) {
      peer.subscribe(`user:${peer.data.user}`);
      peer.subscribe("broadcast");
      peer.send(JSON.stringify({ title: "connected", body: `listening as ${peer.data.user}` }));
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
  // POST /api/notify -> everyone, POST /api/notify/:user -> one user
  .post("/api/notify", async (ctx) => {
    ctx.server?.publish("broadcast", JSON.stringify(await ctx.request.json()));
    ctx.json({ ok: true }, 201);
  })
  .post("/api/notify/:user", async (ctx) => {
    ctx.server?.publish(`user:${ctx.params.user}`, JSON.stringify(await ctx.request.json()));
    ctx.json({ ok: true }, 201);
  });

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3002),
  fetch: toFetchHandler(new Rhythm().use(mount(ws)).use(mount(http))),
  websocket,
});

console.log(`notifications listening on ${server.url} (open ${server.url}?user=ada)`);
console.log(`push: curl -X POST ${server.url}api/notify/ada -d '{"title":"hi","body":"just for ada"}'`);
