import wsAdapter, { type DenoAdapter, type DenoOptions } from "crossws/adapters/deno";
import type { RhythmWs, WsResolve } from "../rhythm-ws";

export type { DenoAdapter, DenoOptions };

export function handle(ws: RhythmWs | WsResolve, options: Omit<DenoOptions, "resolve"> = {}): DenoAdapter {
  const resolve = typeof ws === "function" ? ws : ws.resolve;
  return wsAdapter({ ...options, resolve });
}
