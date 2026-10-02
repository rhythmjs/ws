import { describe, expect, test } from "bun:test";
import { RhythmWs, type Server, type WsMiddleware, type WsParams } from "./rhythm-ws";

const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { headers: { upgrade: "websocket", ...headers } });

interface Upgraded {
  data: unknown;
  headers: Bun.HeadersInit | undefined;
}

function mockServer(accept = true): { server: Server; upgrades: Upgraded[] } {
  const upgrades: Upgraded[] = [];
  const server = {
    upgrade(_request: Request, options?: { data?: unknown; headers?: Bun.HeadersInit }) {
      if (!accept) return false;
      upgrades.push({ data: options?.data, headers: options?.headers });
      return true;
    },
  } as unknown as Server;
  return { server, upgrades };
}

describe("RhythmWs.upgrade routing", () => {
  test("a non-websocket request returns null synchronously", () => {
    const ws = new RhythmWs().route("/chat", {});
    expect(ws.upgrade(new Request("http://localhost/chat"), mockServer().server)).toBeNull();
  });

  test("an unmatched path returns null so the HTTP app can answer", () => {
    const ws = new RhythmWs().route("/chat", {});
    expect(ws.upgrade(req("/nope"), mockServer().server)).toBeNull();
  });

  test("a matched route upgrades with the params as default ws.data", async () => {
    const ws = new RhythmWs().route("/rooms/:id", {});
    const { server, upgrades } = mockServer();

    expect(await ws.upgrade(req("/rooms/42"), server)).toBeUndefined();
    expect(upgrades[0]!.data).toEqual({ id: "42" });
  });

  test("a static segment wins over a param segment", async () => {
    const ws = new RhythmWs()
      .route("/rooms/:id", { upgrade: () => ({ kind: "param" }) })
      .route("/rooms/lobby", { upgrade: () => ({ kind: "static" }) });
    const { server, upgrades } = mockServer();

    await ws.upgrade(req("/rooms/lobby"), server);
    await ws.upgrade(req("/rooms/42"), server);
    expect(upgrades.map((u) => (u.data as { kind: string }).kind)).toEqual(["static", "param"]);
  });

  test("the prefix applies to every route", async () => {
    const ws = new RhythmWs({ prefix: "/ws" }).route("/chat", {});
    const { server } = mockServer();

    expect(ws.upgrade(req("/chat"), server)).toBeNull();
    expect(await ws.upgrade(req("/ws/chat"), server)).toBeUndefined();
  });

  test("route() rejects a non-object handlers argument", () => {
    expect(() => new RhythmWs().route("/x", null as never)).toThrow(TypeError);
  });
});

describe("route upgrade and headers", () => {
  test("upgrade computes ws.data from the request and params", async () => {
    const ws = new RhythmWs().route<{ room: string; token: string }>("/rooms/:id", {
      upgrade(request, params) {
        return { room: params.id!, token: new URL(request.url).searchParams.get("token") ?? "" };
      },
    });
    const { server, upgrades } = mockServer();

    await ws.upgrade(req("/rooms/7?token=t1"), server);
    expect(upgrades[0]!.data).toEqual({ room: "7", token: "t1" });
  });

  test("upgrade returning a Response rejects the handshake", async () => {
    const ws = new RhythmWs().route("/vip", {
      upgrade: (request) =>
        request.headers.get("x-vip") === "yes" ? { ok: true } : new Response("Forbidden", { status: 403 }),
    });
    const { server, upgrades } = mockServer();

    const rejected = await ws.upgrade(req("/vip"), server);
    expect(rejected?.status).toBe(403);
    expect(upgrades).toHaveLength(0);

    expect(await ws.upgrade(req("/vip", { "x-vip": "yes" }), server)).toBeUndefined();
  });

  test("headers reach server.upgrade, statically or computed", async () => {
    const ws = new RhythmWs()
      .route("/static", { headers: { "x-static": "yes" } })
      .route("/computed/:id", { headers: (_request, params) => ({ "x-room": params.id! }) });
    const { server, upgrades } = mockServer();

    await ws.upgrade(req("/static"), server);
    await ws.upgrade(req("/computed/9"), server);
    expect(upgrades[0]!.headers).toEqual({ "x-static": "yes" });
    expect(upgrades[1]!.headers).toEqual({ "x-room": "9" });
  });

  test("a refused server.upgrade answers 500, like Bun's own convention", async () => {
    const ws = new RhythmWs().route("/chat", {});
    const { server } = mockServer(false);

    const failed = await ws.upgrade(req("/chat"), server);
    expect(failed?.status).toBe(500);
  });
});

