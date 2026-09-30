import { RhythmWs } from "../src/rhythm-ws.ts";

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
  socket.addEventListener("close", () => log("(disconnected, bad token?)"));
  document.getElementById("msg").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value) {
      socket.send(e.target.value);
      e.target.value = "";
    }
  });
</script>`;

interface Chat {
  handle: string;
  room: string;
  topic: string;
}

const ws = new RhythmWs({ prefix: "/ws", idleTimeout: 120 })
  .guard((request) =>
    new URL(request.url).searchParams.get("token") === "demo"
      ? undefined
      : new Response("Unauthorized", { status: 401 }),
  )
  .route<Chat>("/rooms/:id", {
    upgrade(_request, params) {
      const room = params.id!;
      return { handle: Math.random().toString(36).slice(2, 8), room, topic: `room:${room}` };
    },
    open(peer) {
      peer.subscribe(peer.data.topic);
      peer.send(`joined ${peer.data.room}`);
      peer.publish(peer.data.topic, `${peer.data.handle} joined ${peer.data.room}`);
    },
    message(peer, message) {
      const line = `${peer.data.handle}: ${String(message)}`;
      peer.send(line);
      peer.publish(peer.data.topic, line);
    },
    close(peer) {
      peer.publish(peer.data.topic, `${peer.data.handle} left ${peer.data.room}`);
    },
  });

const server = Bun.serve({
  port: 3000,
  fetch(request, srv) {
    const upgrade = ws.upgrade(request, srv);
    if (upgrade !== null) return upgrade;

    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname.startsWith("/api/rooms/") && pathname.endsWith("/announce")) {
      const id = pathname.slice("/api/rooms/".length, -"/announce".length);
      return request.text().then((text) => {
        srv.publish(`room:${id}`, `announcement: ${text}`);
        return Response.json({ ok: true }, { status: 201 });
      });
    }
    if (pathname === "/") {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
  websocket: ws.websocket,
});

console.log(`listening on ${server.url} (open two tabs, or #room-name for other rooms)`);
