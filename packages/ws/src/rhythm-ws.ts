import { compose } from "@rhythmjs/rhythm/compose";
import type { Middleware, NextFn } from "@rhythmjs/rhythm/types";
import { addRoute, createRouter, findRoute, type RouterContext } from "rou3";

export type WsParams = Readonly<Record<string, string>>;
export type Server = Bun.Server<unknown>;

export interface RhythmWsContext {
  readonly request: Request;
  readonly server: Server;
  response: Response | undefined;
}

export type WsMiddleware = Middleware<RhythmWsContext>;

export interface WsRoute<Data extends object = WsParams> {
  upgrade?(request: Request, params: WsParams, server: Server): Data | Response | Promise<Data | Response>;
  headers?: Bun.HeadersInit | ((request: Request, params: WsParams) => Bun.HeadersInit | Promise<Bun.HeadersInit>);
  open?(ws: Bun.ServerWebSocket<Data>): void | Promise<void>;
  message?(ws: Bun.ServerWebSocket<Data>, message: string | Buffer): void | Promise<void>;
  drain?(ws: Bun.ServerWebSocket<Data>): void | Promise<void>;
  close?(ws: Bun.ServerWebSocket<Data>, code: number, reason: string): void | Promise<void>;
}

export type WsOrigin =
  "same-origin" | readonly string[] | ((origin: string, request: Request) => boolean | Promise<boolean>) | false;

export interface WsBehavior {
  maxPayloadLength?: number;
  idleTimeout?: number;
  backpressureLimit?: number;
  closeOnBackpressureLimit?: boolean;
  sendPings?: boolean;
  publishToSelf?: boolean;
  perMessageDeflate?: Bun.WebSocketHandler<never>["perMessageDeflate"];
}

export interface RhythmWsOptions extends WsBehavior {
  prefix?: string;
  origin?: WsOrigin;
}

type AnyRoute = WsRoute<object>;
type AnyWs = Bun.ServerWebSocket<object>;

type Entry =
  | { kind: "middleware"; fn: WsMiddleware; paths: readonly string[]; mounted: boolean }
  | { kind: "route"; path: string; route: AnyRoute };

const mountedRoutes = Symbol.for("rhythmjs.ws.routes");
const upgradedFlag = Symbol.for("rhythmjs.ws.upgraded");

