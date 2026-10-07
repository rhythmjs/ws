import { addRoute, createRouter, findRoute, type InferRouteParams } from "rou3";
import { Pipeline, type ExtensionMiddleware, type Middleware, type PipelineOptions } from "@rhythmjs/rhythm";
import type { RhythmHttpContext } from "@rhythmjs/router/context";
import type { RouteContext, RouterContext, UseContext } from "@rhythmjs/router";

export type WsOrigin =
  "same-origin" | readonly string[] | ((origin: string, request: Request) => boolean | Promise<boolean>) | false;

export interface RhythmWsOptions extends PipelineOptions {
  origin?: WsOrigin;
}

export interface WsBehavior {
  maxPayloadLength?: number;
  idleTimeout?: number;
  backpressureLimit?: number;
  closeOnBackpressureLimit?: boolean;
  sendPings?: boolean;
  publishToSelf?: boolean;
  perMessageDeflate?: Bun.WebSocketHandler<never>["perMessageDeflate"];
}

export interface WsRoute<Ctx extends object, Data extends object> {
  upgrade?(ctx: Ctx): Data | void | Promise<Data | void>;
  headers?: Bun.HeadersInit | ((ctx: Ctx) => Bun.HeadersInit | Promise<Bun.HeadersInit>);
  open?(ws: Bun.ServerWebSocket<Data>): void | Promise<void>;
  message?(ws: Bun.ServerWebSocket<Data>, message: string | Buffer): void | Promise<void>;
  drain?(ws: Bun.ServerWebSocket<Data>): void | Promise<void>;
  close?(ws: Bun.ServerWebSocket<Data>, code: number, reason: string): void | Promise<void>;
  ping?(ws: Bun.ServerWebSocket<Data>, data: Buffer): void | Promise<void>;
  pong?(ws: Bun.ServerWebSocket<Data>, data: Buffer): void | Promise<void>;
}

type AnyWs = Bun.ServerWebSocket<object>;
type AnyHandlers = Omit<WsRoute<object, object>, "upgrade" | "headers">;
type Accept<T extends object> = (ctx: RouterContext<T>) => Promise<void>;

const connections = new WeakMap<object, AnyHandlers>();

function isUpgrade(request: Request): boolean {
  return request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function isWritten(response: RhythmHttpContext["response"]): boolean {
  return response.status !== 200 || response.body !== null;
}

async function allowsOrigin(option: WsOrigin, request: Request): Promise<boolean> {
  if (option === false) return true;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  if (typeof option === "function") return option(origin, request);
  if (option === "same-origin") {
    const host = request.headers.get("host") ?? new URL(request.url).host;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return option.includes(origin);
}

/**
 * The Bun `websocket` handler for `Bun.serve`. Every connection carries its own route handlers, so one handler
 * serves every `RhythmWs` in the app; pass it once next to `fetch`.
 */
export function createWebsocket(behavior: WsBehavior = {}): Bun.WebSocketHandler<never> {
  const handlersOf = (ws: AnyWs) => connections.get(ws.data);
  return {
    ...behavior,
    open: (ws: AnyWs) => handlersOf(ws)?.open?.(ws),
    message: (ws: AnyWs, message: string | Buffer) => handlersOf(ws)?.message?.(ws, message),
    drain: (ws: AnyWs) => handlersOf(ws)?.drain?.(ws),
    close: (ws: AnyWs, code: number, reason: string) => handlersOf(ws)?.close?.(ws, code, reason),
    ping: (ws: AnyWs, data: Buffer) => handlersOf(ws)?.ping?.(ws, data),
    pong: (ws: AnyWs, data: Buffer) => handlersOf(ws)?.pong?.(ws, data),
  } as unknown as Bun.WebSocketHandler<never>;
}

export const websocket = createWebsocket();

export class RhythmWs<I extends object = {}, D extends object = {}> extends Pipeline<UseContext<I & D>> {
  declare readonly "~input"?: I & RhythmHttpContext;

  #routes = createRouter<Accept<I & D>>();
  readonly #origin: WsOrigin;

  constructor({ origin = "same-origin", ...options }: RhythmWsOptions = {}) {
    super({ type: "ws", ...options });
    this.#origin = origin;
  }

  override use<U extends object>(middleware: ExtensionMiddleware<UseContext<I & D>, U>): RhythmWs<I, D & U>;
  override use(middleware: Middleware<UseContext<I & D>>): this;
  override use(middleware: Middleware<UseContext<I & D>>) {
    return super.use(middleware);
  }

  ws<P extends string, Data extends object = InferRouteParams<P>>(
    path: P,
    route: WsRoute<RouteContext<I & D, P>, Data>,
  ): this {
    if (!path.startsWith("/")) throw new TypeError(`ws path must start with "/", got "${path}"`);
    if (typeof route !== "object" || route === null) throw new TypeError("ws route must be a handlers object");
    addRoute(this.#routes, "GET", path, (ctx) => this.#accept(ctx, route as WsRoute<any, object>));
    return this;
  }

  override callback() {
    const run = this.chain();
    return async (input: RouterContext<I>) => {
      const ctx = input as RouterContext<I & D>;
      if (!isUpgrade(ctx.request)) return ctx;
      const found = findRoute(this.#routes, "GET", new URL(ctx.request.url).pathname);
      if (!found) return ctx;
      const params = decodeParams(found.params);
      if (!params) return ctx;
      Object.assign(ctx, { params });
      if (!(await allowsOrigin(this.#origin, ctx.request))) {
        ctx.error(403);
        return ctx;
      }
      await run(ctx as UseContext<I & D>, () => found.data(ctx));
      return ctx;
    };
  }

  async #accept(ctx: RouterContext<I & D>, route: WsRoute<any, object>): Promise<void> {
    const { server } = ctx;
    if (!server) {
      throw new Error(
        "ctx.server is undefined: call the fetch handler with Bun's server, as in fetch(request, server)",
      );
    }
    const params = (ctx as unknown as { params: Record<string, string> }).params;

    const data = (await route.upgrade?.(ctx as never)) ?? params;
    if (isWritten(ctx.response)) return;
    if (connections.has(data)) throw new TypeError("ws upgrade must return a new data object for every connection");
    const headers = typeof route.headers === "function" ? await route.headers(ctx as never) : route.headers;
    if (isWritten(ctx.response)) return;

    connections.set(data, route);
    if ((server as Bun.Server<object>).upgrade(ctx.request, { data, ...(headers === undefined ? {} : { headers }) })) {
      ctx.response.status = 101;
      return;
    }
    connections.delete(data);
    ctx.error(500, "Upgrade failed");
  }
}

function decodeParams(params: Record<string, string> | undefined): Record<string, string> | undefined {
  const decoded: Record<string, string> = {};
  try {
    for (const [key, value] of Object.entries(params ?? {})) decoded[key] = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return decoded;
}
