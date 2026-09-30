import { describe, expect, test } from "bun:test";
import { RhythmWs } from "./rhythm-ws";

function once<T>(target: WebSocket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    target.addEventListener(
      event,
      (e) => {
        clearTimeout(timer);
        resolve(e as T);
      },
      { once: true },
    );
  });
}

function withServer(ws: RhythmWs, run: (base: string) => Promise<void>): Promise<void> {
  const server = Bun.serve({
    port: 0,
    fetch: (request, srv) => ws.upgrade(request, srv) ?? new Response("http ok"),
    websocket: ws.websocket,
  });
  return run(`ws://localhost:${server.port}`).finally(() => server.stop(true));
}

describe("Bun.serve integration", () => {
  test("serves upgrades beside HTTP: echo, params as data, fall-through", async () => {
    const ws = new RhythmWs({ prefix: "/ws" })
      .route("/echo", {
        message(peer, message) {
          peer.send(`echo:${String(message)}`);
        },
      })
      .route("/rooms/:id", {
        open(peer) {
          peer.send(`room:${peer.data.id}`);
        },
      });

    await withServer(ws, async (base) => {
      const echo = new WebSocket(`${base}/ws/echo`);
      await once(echo, "open");
      echo.send("hi");
      expect((await once<MessageEvent>(echo, "message")).data).toBe("echo:hi");
      echo.close();

      const room = new WebSocket(`${base}/ws/rooms/42`);
      expect((await once<MessageEvent>(room, "message")).data).toBe("room:42");
      room.close();

      const res = await fetch(`${base.replace("ws", "http")}/anything`);
      expect(await res.text()).toBe("http ok");
      const missed = await fetch(`${base.replace("ws", "http")}/ws/nope`, { headers: { upgrade: "websocket" } });
      expect(await missed.text()).toBe("http ok");
    });
  });

  test("a guard rejection aborts the handshake over a real socket", async () => {
    const ws = new RhythmWs()
      .guard((request) =>
        new URL(request.url).searchParams.get("token") === "good"
          ? undefined
          : new Response("Unauthorized", { status: 401 }),
      )
      .route("/guarded", {
        open(peer) {
          peer.send("in");
        },
      });

    await withServer(ws, async (base) => {
      const denied = new WebSocket(`${base}/guarded`);
      await once(denied, "error");

      const allowed = new WebSocket(`${base}/guarded?token=good`);
      expect((await once<MessageEvent>(allowed, "message")).data).toBe("in");
      allowed.close();
    });
  });

  test("route upgrade computes typed ws.data and can reject", async () => {
    const ws = new RhythmWs().route<{ user: string; room: string }>("/rooms/:id", {
      upgrade(request, params) {
        const user = new URL(request.url).searchParams.get("user");
        if (!user) return new Response("Who are you?", { status: 400 });
        return { user, room: params.id! };
      },
      open(peer) {
        peer.send(`${peer.data.user}@${peer.data.room}`);
      },
    });

    await withServer(ws, async (base) => {
      const anonymous = new WebSocket(`${base}/rooms/7`);
      await once(anonymous, "error");

      const named = new WebSocket(`${base}/rooms/7?user=ada`);
      expect((await once<MessageEvent>(named, "message")).data).toBe("ada@7");
      named.close();
    });
  });

  test("subprotocol negotiation via route headers", async () => {
    const ws = new RhythmWs().route("/feed", {
      headers: (request) => ({
        "sec-websocket-protocol": request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim() ?? "",
      }),
      open(peer) {
        peer.send("ready");
      },
    });

    await withServer(ws, async (base) => {
      const socket = new WebSocket(`${base}/feed`, ["json", "text"]);
      await once(socket, "open");
      expect(socket.protocol).toBe("json");
      socket.close();
    });
  });

  test("Bun pub/sub across peers of a room", async () => {
    const ws = new RhythmWs().route("/rooms/:id", {
      open(peer) {
        peer.subscribe(`room:${peer.data.id}`);
        peer.send("joined");
      },
      message(peer, message) {
        peer.publish(`room:${peer.data.id}`, `peer:${String(message)}`);
      },
    });

    await withServer(ws, async (base) => {
      const alice = new WebSocket(`${base}/rooms/7`);
      const bob = new WebSocket(`${base}/rooms/7`);
      expect((await once<MessageEvent>(alice, "message")).data).toBe("joined");
      expect((await once<MessageEvent>(bob, "message")).data).toBe("joined");

      alice.send("hello");
      expect((await once<MessageEvent>(bob, "message")).data).toBe("peer:hello");
      alice.close();
      bob.close();
    });
  });

  test("two instances share one websocket behavior on one server", async () => {
    const support = new RhythmWs({ prefix: "/support" }).route("/:id", {
      open: (peer) => void peer.send(`support:${peer.data.id}`),
    });
    const sales = new RhythmWs({ prefix: "/sales" }).route("/:id", {
      open: (peer) => void peer.send(`sales:${peer.data.id}`),
    });

    const server = Bun.serve({
      port: 0,
      fetch: (request, srv) => support.upgrade(request, srv) ?? sales.upgrade(request, srv) ?? new Response("http ok"),
      websocket: support.websocket,
    });
    try {
      const base = `ws://localhost:${server.port}`;
      const a = new WebSocket(`${base}/support/1`);
      expect((await once<MessageEvent>(a, "message")).data).toBe("support:1");
      const b = new WebSocket(`${base}/sales/2`);
      expect((await once<MessageEvent>(b, "message")).data).toBe("sales:2");
      a.close();
      b.close();
    } finally {
      server.stop(true);
    }
  });
});
