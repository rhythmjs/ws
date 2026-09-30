import { createServer } from "node:http";
import { Rhythm } from "@rhythmjs/rhythm";
import type { RhythmHttpContext } from "@rhythmjs/router/context";
import { getRequestListener } from "@rhythmjs/router/adapters/node";
import { RhythmRouter } from "@rhythmjs/router";
import { RhythmWs, type WsMiddleware } from "../src/rhythm-ws.ts";
import { attach, handle } from "../src/adapters/node.ts";

const page = `<!doctype html>
<meta charset="utf-8" />
<title>Rhythm chat</title>
<input id="msg" placeholder="Say something…" autofocus />
<pre id="log"></pre>
<script>
  const room = location.hash.slice(1) || "lobby";
  const socket = new WebSocket(\`ws://\${location.host}/ws/rooms/\${room}?token=demo\`);
  const log = (line) => (document.getElementById("log").textContent += line + "\\n");
  socket.addEventListener("message", (e) => log(e.data));
  socket.addEventListener("close", () => log("(disconnected — bad token?)"));
  document.getElementById("msg").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value) {
      socket.send(e.target.value);
      e.target.value = "";
    }
  });
</script>`;

const requireToken: WsMiddleware = (request, next) => {
  if (new URL(request.url).searchParams.get("token") !== "demo") {
    return new Response("Unauthorized", { status: 401 });
  }
  return next();
};

const logMessages: WsMiddleware = async (request, next) => {
  const hooks = await next();
  const path = new URL(request.url).pathname;
  return {
    ...hooks,
    message(peer, message) {
      console.log(`[ws] ${path} <- ${message.text()}`);
      return hooks.message?.(peer, message);
    },
  };
};

const chat = new RhythmWs({ prefix: "/ws/rooms" }).ws("/:id", (params) => {
  const topic = `room:${params.id}`;
  return {
    open(peer) {
      peer.subscribe(topic);
      peer.send(`joined ${params.id}`);
      peer.publish(topic, `${peer.id.slice(0, 8)} joined ${params.id}`);
    },
    message(peer, message) {
      const line = `${peer.id.slice(0, 8)}: ${message.text()}`;
      peer.send(line);
      peer.publish(topic, line);
    },
    close(peer) {
      peer.publish(topic, `${peer.id.slice(0, 8)} left ${params.id}`);
    },
  };
});

const ws = new RhythmWs({ prefix: "/ws" })
  .ws("/echo", {
    message(peer, message) {
      peer.send(`echo: ${message.text()}`);
    },
  })
  .use(requireToken)
  .use(logMessages)
  .use(chat.middleware());

const adapter = handle(ws);

const apiRouter = new RhythmRouter({ prefix: "/api" }).post("/rooms/:id/announce", async (ctx) => {
  const text = await ctx.request.text();
  adapter.publish(`room:${ctx.params.id}`, `announcement: ${text}`);
  ctx.json({ ok: true }, 201);
});

const app = new Rhythm<RhythmHttpContext>({ name: "ws-example" }).use(apiRouter.middleware()).use(async (ctx) => {
  if (new URL(ctx.request.url).pathname === "/") {
    ctx.html(page);
    return;
  }
  ctx.error(404);
});

const port = 3000;
const server = createServer(getRequestListener(app));
attach(server, adapter);
server.listen(port, () => {
  console.log(`listening on http://localhost:${port} (open two tabs, or #room-name for other rooms)`);
});