describe("middleware and mounting", () => {
  const requireAuth: WsMiddleware = async (ctx, next) => {
    if (ctx.request.headers.get("authorization") === "secret") await next();
    else ctx.response = new Response("Unauthorized", { status: 401 });
  };

  test("middleware runs in order and a set response short-circuits the upgrade", async () => {
    const order: string[] = [];
    const ws = new RhythmWs()
      .use((ctx) => {
        order.push("first");
        ctx.response = new Response(null, { status: 401 });
      })
      .use(async (_ctx, next) => {
        order.push("second");
        await next();
      })
      .route("/chat", {});
    const { server, upgrades } = mockServer();

    expect((await ws.upgrade(req("/chat"), server))?.status).toBe(401);
    expect(order).toEqual(["first"]);
    expect(upgrades).toHaveLength(0);
  });

  test("middleware that returns without next() fails closed", async () => {
    const ws = new RhythmWs()
      .use(() => {
        // a forgotten next(): the handshake must not proceed
      })
      .route("/chat", {});
    const { server, upgrades } = mockServer();

    expect((await ws.upgrade(req("/chat"), server))?.status).toBe(403);
    expect(upgrades).toHaveLength(0);
  });

  test("middleware setting a response and still calling next() cannot upgrade", async () => {
    const ws = new RhythmWs()
      .use(async (ctx, next) => {
        ctx.response = new Response(null, { status: 401 });
        await next();
      })
      .route("/chat", {});
    const { server, upgrades } = mockServer();

    expect((await ws.upgrade(req("/chat"), server))?.status).toBe(401);
    expect(upgrades).toHaveLength(0);
  });

  test("middleware does not run for unmatched paths", async () => {
    let ran = 0;
    const ws = new RhythmWs()
      .use(async (_ctx, next) => {
        ran++;
        await next();
      })
      .route("/chat", {});
    const { server } = mockServer();

    expect(ws.upgrade(req("/nope"), server)).toBeNull();
    expect(ran).toBe(0);
    await ws.upgrade(req("/chat"), server);
    expect(ran).toBe(1);
  });

  test("use(child.middleware()) mounts the child's routes and scopes its own middleware around them", async () => {
    const child = new RhythmWs({ prefix: "/ws/rooms" }).use(requireAuth).route("/:id", {});
    const parent = new RhythmWs({ prefix: "/ws" })
      .use(async (ctx, next) => {
        if (ctx.request.headers.get("x-tenant")) await next();
        else ctx.response = new Response(null, { status: 400 });
      })
      .use(child.middleware())
      .route("/live", {});
    const { server, upgrades } = mockServer();

    expect((await parent.upgrade(req("/ws/rooms/7"), server))?.status).toBe(400);
    expect((await parent.upgrade(req("/ws/rooms/7", { "x-tenant": "a" }), server))?.status).toBe(401);
    expect(
      await parent.upgrade(req("/ws/rooms/7", { "x-tenant": "a", authorization: "secret" }), server),
    ).toBeUndefined();
    expect(upgrades[0]!.data).toEqual({ id: "7" });
  });

  test("a mounted child's middleware does not run for a sibling child's routes", async () => {
    const seen: string[] = [];
    const rooms = new RhythmWs({ prefix: "/ws/rooms" })
      .use(async (ctx, next) => {
        seen.push("rooms-guard");
        ctx.response = new Response(null, { status: 401 });
        await next();
      })
      .route("/:id", {});
    const feed = new RhythmWs({ prefix: "/ws/feed" }).route("/", {});
    const parent = new RhythmWs().use(rooms.middleware()).use(feed.middleware());
    const { server } = mockServer();

    expect(await parent.upgrade(req("/ws/feed"), server)).toBeUndefined();
    expect(seen).toEqual([]);
    expect((await parent.upgrade(req("/ws/rooms/7"), server))?.status).toBe(401);
    expect(seen).toEqual(["rooms-guard"]);
  });

  test("parent middleware before mounted-only children runs for each child's routes", async () => {
    const seen: string[] = [];
    const guard: WsMiddleware = async (_ctx, next) => {
      seen.push("parent-guard");
      await next();
    };
    const parent = new RhythmWs()
      .use(guard)
      .use(new RhythmWs({ prefix: "/a" }).route("/x", {}).middleware())
      .use(new RhythmWs({ prefix: "/b" }).route("/y", {}).middleware());
    const { server } = mockServer();

    expect(await parent.upgrade(req("/a/x"), server)).toBeUndefined();
    expect(await parent.upgrade(req("/b/y"), server)).toBeUndefined();
    expect(seen).toEqual(["parent-guard", "parent-guard"]);
  });

  test("a middleware only runs for routes registered after it", async () => {
    const seen: string[] = [];
    const tag =
      (name: string): WsMiddleware =>
      async (_ctx, next) => {
        seen.push(name);
        await next();
      };
    const ws = new RhythmWs().route("/early", {}).use(tag("late-mw")).route("/late", {});
    const { server } = mockServer();

    await ws.upgrade(req("/early"), server);
    expect(seen).toEqual([]);
    await ws.upgrade(req("/late"), server);
    expect(seen).toEqual(["late-mw"]);
  });

  test("a parent route registered after a mounted child still upgrades", async () => {
    const child = new RhythmWs({ prefix: "/ws/rooms" }).route("/:id", {});
    const parent = new RhythmWs({ prefix: "/ws" }).use(child.middleware()).route("/live", {});
    const { server } = mockServer();

    expect(await parent.upgrade(req("/ws/live"), server)).toBeUndefined();
    expect(await parent.upgrade(req("/ws/rooms/7"), server)).toBeUndefined();
  });

  test("middleware() snapshots the child: routes added later stay out of the parent", async () => {
    const child = new RhythmWs().route("/early", {});
    const parent = new RhythmWs().use(child.middleware());
    child.route("/late", {});
    const { server } = mockServer();

    expect(await parent.upgrade(req("/early"), server)).toBeUndefined();
    expect(parent.upgrade(req("/late"), server)).toBeNull();
  });

  test("routes lists own and mounted paths", () => {
    const child = new RhythmWs({ prefix: "/ws/rooms" }).route("/:id", {});
    const ws = new RhythmWs({ prefix: "/ws" }).use(child.middleware()).route("/live", {});
    expect(ws.routes).toEqual(["/ws/rooms/:id", "/ws/live"]);
  });

  test("use() rejects a non-function argument", () => {
    expect(() => new RhythmWs().use(null as never)).toThrow(TypeError);
  });
});

