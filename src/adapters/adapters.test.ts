import { describe, expect, test } from "vite-plus/test";
import { createServer } from "node:http";
import { Rhythm } from "@rhythmjs/rhythm";
import { getRequestListener } from "@rhythmjs/router/adapters/node";
import type { RhythmHttpContext } from "@rhythmjs/router/context";
import { RhythmWs } from "../rhythm-ws";
import { attach, handle } from "./node";

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

describe("node adapter", () => {
  test("serves upgrades beside the HTTP app: echo, params, rejection, passthrough", async () => {
    const app = new Rhythm<RhythmHttpContext>().use((ctx) => ctx.text("http ok"));
    const ws = new RhythmWs({ prefix: "/ws" })
      .ws("/echo", {
        message(peer, message) {
          peer.send(`echo:${message.text()}`);
        },
      })
      .ws("/rooms/:id", (params) => ({
        open(peer) {
          peer.send(`room:${params.id}`);
        },
      }));

    const server = createServer(getRequestListener(app));
    attach(server, handle(ws));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const echo = new WebSocket(`ws://localhost:${port}/ws/echo`);
      await once(echo, "open");
      echo.send("hi");
      const reply = await once<MessageEvent>(echo, "message");
      expect(reply.data).toBe("echo:hi");
      echo.close();

      const room = new WebSocket(`ws://localhost:${port}/ws/rooms/42`);
      const greeting = await once<MessageEvent>(room, "message");
      expect(greeting.data).toBe("room:42");
      room.close();

      const rejected = new WebSocket(`ws://localhost:${port}/ws/nope`);
      await once(rejected, "error");

      const res = await fetch(`http://localhost:${port}/anything`);
      expect(await res.text()).toBe("http ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a guard rejection aborts the handshake over a real socket", async () => {
    const ws = new RhythmWs()
      .use((request, next) => {
        if (new URL(request.url).searchParams.get("token") !== "good") {
          return new Response("Unauthorized", { status: 401 });
        }
        return next();
      })
      .ws("/guarded", {
        open(peer) {
          peer.send("in");
        },
      });

    const server = createServer();
    attach(server, handle(ws));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const denied = new WebSocket(`ws://localhost:${port}/guarded`);
      await once(denied, "error");

      const allowed = new WebSocket(`ws://localhost:${port}/guarded?token=good`);
      const greeting = await once<MessageEvent>(allowed, "message");
      expect(greeting.data).toBe("in");
      allowed.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
