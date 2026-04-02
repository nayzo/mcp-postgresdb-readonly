import http from "http";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createMcpServer,
  ENV_NAMES,
  RATE_LIMIT,
  QUERY_TIMEOUT,
  MAX_ROWS,
  log,
} from "../mcp.js";

export async function startHttpServer(port: number): Promise<http.Server> {
  const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

  if (!AUTH_TOKEN) {
    console.error("WARNING: MCP_AUTH_TOKEN is not set, server is unprotected");
  }

  const app = express();
  app.use(express.json());

  // ── Auth middleware (Bearer token, skip /health) ────────────────────────────
  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/health") { next(); return; }
    if (!AUTH_TOKEN) { next(); return; }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  // ── Health check ────────────────────────────────────────────────────────────
  app.get("/health", (_req: Request, res: Response): void => {
    res.json({
      status: "ok",
      version: "2.0.0",
      environments: ENV_NAMES,
      transport: "streamable-http",
    });
  });

  // ── MCP endpoint (Streamable HTTP, stateless) ───────────────────────────────
  // Each POST creates a fresh server+transport instance.
  // Stateless mode: no session ID → clients send self-contained requests.
  // Compatible with: Claude Code, Cursor, OpenCode, and any MCP HTTP client.
  app.post("/mcp", async (req: Request, res: Response): Promise<void> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    const server = createMcpServer();

    res.on("close", () => {
      transport.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log({ tool: "http-post", status: "ERROR", detail: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // GET /mcp, not supported in stateless mode
  app.get("/mcp", (_req: Request, res: Response): void => {
    res.status(405).json({
      error: "Method Not Allowed",
      detail: "This server runs in stateless mode. Use POST /mcp for all requests.",
    });
  });

  // ── Start ───────────────────────────────────────────────────────────────────
  return new Promise((resolve) => {
    const httpServer = http.createServer(app);
    httpServer.listen(port, () => {
      console.error(`PostgreSQL Read-Only MCP Server v2.0.0 (HTTP mode)`);
      console.error(`Listening  : http://0.0.0.0:${port}`);
      console.error(`MCP endpoint: POST /mcp`);
      console.error(`Health      : GET  /health`);
      console.error(`Environments: ${ENV_NAMES.join(", ")}`);
      console.error(`Mode: READ-ONLY | rate=${RATE_LIMIT}/min | timeout=${QUERY_TIMEOUT}ms | max_rows=${MAX_ROWS}`);
      console.error(`Auth: ${AUTH_TOKEN ? "Bearer token enabled" : "DISABLED (set MCP_AUTH_TOKEN)"}`);
      resolve(httpServer);
    });
  });
}
