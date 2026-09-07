import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny in-process HTTP server standing in for a real "orders" service. Not part of the
 * corrobo package — this only exists so the example is runnable with no external API key
 * and no real network dependency, while still exercising real HTTP requests/responses.
 */

export interface OrderState {
  status: "open" | "cancelling" | "cancelled";
  version: number;
}

export interface OrdersServerHandle {
  url: string;
  close(): Promise<void>;
  seed(id: string, state: OrderState): void;
  getState(id: string): OrderState | undefined;
  requestCount(id: string): number;
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

export function startOrdersServer(): Promise<OrdersServerHandle> {
  const orders = new Map<string, OrderState>();
  const requestCounts = new Map<string, number>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] !== "orders" || !parts[1]) {
      res.writeHead(404).end();
      return;
    }
    const id = parts[1];
    requestCounts.set(id, (requestCounts.get(id) ?? 0) + 1);

    if (req.method === "GET" && parts.length === 2) {
      const state = orders.get(id);
      if (!state) {
        res.writeHead(404).end();
        return;
      }
      respondJson(res, 200, { id, ...state });
      return;
    }

    if (req.method === "POST" && parts[2] === "cancel") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const state = orders.get(id);
        if (!state) {
          res.writeHead(404).end();
          return;
        }
        const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const expectedVersion = parsed.expectedVersion;

        if (typeof expectedVersion === "number" && expectedVersion !== state.version) {
          respondJson(res, 409, {
            error: "version_conflict",
            currentVersion: state.version,
            currentStatus: state.status
          });
          return;
        }

        if (state.status === "cancelled") {
          respondJson(res, 200, { id, ...state });
          return;
        }

        if (parsed.convergeAsync === true) {
          state.status = "cancelling";
          state.version += 1;
          orders.set(id, state);
          setTimeout(() => {
            const current = orders.get(id);
            if (current && current.status === "cancelling") {
              current.status = "cancelled";
              orders.set(id, current);
            }
          }, 150);
        } else {
          state.status = "cancelled";
          state.version += 1;
          orders.set(id, state);
        }

        respondJson(res, 200, { id, ...state });
      });
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
        seed: (id, state) => orders.set(id, { ...state }),
        getState: (id) => orders.get(id),
        requestCount: (id) => requestCounts.get(id) ?? 0
      });
    });
  });
}
