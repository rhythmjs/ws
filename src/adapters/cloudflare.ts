import wsAdapter, { type CloudflareDurableAdapter, type CloudflareOptions } from "crossws/adapters/cloudflare";
import type { RhythmWs, WsResolve } from "../rhythm-ws";

export type { CloudflareDurableAdapter, CloudflareOptions };

export function handle(
  ws: RhythmWs | WsResolve,
  options: Omit<CloudflareOptions, "resolve"> = {},
): CloudflareDurableAdapter {
  const resolve = typeof ws === "function" ? ws : ws.resolve;
  return wsAdapter({ ...options, resolve });
}
