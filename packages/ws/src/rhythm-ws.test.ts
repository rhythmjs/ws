import { describe, expect, test } from "bun:test";
import { Rhythm, derive, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { RhythmWs, createWebsocket } from "./rhythm-ws";

const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { headers: { upgrade: "websocket", ...headers } });

interface Upgraded {
  data: unknown;
  headers: Bun.HeadersInit | undefined;
}

function mockServer(accept = true) {
  const upgrades: Upgraded[] = [];
  const server = {
    upgrade(_request: Request, options?: { data?: unknown; headers?: Bun.HeadersInit }) {
      if (!accept) return false;
      upgrades.push({ data: options?.data, headers: options?.headers });
      return true;
    },
  } as unknown as Bun.Server<unknown>;
  return { server, upgrades };
}

const serve = (ws: RhythmWs<any, any>) => toFetchHandler(new Rhythm().use(mount(ws)));

describe("RhythmWs routing", () => {
  test("a non-websocket request passes through to the rest of the app", async () => {
    const { server, upgrades } = mockServer();
    const app = toFetchHandler(
      new Rhythm()
        .use(mount(new RhythmWs().ws("/chat", {})))
        .use(mount(new RhythmRouter().get("/chat", (ctx) => ctx.text("http")))),
    );

    expect(await (await app(new Request("http://localhost/chat"), server)).text()).toBe("http");
    expect(upgrades).toEqual([]);
  });

  test("an unmatched path passes through so the HTTP app can answer", async () => {
    const { server, upgrades } = mockServer();
    const response = await serve(new RhythmWs().ws("/chat", {}))(req("/nope"), server);

    expect(response.status).toBe(404);
    expect(upgrades).toEqual([]);
  });

  test("a matched route calls server.upgrade with the params as default ws.data", async () => {
    const { server, upgrades } = mockServer();
    const response = await serve(new RhythmWs().ws("/rooms/:id", {}))(req("/rooms/42"), server);

    expect(response.status).toBe(101);
    expect(upgrades[0]!.data).toEqual({ id: "42" });
  });

  test("a static segment wins over a param segment", async () => {
    const { server, upgrades } = mockServer();
    const app = serve(
      new RhythmWs()
        .ws("/rooms/:id", { upgrade: () => ({ kind: "param" }) })
        .ws("/rooms/lobby", { upgrade: () => ({ kind: "static" }) }),
    );

    await app(req("/rooms/lobby"), server);
    await app(req("/rooms/42"), server);
    expect(upgrades.map((u) => (u.data as { kind: string }).kind)).toEqual(["static", "param"]);
  });

  test("only GET upgrade requests match", async () => {
    const { server, upgrades } = mockServer();
    const post = new Request("http://localhost/chat", { method: "POST", headers: { upgrade: "websocket" } });

    expect((await serve(new RhythmWs().ws("/chat", {}))(post, server)).status).toBe(404);
    expect(upgrades).toEqual([]);
  });

  test("a path without a leading slash is rejected", () => {
    expect(() => new RhythmWs().ws("chat", {})).toThrow(TypeError);
  });
});

describe("RhythmWs upgrade hook", () => {
  test("the data the hook returns becomes ws.data, with params and derived context available", async () => {
    const { server, upgrades } = mockServer();
    const app = serve(
      new RhythmWs().use(derive(() => ({ user: "ada" }))).ws("/rooms/:id", {
        upgrade: (ctx) => ({ user: ctx.user, room: ctx.params.id }),
        open(peer) {
          const label: string = `${peer.data.user}@${peer.data.room}`;
          void label;
        },
      }),
    );

    await app(req("/rooms/7"), server);
    expect(upgrades[0]!.data).toEqual({ user: "ada", room: "7" });
  });

  test("writing the response in the hook aborts the handshake", async () => {
    const { server, upgrades } = mockServer();
    const app = serve(
      new RhythmWs().ws("/rooms/:id", {
        upgrade: (ctx) => {
          if (!new URL(ctx.request.url).searchParams.get("user")) return ctx.error(400, "Who are you?");
          return { user: "ada" };
        },
      }),
    );

    const denied = await app(req("/rooms/7"), server);
    expect(denied.status).toBe(400);
    expect(await denied.text()).toBe("Who are you?");
    expect(upgrades).toEqual([]);

    expect((await app(req("/rooms/7?user=ada"), server)).status).toBe(101);
  });

  test("headers are passed to server.upgrade, static or computed from the context", async () => {
    const { server, upgrades } = mockServer();
    const app = serve(
      new RhythmWs()
        .ws("/a", { headers: { "x-a": "1" } })
        .ws("/b", { headers: (ctx) => ({ "x-path": new URL(ctx.request.url).pathname }) }),
    );

    await app(req("/a"), server);
    await app(req("/b"), server);
    expect(upgrades.map((u) => u.headers)).toEqual([{ "x-a": "1" }, { "x-path": "/b" }]);
  });

  test("a hook that returns the same object twice is rejected", async () => {
    const shared = { id: 1 };
    const { server } = mockServer();
    const app = serve(new RhythmWs().ws("/shared", { upgrade: () => shared }));

    await app(req("/shared"), server);
    await expect(app(req("/shared"), server)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("new data object") },
    });
  });

  test("a failed server.upgrade answers 500", async () => {
    const response = await serve(new RhythmWs().ws("/chat", {}))(req("/chat"), mockServer(false).server);

    expect(response.status).toBe(500);
  });

  test("a missing server is a clear error", async () => {
    await expect(serve(new RhythmWs().ws("/chat", {}))(req("/chat"))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("ctx.server is undefined") },
    });
  });
});

