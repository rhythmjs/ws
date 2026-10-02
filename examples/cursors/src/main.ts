import { RhythmWs } from "@rhythmjs/ws";

interface Peer {
  id: string;
  color: string;
}

// Everyone shares one topic; publishToSelf is off so a client never receives its own movement back.
const ws = new RhythmWs({ prefix: "/ws", publishToSelf: false }).route<Peer>("/cursors", {
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

const files: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3001),
  fetch(request, srv) {
    const upgrade = ws.upgrade(request, srv);
    if (upgrade !== null) return upgrade;

    const file = files[new URL(request.url).pathname];
    return file
      ? new Response(Bun.file(new URL(`../public/${file}`, import.meta.url)))
      : new Response("Not Found", { status: 404 });
  },
  websocket: ws.websocket,
});

console.log(`cursors listening on ${server.url} (open in several windows and move the mouse)`);
