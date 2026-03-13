import type { ServerWebSocket } from "bun";

export interface WSEvent {
  type: string;
  data: unknown;
}

const clients = new Set<ServerWebSocket<unknown>>();

export function addClient(ws: ServerWebSocket<unknown>): void {
  clients.add(ws);
}

export function removeClient(ws: ServerWebSocket<unknown>): void {
  clients.delete(ws);
}

export function broadcast(event: WSEvent): void {
  if (clients.size === 0) return;
  const msg = JSON.stringify(event);
  for (const ws of clients) {
    try { ws.send(msg); } catch { clients.delete(ws); }
  }
}

export function clientCount(): number {
  return clients.size;
}
