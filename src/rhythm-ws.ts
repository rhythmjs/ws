import { addRoute, createRouter, findRoute, type RouterContext } from "rou3";

export type WsParams = Readonly<Record<string, string>>;
export type Server = Bun.Server<unknown>;

/**
 * A routed websocket endpoint. Every lifecycle member is exactly Bun's
 * `WebSocketHandler` member — `ws` is Bun's `ServerWebSocket`, and `ws.data`
 * is whatever `upgrade` returned for this connection (the route params when
 * there is no `upgrade`).
 */
export interface WsRoute<Data extends object = WsParams> {
  /**
   * Runs before `server.upgrade()`. Return this connection's `ws.data`, or a
   * Response to reject the handshake.
   */
  upgrade?(request: Request, params: WsParams, server: Server): Data | Response | Promise<Data | Response>;
  /** Extra headers for the 101 response (subprotocol, cookies). */
  headers?: Bun.HeadersInit | ((request: Request, params: WsParams) => Bun.HeadersInit | Promise<Bun.HeadersInit>);
  open?(ws: Bun.ServerWebSocket<Data>): void | Promise<void>;
  message?(ws: Bun.ServerWebSocket<Data>, message: string | Buffer): void | Promise<void>;
  drain?(ws: Bun.ServerWebSocket<Data>): void | Promise<void>;
  close?(ws: Bun.ServerWebSocket<Data>, code: number, reason: string): void | Promise<void>;
  ping?(ws: Bun.ServerWebSocket<Data>, data: Buffer): void | Promise<void>;
  pong?(ws: Bun.ServerWebSocket<Data>, data: Buffer): void | Promise<void>;
}

/** Runs before a matched route's upgrade; return a Response to reject the handshake. */
export type WsGuard = (
  request: Request,
  server: Server,
) => Response | undefined | void | Promise<Response | undefined | void>;

/** Bun's websocket behavior tuning, passed through to `Bun.serve` verbatim. */
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
}

type AnyRoute = WsRoute<object>;
type AnyWs = Bun.ServerWebSocket<object>;

interface Entry {
  path: string;
  route: AnyRoute;
  extraGuards: readonly WsGuard[];
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  const trimmedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedPrefix}${normalizedPath}`;
}

// data -> route, shared across instances so one `websocket` behavior on a
// server dispatches for every RhythmWs upgrading on it.
const connections = new WeakMap<object, AnyRoute>();

export class RhythmWs {
  #options: RhythmWsOptions;
  #entries: Entry[] = [];
  #guards: WsGuard[] = [];
  #tree: RouterContext<Entry> | null = null;

  constructor(options: RhythmWsOptions = {}) {
    this.#options = options;
  }

  get #prefix(): string {
    return this.#options.prefix ?? "";
  }

  /** Register an endpoint. `Data` is this route's `ws.data` type; without `upgrade` it is the route params. */
  route<Data extends object = WsParams>(path: string, route: WsRoute<Data>): this {
    if (typeof route !== "object" || route === null) {
      throw new TypeError("route must be a handlers object!");
    }
    this.#entries.push({ path: joinPath(this.#prefix, path), route: route as AnyRoute, extraGuards: [] });
    this.#tree = null;
    return this;
  }

  /** Add a guard that runs, in registration order, before every route of this instance. */
  guard(fn: WsGuard): this {
    if (typeof fn !== "function") throw new TypeError("guard must be a function!");
    this.#guards.push(fn);
    return this;
  }

  /**
   * Copy another instance's routes under this instance's prefix, keeping the
   * child's guards (snapshotted now) inside this instance's own.
   */
  merge(child: RhythmWs): this {
    for (const entry of child.#entries) {
      this.#entries.push({
        path: joinPath(this.#prefix, entry.path),
        route: entry.route,
        extraGuards: [...child.#guards, ...entry.extraGuards],
      });
    }
    this.#tree = null;
    return this;
  }

  get routes(): readonly string[] {
    return this.#entries.map((entry) => entry.path);
  }

  /**
   * The fetch-side half. Returns null synchronously when the request is not a
   * matching websocket upgrade — hand it to your HTTP app:
   *
   *     fetch: (request, server) => chat.upgrade(request, server) ?? app(request)
   *
   * Otherwise resolves to undefined once the socket is upgraded, or to the
   * Response that rejects the handshake.
   */
  upgrade = (request: Request, server: Server): Promise<Response | undefined> | null => {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
    const tree = (this.#tree ??= this.#compile());
    const match = findRoute(tree, "", new URL(request.url).pathname);
    if (!match) return null;
    return this.#accept(request, server, match.data, match.params ?? {});
  };

  /** The one `websocket` behavior for `Bun.serve`, carrying this instance's tuning options. */
  get websocket(): Bun.WebSocketHandler<never> {
    const { prefix: _prefix, ...behavior } = this.#options;
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
      ping(ws: AnyWs, data: Buffer) {
        return routeOf(ws)?.ping?.(ws, data);
      },
      pong(ws: AnyWs, data: Buffer) {
        return routeOf(ws)?.pong?.(ws, data);
      },
    } as unknown as Bun.WebSocketHandler<never>;
  }

  async #accept(request: Request, server: Server, entry: Entry, params: WsParams): Promise<Response | undefined> {
    for (const guard of [...this.#guards, ...entry.extraGuards]) {
      const verdict = await guard(request, server);
      if (verdict instanceof Response) return verdict;
    }

    const route = entry.route;
    let data: object = params;
    if (route.upgrade) {
      const out = await route.upgrade(request, params, server);
      if (out instanceof Response) return out;
      if (out !== undefined) data = out;
    }
    const headers = typeof route.headers === "function" ? await route.headers(request, params) : route.headers;

    connections.set(data, route);
    if (server.upgrade(request, { data, ...(headers === undefined ? {} : { headers }) })) return undefined;
    return new Response("Upgrade failed", { status: 500 });
  }

  #compile(): RouterContext<Entry> {
    const tree = createRouter<Entry>();
    for (const entry of this.#entries) addRoute(tree, "", entry.path, entry);
    return tree;
  }
}
