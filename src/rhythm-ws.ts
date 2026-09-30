import type { Hooks } from "crossws";
import { addRoute, createRouter, findRoute } from "rou3";

export type WsParams = Readonly<Record<string, string>>;
export type WsHooks = Partial<Hooks>;
export type WsHandler = WsHooks | ((params: WsParams) => WsHooks | Promise<WsHooks>);

export type WsNextFn = () => Promise<WsHooks>;
export type WsMiddleware = (request: Request, next: WsNextFn) => WsHooks | Response | Promise<WsHooks | Response>;

export type WsResolve = (request: Request) => Promise<WsHooks>;

export interface RhythmWsOptions {
  prefix?: string;
}

export type WsEntry =
  | { readonly kind: "middleware"; readonly fn: WsMiddleware }
  | { readonly kind: "endpoint"; readonly path: string; readonly handler: WsHandler };

type Entry = { kind: "middleware"; fn: WsMiddleware } | { kind: "endpoint"; path: string; handler: WsHandler };

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  const trimmedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedPrefix}${normalizedPath}`;
}

function rejectWith(response: Response): WsHooks {
  return {
    upgrade() {
      throw response;
    },
  };
}

const notFound = rejectWith(new Response("Not Found", { status: 404 }));

export class RhythmWs {
  #options: RhythmWsOptions;
  #entries: Entry[] = [];
  #compiled: WsMiddleware | null = null;

  constructor(options: RhythmWsOptions = {}) {
    this.#options = options;
  }

  get #prefix(): string {
    return this.#options.prefix ?? "";
  }

  get entries(): readonly WsEntry[] {
    return [...this.#entries];
  }

  ws(path: string, handler: WsHandler): this {
    if (typeof handler !== "function" && typeof handler !== "object") {
      throw new TypeError("handler must be hooks or a function returning hooks!");
    }
    this.#entries.push({ kind: "endpoint", path: joinPath(this.#prefix, path), handler });
    this.#compiled = null;
    return this;
  }

  use(fn: WsMiddleware): this {
    if (typeof fn !== "function") throw new TypeError("middleware must be a function!");
    this.#entries.push({ kind: "middleware", fn });
    this.#compiled = null;
    return this;
  }

  middleware(): WsMiddleware {
    return this.#compile();
  }

  resolve: WsResolve = async (request) => {
    const compiled = (this.#compiled ??= this.#compile());
    return compiled(request, () => Promise.resolve(notFound)) as Promise<WsHooks>;
  };

  #compile(): WsMiddleware {
    const steps: WsMiddleware[] = [];
    let i = 0;
    while (i < this.#entries.length) {
      const entry = this.#entries[i]!;
      if (entry.kind === "middleware") {
        steps.push(entry.fn);
        i++;
        continue;
      }
      const tree = createRouter<WsHandler>();
      while (i < this.#entries.length) {
        const endpoint = this.#entries[i]!;
        if (endpoint.kind !== "endpoint") break;
        addRoute(tree, "", endpoint.path, endpoint.handler);
        i++;
      }
      steps.push(async (request, next) => {
        const match = findRoute(tree, "", new URL(request.url).pathname);
        if (!match) return next();
        const { data: handler, params } = match;
        return typeof handler === "function" ? await handler(params ?? {}) : handler;
      });
    }

    return async (request, next) => {
      let index = -1;
      const dispatch = async (step: number): Promise<WsHooks> => {
        if (step <= index) throw new Error("next() called multiple times");
        index = step;
        if (step === steps.length) return next();
        const out = await steps[step]!(request, () => dispatch(step + 1));
        if (out instanceof Response) return rejectWith(out);
        if (typeof out !== "object" || out === null) {
          throw new TypeError("ws middleware must return next(), hooks, or a Response!");
        }
        return out;
      };
      try {
        return await dispatch(0);
      } catch (error) {
        if (error instanceof Response) return rejectWith(error);
        throw error;
      }
    };
  }
}