describe("origin validation", () => {
  test("rejects a cross-origin upgrade by default with 403", async () => {
    const ws = new RhythmWs().route("/chat", {});
    const { server, upgrades } = mockServer();

    const rejected = await ws.upgrade(req("/chat", { origin: "http://evil.example" }), server);
    expect(rejected?.status).toBe(403);
    expect(upgrades).toHaveLength(0);
  });

  test("accepts a same-origin upgrade by default", async () => {
    const ws = new RhythmWs().route("/chat", {});
    const { server } = mockServer();

    expect(await ws.upgrade(req("/chat", { origin: "http://localhost", host: "localhost" }), server)).toBeUndefined();
  });

  test("accepts requests without an origin header (non-browser clients)", async () => {
    const ws = new RhythmWs().route("/chat", {});
    const { server } = mockServer();

    expect(await ws.upgrade(req("/chat"), server)).toBeUndefined();
  });

  test("rejects the literal null origin by default", async () => {
    const ws = new RhythmWs().route("/chat", {});
    const { server } = mockServer();

    expect((await ws.upgrade(req("/chat", { origin: "null" }), server))?.status).toBe(403);
  });

  test("an allowlist matches full origins exactly", async () => {
    const ws = new RhythmWs({ origin: ["https://app.example"] }).route("/chat", {});
    const { server } = mockServer();

    expect(await ws.upgrade(req("/chat", { origin: "https://app.example" }), server)).toBeUndefined();
    expect((await ws.upgrade(req("/chat", { origin: "https://app.example.evil" }), server))?.status).toBe(403);
    expect((await ws.upgrade(req("/chat", { origin: "http://app.example" }), server))?.status).toBe(403);
  });

  test("a predicate decides per request", async () => {
    const ws = new RhythmWs({ origin: (origin) => origin.endsWith(".trusted.example") }).route("/chat", {});
    const { server } = mockServer();

    expect(await ws.upgrade(req("/chat", { origin: "https://a.trusted.example" }), server)).toBeUndefined();
    expect((await ws.upgrade(req("/chat", { origin: "https://evil.example" }), server))?.status).toBe(403);
  });

  test("origin: false disables the check", async () => {
    const ws = new RhythmWs({ origin: false }).route("/chat", {});
    const { server } = mockServer();

    expect(await ws.upgrade(req("/chat", { origin: "http://evil.example" }), server)).toBeUndefined();
  });

  test("the origin check runs before middleware", async () => {
    let ran = 0;
    const ws = new RhythmWs()
      .use(async (_ctx, next) => {
        ran++;
        await next();
      })
      .route("/chat", {});
    const { server } = mockServer();

    await ws.upgrade(req("/chat", { origin: "http://evil.example" }), server);
    expect(ran).toBe(0);
  });

  test("origin stays out of the websocket behavior", () => {
    const ws = new RhythmWs({ origin: false });
    expect("origin" in ws.websocket).toBe(false);
  });
});

