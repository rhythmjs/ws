import wsAdapter, { type BunAdapter, type BunOptions } from "crossws/adapters/bun";
import type { RhythmWs, WsResolve } from "../rhythm-ws";

export type { BunAdapter, BunOptions };

export function handle(ws: RhythmWs | WsResolve, options: Omit<BunOptions, "resolve"> = {}): BunAdapter {
  const resolve = typeof ws === "function" ? ws : ws.resolve;
  return wsAdapter({ ...options, resolve });
}