interface UpgradeContext extends RhythmWsContext {
  [upgradedFlag]?: boolean;
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  const trimmedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedPrefix}${normalizedPath}`;
}

const connections = new WeakMap<object, AnyRoute>();

export class RhythmWs {
  #options: RhythmWsOptions;
  #entries: Entry[] = [];
  #matchTree: RouterContext<AnyRoute> | null = null;
  #pipeline: ((context: UpgradeContext, next?: NextFn<UpgradeContext>) => Promise<UpgradeContext>) | null = null;

  constructor(options: RhythmWsOptions = {}) {
    this.#options = options;
  }

  get #prefix(): string {
    return this.#options.prefix ?? "";
  }

  route<Data extends object = WsParams>(path: string, route: WsRoute<Data>): this {
    if (typeof route !== "object" || route === null) {
      throw new TypeError("route must be a handlers object!");
    }
    this.#entries.push({ kind: "route", path: joinPath(this.#prefix, path), route: route as AnyRoute });
    this.#invalidate();
    return this;
  }

  use(fn: WsMiddleware): this {
    if (typeof fn !== "function") throw new TypeError("middleware must be a function!");
    const paths = (fn as { [mountedRoutes]?: readonly string[] })[mountedRoutes];
    this.#entries.push({ kind: "middleware", fn, paths: paths ?? [], mounted: paths !== undefined });
    this.#invalidate();
    return this;
  }

  get routes(): readonly string[] {
    return this.#entries.flatMap((entry) => (entry.kind === "route" ? [entry.path] : entry.paths));
  }

  upgrade = (request: Request, server: Server): Promise<Response | undefined> | null => {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
    const tree = (this.#matchTree ??= this.#compileMatchTree());
    if (!findRoute(tree, "", new URL(request.url).pathname)) return null;
    return this.#run(request, server);
  };

  middleware(): WsMiddleware {
    const fn = this.#compile();
    const mounted: WsMiddleware = async (ctx, next) => {
      await fn(ctx as UpgradeContext, next as NextFn<UpgradeContext>);
    };
    Object.defineProperty(mounted, mountedRoutes, { value: this.routes });
    return mounted;
  }

  get websocket(): Bun.WebSocketHandler<never> {
    const { prefix: _prefix, origin: _origin, ...behavior } = this.#options;
    const routeOf = (ws: AnyWs): AnyRoute | undefined => connections.get(ws.data);
    return {
      ...behavior,
      open(ws: AnyWs) {
        return routeOf(ws)?.open?.(ws);
      },
      message(ws: AnyWs, message: string | Buffer) {
        return routeOf(ws)?.message?.(ws, message);
      },
      drain(ws: AnyWs) {
        return routeOf(ws)?.drain?.(ws);
      },
      close(ws: AnyWs, code: number, reason: string) {
        return routeOf(ws)?.close?.(ws, code, reason);
      },
    } as unknown as Bun.WebSocketHandler<never>;
  }

  #invalidate(): void {
    this.#matchTree = null;
    this.#pipeline = null;
  }

  async #allowsOrigin(request: Request): Promise<boolean> {
    const option = this.#options.origin ?? "same-origin";
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

  async #run(request: Request, server: Server): Promise<Response | undefined> {
    if (!(await this.#allowsOrigin(request))) return new Response("Forbidden", { status: 403 });
    const ctx: UpgradeContext = { request, server, response: undefined };
    const fn = (this.#pipeline ??= this.#compile());
    await fn(ctx);
    if (ctx.response instanceof Response) return ctx.response;
    if (ctx[upgradedFlag] === true) return undefined;
    return new Response("Forbidden", { status: 403 });
  }

  async #accept(ctx: UpgradeContext, route: AnyRoute, params: WsParams): Promise<void> {
    let data: object = params;
    if (route.upgrade) {
      const out = await route.upgrade(ctx.request, params, ctx.server);
      if (out instanceof Response) {
        ctx.response = out;
        return;
      }
      if (out !== undefined) data = out;
    }
    const headers = typeof route.headers === "function" ? await route.headers(ctx.request, params) : route.headers;

    connections.set(data, route);
    if (ctx.server.upgrade(ctx.request, { data, ...(headers === undefined ? {} : { headers }) })) {
      ctx[upgradedFlag] = true;
      return;
    }
    ctx.response = new Response("Upgrade failed", { status: 500 });
  }

  #compile(): (context: UpgradeContext, next?: NextFn<UpgradeContext>) => Promise<UpgradeContext> {
    const dispatchFor = (tree: RouterContext<AnyRoute>): Middleware<UpgradeContext> => {
      return async (ctx, next) => {
        if (ctx.response !== undefined || ctx[upgradedFlag] === true) return;
        const match = findRoute(tree, "", new URL(ctx.request.url).pathname);
        if (!match) {
          await next();
          return;
        }
        await this.#accept(ctx, match.data, match.params ?? {});
      };
    };

    // Like the router: a middleware only runs when a route registered after it (own or mounted) matches the
    // request. A mounted child gates its own middleware the same way against its own routes.
    const trees: RouterContext<AnyRoute>[] = [];
    const reaches = (ctx: UpgradeContext, from: number): boolean => {
      const pathname = new URL(ctx.request.url).pathname;
      for (let t = from; t < trees.length; t++) if (findRoute(trees[t]!, "", pathname)) return true;
      return false;
    };

    const stack: Middleware<UpgradeContext>[] = [];
    let i = 0;
    while (i < this.#entries.length) {
      const entry = this.#entries[i]!;
      if (entry.kind === "middleware") {
        const fn = entry.fn as Middleware<UpgradeContext>;
        if (entry.mounted) {
          const tree = createRouter<AnyRoute>();
          for (const path of entry.paths) addRoute(tree, "", path, {});
          trees.push(tree);
          stack.push(fn);
        } else {
          const from = trees.length;
          stack.push(async (ctx, next) => {
            if (reaches(ctx, from)) await fn(ctx, next);
            else await next();
          });
        }
        i++;
        continue;
      }
      const tree = createRouter<AnyRoute>();
      while (i < this.#entries.length) {
        const routeEntry = this.#entries[i]!;
        if (routeEntry.kind !== "route") break;
        addRoute(tree, "", routeEntry.path, routeEntry.route);
        i++;
      }
      trees.push(tree);
      stack.push(dispatchFor(tree));
    }

    return compose<UpgradeContext>(stack);
  }

  #compileMatchTree(): RouterContext<AnyRoute> {
    const tree = createRouter<AnyRoute>();
    for (const path of this.routes) addRoute(tree, "", path, {});
    return tree;
  }
}