describe("websocket dispatch", () => {
  test("dispatches every lifecycle event to the connection's route via ws.data", async () => {
    const seen: string[] = [];
    const ws = new RhythmWs().route("/chat/:id", {
      open: (peer) => void seen.push(`open:${(peer.data as WsParams).id}`),
      message: (_peer, message) => void seen.push(`message:${String(message)}`),
      drain: () => void seen.push("drain"),
      close: (_peer, code, reason) => void seen.push(`close:${code}:${reason}`),
    });
    const { server, upgrades } = mockServer();
    await ws.upgrade(req("/chat/9"), server);

    const behavior = ws.websocket as unknown as Bun.WebSocketHandler<object>;
    const peer = { data: upgrades[0]!.data } as Bun.ServerWebSocket<object>;
    await behavior.open?.(peer);
    await behavior.message(peer, "hi");
    await behavior.drain?.(peer);
    await behavior.close?.(peer, 1000, "done");
    expect(seen).toEqual(["open:9", "message:hi", "drain", "close:1000:done"]);
  });

  test("one websocket behavior dispatches for connections upgraded by other instances", async () => {
    const seen: string[] = [];
    const support = new RhythmWs({ prefix: "/support" }).route("/:id", {
      open: () => void seen.push("support"),
    });
    const sales = new RhythmWs({ prefix: "/sales" }).route("/:id", {
      open: () => void seen.push("sales"),
    });
    const { server, upgrades } = mockServer();
    await support.upgrade(req("/support/1"), server);
    await sales.upgrade(req("/sales/1"), server);

    const behavior = support.websocket as unknown as Bun.WebSocketHandler<object>;
    for (const upgraded of upgrades) await behavior.open?.({ data: upgraded.data } as Bun.ServerWebSocket<object>);
    expect(seen).toEqual(["support", "sales"]);
  });

  test("carries the instance's behavior tuning", () => {
    const ws = new RhythmWs({ prefix: "/ws", idleTimeout: 60, maxPayloadLength: 1024, publishToSelf: true });
    const behavior = ws.websocket;
    expect(behavior.idleTimeout).toBe(60);
    expect(behavior.maxPayloadLength).toBe(1024);
    expect(behavior.publishToSelf).toBe(true);
    expect("prefix" in behavior).toBe(false);
  });
});
