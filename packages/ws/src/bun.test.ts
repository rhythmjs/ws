import { describe, expect, test } from "bun:test";
import { Rhythm, derive, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { RhythmWs, websocket } from "./rhythm-ws";

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

function withApp(app: Parameters<typeof toFetchHandler>[0], run: (base: string) => Promise<void>): Promise<void> {
  const server = Bun.serve({ port: 0, fetch: toFetchHandler(app), websocket });
  return run(`localhost:${server.port}`).finally(() => server.stop(true));
}

describe("Bun.serve integration", () => {
  test("serves upgrades beside HTTP routes of the same app", async () => {
    const app = new Rhythm().use(mount(new RhythmRouter().get("/hello", (ctx) => ctx.text("http ok")))).use(
      mount(
        new RhythmWs()
          .ws("/echo", {
            message(peer, message) {
              peer.send(`echo:${String(message)}`);
            },
          })
          .ws("/rooms/:id", {
            open(peer) {
              peer.send(`room:${peer.data.id}`);
            },
          }),
      ),
    );

    await withApp(app, async (host) => {
      const echo = new WebSocket(`ws://${host}/echo`);
      await once(echo, "open");
      echo.send("hi");
      expect((await once<MessageEvent>(echo, "message")).data).toBe("echo:hi");
      echo.close();

      const room = new WebSocket(`ws://${host}/rooms/42`);
      expect((await once<MessageEvent>(room, "message")).data).toBe("room:42");
      room.close();

      expect(await (await fetch(`http://${host}/hello`)).text()).toBe("http ok");
      const missed = await fetch(`http://${host}/nope`, { headers: { upgrade: "websocket" } });
      expect(missed.status).toBe(404);
    });
  });

  test("a middleware rejection aborts the handshake over a real socket", async () => {
    const app = new Rhythm().use(
      mount(
        new RhythmWs()
          .use(async (ctx, next) => {
            if (new URL(ctx.request.url).searchParams.get("token") === "good") await next();
            else ctx.error(401);
          })
          .ws("/guarded", { open: (peer) => void peer.send("in") }),
      ),
    );

    await withApp(app, async (host) => {
      await once(new WebSocket(`ws://${host}/guarded`), "error");
      const allowed = new WebSocket(`ws://${host}/guarded?token=good`);
      expect((await once<MessageEvent>(allowed, "message")).data).toBe("in");
      allowed.close();
    });
  });

  test("the upgrade hook computes typed ws.data from derived context and can reject", async () => {
    const app = new Rhythm().use(
      mount(
        new RhythmWs()
          .use(derive((ctx) => ({ user: new URL(ctx.request.url).searchParams.get("user") })))
          .ws("/rooms/:id", {
            upgrade(ctx) {
              if (!ctx.user) return ctx.error(400, "Who are you?");
              return { user: ctx.user, room: ctx.params.id };
            },
            open(peer) {
              peer.send(`${peer.data.user}@${peer.data.room}`);
            },
          }),
      ),
    );

    await withApp(app, async (host) => {
      await once(new WebSocket(`ws://${host}/rooms/7`), "error");
      const named = new WebSocket(`ws://${host}/rooms/7?user=ada`);
      expect((await once<MessageEvent>(named, "message")).data).toBe("ada@7");
      named.close();
    });
  });

  test("subprotocol negotiation via route headers", async () => {
    const app = new Rhythm().use(
      mount(
        new RhythmWs().ws("/feed", {
          headers: (ctx) => ({
            "sec-websocket-protocol": ctx.request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim() ?? "",
          }),
        }),
      ),
    );

    await withApp(app, async (host) => {
      const socket = new WebSocket(`ws://${host}/feed`, ["json", "text"]);
      await once(socket, "open");
      expect(socket.protocol).toBe("json");
      socket.close();
    });
  });

  test("Bun pub/sub across peers of a room, and server.publish from HTTP", async () => {
    const app = new Rhythm()
      .use(
        mount(
          new RhythmRouter().post("/announce", (ctx) => {
            ctx.server?.publish("room:7", "from-http");
            ctx.text("sent");
          }),
        ),
      )
      .use(
        mount(
          new RhythmWs().ws("/rooms/:id", {
            open(peer) {
              peer.subscribe(`room:${peer.data.id}`);
              peer.send("joined");
            },
            message(peer, message) {
              peer.publish(`room:${peer.data.id}`, `peer:${String(message)}`);
            },
          }),
        ),
      );

    await withApp(app, async (host) => {
      const alice = new WebSocket(`ws://${host}/rooms/7`);
      const bob = new WebSocket(`ws://${host}/rooms/7`);
      expect((await once<MessageEvent>(alice, "message")).data).toBe("joined");
      expect((await once<MessageEvent>(bob, "message")).data).toBe("joined");

      alice.send("hello");
      expect((await once<MessageEvent>(bob, "message")).data).toBe("peer:hello");

      const pending = once<MessageEvent>(bob, "message");
      await fetch(`http://${host}/announce`, { method: "POST" });
      expect((await pending).data).toBe("from-http");
      alice.close();
      bob.close();
    });
  });

  test("two RhythmWs instances share one websocket handler on one server", async () => {
    const app = new Rhythm()
      .use(mount(new RhythmWs().ws("/support/:id", { open: (peer) => void peer.send(`support:${peer.data.id}`) })))
      .use(mount(new RhythmWs().ws("/sales/:id", { open: (peer) => void peer.send(`sales:${peer.data.id}`) })));

    await withApp(app, async (host) => {
      const a = new WebSocket(`ws://${host}/support/1`);
      expect((await once<MessageEvent>(a, "message")).data).toBe("support:1");
      const b = new WebSocket(`ws://${host}/sales/2`);
      expect((await once<MessageEvent>(b, "message")).data).toBe("sales:2");
      a.close();
      b.close();
    });
  });
});
