import { RhythmWs } from "@rhythmjs/ws";

interface Inbox {
  user: string;
}

// Server push: browsers only listen, other code (here an HTTP endpoint) publishes to user topics.
const ws = new RhythmWs({ prefix: "/ws" })
  .use(async (ctx, next) => {
    if (new URL(ctx.request.url).searchParams.get("user")) await next();
    else ctx.response = new Response("Missing ?user=", { status: 400 });
  })
  .route<Inbox>("/inbox", {
    upgrade(request) {
      return { user: new URL(request.url).searchParams.get("user")! };
    },
    open(peer) {
      peer.subscribe(`user:${peer.data.user}`);
      peer.subscribe("broadcast");
      peer.send(JSON.stringify({ title: "connected", body: `listening as ${peer.data.user}` }));
    },
  });

const files: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3002),
  async fetch(request, srv) {
    const upgrade = ws.upgrade(request, srv);
    if (upgrade !== null) return upgrade;

    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname.startsWith("/api/notify")) {
      // POST /api/notify -> everyone, POST /api/notify/:user -> one user
      const user = pathname.slice("/api/notify".length).replace(/^\//, "");
      const notification = (await request.json()) as { title: string; body?: string };
      srv.publish(user ? `user:${user}` : "broadcast", JSON.stringify(notification));
      return Response.json({ ok: true }, { status: 201 });
    }

    const file = files[pathname];
    return file
      ? new Response(Bun.file(new URL(`../public/${file}`, import.meta.url)))
      : new Response("Not Found", { status: 404 });
  },
  websocket: ws.websocket,
});

console.log(`notifications listening on ${server.url} (open ${server.url}?user=ada)`);
console.log(`push: curl -X POST ${server.url}api/notify/ada -d '{"title":"hi","body":"just for ada"}'`);
