import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { RhythmWs, createWebsocket } from "@rhythmjs/ws";

// Everyone shares one topic; publishToSelf is off (below) so a client never receives its own movement back.
const ws = new RhythmWs().ws("/ws/cursors", {
  upgrade() {
    return { id: crypto.randomUUID().slice(0, 8), color: `hsl(${Math.floor(Math.random() * 360)} 80% 50%)` };
  },
  open(peer) {
    peer.subscribe("cursors");
    peer.send(JSON.stringify({ type: "hello", id: peer.data.id, color: peer.data.color }));
  },
  message(peer, message) {
    const { x, y } = JSON.parse(String(message)) as { x: number; y: number };
    peer.publish("cursors", JSON.stringify({ type: "move", id: peer.data.id, color: peer.data.color, x, y }));
  },
  close(peer) {
    peer.publish("cursors", JSON.stringify({ type: "leave", id: peer.data.id }));
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
  });

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3001),
  fetch: toFetchHandler(new Rhythm().use(mount(ws)).use(mount(http))),
  websocket: createWebsocket({ publishToSelf: false }),
});

console.log(`cursors listening on ${server.url} (open in several windows and move the mouse)`);
