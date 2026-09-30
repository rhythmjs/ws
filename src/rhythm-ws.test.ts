import { describe, expect, test } from "vite-plus/test";
import { RhythmWs, type WsHooks, type WsMiddleware } from "./rhythm-ws";

const req = (path: string, headers?: Record<string, string>) => new Request(`http://localhost${path}`, { headers });

async function upgradeRejection(hooks: WsHooks): Promise<Response | undefined> {
  try {
    (hooks.upgrade as () => void)();
    return undefined;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

describe("RhythmWs routing", () => {
  test("resolves static hooks by path", async () => {
    const hooks: WsHooks = { message: () => {} };
    const ws = new RhythmWs().ws("/chat", hooks);
    expect(await ws.resolve(req("/chat"))).toBe(hooks);
  });

  test("a static segment wins over a param segment", async () => {
    const staticHooks: WsHooks = {};
    const paramHooks: WsHooks = {};
    const ws = new RhythmWs().ws("/rooms/:id", paramHooks).ws("/rooms/lobby", staticHooks);
    expect(await ws.resolve(req("/rooms/lobby"))).toBe(staticHooks);
    expect(await ws.resolve(req("/rooms/42"))).toBe(paramHooks);
  });

  test("a function handler receives the captured params", async () => {
    const seen: string[] = [];
    const ws = new RhythmWs().ws("/rooms/:id", (params) => {
      seen.push(params.id!);
      return {};
    });
    await ws.resolve(req("/rooms/42"));
    expect(seen).toEqual(["42"]);
  });

  test("a nested RhythmWs mounts via use(child.middleware()) and falls through on miss", async () => {
    const roomHooks: WsHooks = {};
    const child = new RhythmWs({ prefix: "/ws/rooms" }).ws("/:id", roomHooks);
    const liveHooks: WsHooks = {};
    const parent = new RhythmWs().use(child.middleware()).ws("/ws/live", liveHooks);

    expect(await parent.resolve(req("/ws/rooms/7"))).toBe(roomHooks);
    expect(await parent.resolve(req("/ws/live"))).toBe(liveHooks);
    expect(await child.resolve(req("/ws/rooms/7"))).toBe(roomHooks);
  });

  test("mounting compiles at that moment; later child endpoints don't appear in the parent", async () => {
    const child = new RhythmWs().ws("/early", {});
    const parent = new RhythmWs().use(child.middleware());
    child.ws("/late", {});

    expect((await parent.resolve(req("/early"))).upgrade).toBeUndefined();
    const rejection = await upgradeRejection(await parent.resolve(req("/late")));
    expect(rejection?.status).toBe(404);
    expect((await child.resolve(req("/late"))).upgrade).toBeUndefined();
  });

  test("an unmatched path resolves to hooks whose upgrade throws a 404 Response", async () => {
    const ws = new RhythmWs().ws("/chat", {});
    const rejection = await upgradeRejection(await ws.resolve(req("/nope")));
    expect(rejection?.status).toBe(404);
  });

  test("rejects a non-function, non-object handler", () => {
    expect(() => new RhythmWs().ws("/x", undefined as never)).toThrow(TypeError);
  });
});

describe("RhythmWs middleware", () => {
  const requireAuth: WsMiddleware = (request, next) => {
    if (request.headers.get("authorization") !== "secret") {
      return new Response("Unauthorized", { status: 401 });
    }
    return next();
  };

  test("middleware returning a Response rejects the upgrade with it", async () => {
    const hooks: WsHooks = {};
    const ws = new RhythmWs().use(requireAuth).ws("/chat", hooks);

    const rejection = await upgradeRejection(await ws.resolve(req("/chat")));
    expect(rejection?.status).toBe(401);

    expect(await ws.resolve(req("/chat", { authorization: "secret" }))).toBe(hooks);
  });

  test("middleware throwing a Response rejects the same way", async () => {
    const ws = new RhythmWs()
      .use(() => {
        throw new Response("nope", { status: 403 });
      })
      .ws("/chat", {});
    const rejection = await upgradeRejection(await ws.resolve(req("/chat")));
    expect(rejection?.status).toBe(403);
  });

  test("middleware only applies to endpoints registered after it", async () => {
    const openHooks: WsHooks = {};
    const ws = new RhythmWs().ws("/open", openHooks).use(requireAuth).ws("/private", {});

    expect(await ws.resolve(req("/open"))).toBe(openHooks);
    const rejection = await upgradeRejection(await ws.resolve(req("/private")));
    expect(rejection?.status).toBe(401);
  });

  test("middleware runs in registration order and short-circuits without calling next()", async () => {
    const order: string[] = [];
    const ws = new RhythmWs()
      .use((_request, _next) => {
        order.push("first");
        return new Response(null, { status: 401 });
      })
      .use((_request, next) => {
        order.push("second");
        return next();
      })
      .ws("/chat", {});
    await ws.resolve(req("/chat"));
    expect(order).toEqual(["first"]);
  });

  test("middleware can decorate the downstream hooks after next()", async () => {
    const seen: string[] = [];
    const ws = new RhythmWs()
      .use(async (_request, next) => {
        const hooks = await next();
        return {
          ...hooks,
          message(peer, message) {
            seen.push("logged");
            return hooks.message?.(peer, message);
          },
        };
      })
      .ws("/chat", {
        message() {
          seen.push("handled");
        },
      });

    const hooks = await ws.resolve(req("/chat"));
    void hooks.message?.({} as never, { text: () => "hi" } as never);
    expect(seen).toEqual(["logged", "handled"]);
  });

  test("parent middleware wraps a mounted child, and the child's own middleware is kept", async () => {
    const child = new RhythmWs().use(requireAuth).ws("/inner", {});
    const parent = new RhythmWs()
      .use((request, next) => {
        if (!request.headers.get("x-tenant")) return new Response(null, { status: 400 });
        return next();
      })
      .use(child.middleware());

    expect((await upgradeRejection(await parent.resolve(req("/inner"))))?.status).toBe(400);
    expect((await upgradeRejection(await parent.resolve(req("/inner", { "x-tenant": "a" }))))?.status).toBe(401);
    const ok = await parent.resolve(req("/inner", { "x-tenant": "a", authorization: "secret" }));
    expect(ok.upgrade).toBeUndefined();
  });

  test("calling next() twice rejects, and non-Response errors propagate", async () => {
    const doubleNext = new RhythmWs()
      .use(async (_request, next) => {
        await next();
        return next();
      })
      .ws("/chat", {});
    await expect(doubleNext.resolve(req("/chat"))).rejects.toThrow("next() called multiple times");

    const boom = new RhythmWs()
      .use(() => {
        throw new Error("boom");
      })
      .ws("/chat", {});
    await expect(boom.resolve(req("/chat"))).rejects.toThrow("boom");
  });

  test("middleware() compiles to a connection middleware that calls next() on miss", async () => {
    const hooks: WsHooks = {};
    const fallback: WsHooks = {};
    const ws = new RhythmWs().ws("/chat", hooks);
    const compiled = ws.middleware();

    expect(await compiled(req("/chat"), () => Promise.resolve(fallback))).toBe(hooks);
    expect(await compiled(req("/elsewhere"), () => Promise.resolve(fallback))).toBe(fallback);
  });
});
