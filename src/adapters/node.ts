import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import wsAdapter, { type NodeAdapter, type NodeOptions } from "crossws/adapters/node";
import type { RhythmWs, WsResolve } from "../rhythm-ws";

export type { NodeAdapter, NodeOptions };

export interface NodeUpgradeSource {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

export function handle(ws: RhythmWs | WsResolve, options: Omit<NodeOptions, "resolve"> = {}): NodeAdapter {
  const resolve = typeof ws === "function" ? ws : ws.resolve;
  return wsAdapter({ ...options, resolve });
}

export function attach(server: NodeUpgradeSource, adapter: NodeAdapter): void {
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.upgrade?.toLowerCase() === "websocket") {
      void adapter.handleUpgrade(req, socket, head);
    }
  });
}