describe("RhythmWs middleware", () => {
  test("use() runs only for matching upgrade requests and can reject them", async () => {
    const { server, upgrades } = mockServer();
    let runs = 0;
    const app = serve(
      new RhythmWs()
        .use(async (ctx, next) => {
          runs++;
          if (new URL(ctx.request.url).searchParams.get("token") === "good") await next();
          else ctx.error(401);
        })
        .ws("/guarded", {}),
    );

    await app(new Request("http://localhost/guarded"), server);
    await app(req("/elsewhere"), server);
    expect(runs).toBe(0);

    expect((await app(req("/guarded"), server)).status).toBe(401);
    expect((await app(req("/guarded?token=good"), server)).status).toBe(101);
    expect(upgrades).toHaveLength(1);
  });

  test("is mounted like any module, beside routers, in an app that already has dependencies", async () => {
    const { server, upgrades } = mockServer();
    const app = toFetchHandler(
      new Rhythm()
        .use(derive(() => ({ tenant: "acme" })))
        .use(mount(new RhythmRouter().get("/health", (ctx) => ctx.text("ok"))))
        .use(mount(new RhythmWs().ws("/live", { upgrade: (ctx) => ({ path: new URL(ctx.request.url).pathname }) }))),
    );

    expect(await (await app(new Request("http://localhost/health"), server)).text()).toBe("ok");
    expect((await app(req("/live"), server)).status).toBe(101);
    expect(upgrades[0]!.data).toEqual({ path: "/live" });
  });
});

describe("RhythmWs origin", () => {
  const run = async (origin: ConstructorParameters<typeof RhythmWs>[0], headers: Record<string, string>) => {
    const { server } = mockServer();
    return (await serve(new RhythmWs(origin).ws("/chat", {}))(req("/chat", headers), server)).status;
  };

  test("same-origin is the default: a cross-site browser origin is refused", async () => {
    expect(await run({}, { origin: "http://evil.example", host: "localhost" })).toBe(403);
    expect(await run({}, { origin: "http://localhost", host: "localhost" })).toBe(101);
    expect(await run({}, {})).toBe(101);
  });

  test("an allow-list, a function, and false", async () => {
    expect(await run({ origin: ["http://app.example"] }, { origin: "http://app.example" })).toBe(101);
    expect(await run({ origin: ["http://app.example"] }, { origin: "http://evil.example" })).toBe(403);
    expect(await run({ origin: async (origin) => origin.endsWith(".example") }, { origin: "http://x.example" })).toBe(
      101,
    );
    expect(await run({ origin: false }, { origin: "http://evil.example" })).toBe(101);
  });
});

describe("createWebsocket", () => {
  test("dispatches each connection to the handlers of the route that accepted it", async () => {
    const seen: string[] = [];
    const { server, upgrades } = mockServer();
    const app = serve(
      new RhythmWs()
        .ws("/a", { upgrade: () => ({ n: "a" }), open: (peer) => void seen.push(`open:${peer.data.n}`) })
        .ws("/b", {
          upgrade: () => ({ n: "b" }),
          message: (peer, message) => void seen.push(`${peer.data.n}:${message}`),
        }),
    );
    await app(req("/a"), server);
    await app(req("/b"), server);

    const handler = createWebsocket() as unknown as Record<string, (ws: unknown, ...args: unknown[]) => void>;
    handler.open!({ data: upgrades[0]!.data });
    handler.message!({ data: upgrades[1]!.data }, "hi");
    handler.open!({ data: { unknown: true } });
    expect(seen).toEqual(["open:a", "b:hi"]);
  });

  test("Bun's behavior options pass through", () => {
    expect(createWebsocket({ maxPayloadLength: 1024, idleTimeout: 30 })).toMatchObject({
      maxPayloadLength: 1024,
      idleTimeout: 30,
    });
  });
});

test("ws.data is typed from the upgrade hook, and from the path params without one", () => {
  new RhythmWs().ws("/rooms/:id", {
    upgrade: () => ({ user: "ada" }),
    open(peer) {
      const user: string = peer.data.user;
      // @ts-expect-error not in the data the hook returns
      void peer.data.id;
      void user;
    },
  });
  new RhythmWs().ws("/rooms/:id", {
    open(peer) {
      const id: string = peer.data.id;
      void id;
    },
  });
});
