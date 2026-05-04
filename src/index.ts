#!/usr/bin/env node

import http from "http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, pools, ENV_NAMES, RATE_LIMIT, QUERY_TIMEOUT, MAX_ROWS } from "./mcp.js";
import { startHttpServer } from "./http/server.js";

let httpServer: http.Server | undefined;

async function shutdown() {
  const tasks: Promise<void>[] = Object.values(pools).map((p) => p.end());
  if (httpServer) {
    tasks.push(new Promise((resolve) => httpServer!.close(() => resolve())));
  }
  await Promise.all(tasks);
  process.exit(0);
}

async function main() {
  const rawPort = process.env.PORT;

  if (rawPort) {
    const port = parseInt(rawPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid PORT: "${rawPort}"`);
      process.exit(1);
    }
    httpServer = await startHttpServer(port);
  } else {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`PostgreSQL Read-Only MCP Server v2.0.0 (stdio)`);
    console.error(`Environments: ${ENV_NAMES.join(", ")}`);
    console.error(`Mode: READ-ONLY | rate=${RATE_LIMIT}/min | timeout=${QUERY_TIMEOUT}ms | max_rows=${MAX_ROWS}`);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

process.on("SIGINT", () => shutdown().catch(() => process.exit(1)));
process.on("SIGTERM", () => shutdown().catch(() => process.exit(1)));
