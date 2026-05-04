import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import { config as dotenvConfig } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, "../.env") });

const { Pool } = pg;

// ── Types ─────────────────────────────────────────────────────────────────────
interface EnvConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema: string | null;
  ssl: boolean;
}

// ── Environment config ────────────────────────────────────────────────────────
const ENV_KEYS: Array<{ key: string; name: string }> = [
  { key: "STG", name: "stg" },
  { key: "TST", name: "tst" },
  { key: "PROD", name: "prod" },
];

function loadConfig(): Record<string, EnvConfig> {
  const environments: Record<string, EnvConfig> = {};

  for (const { key, name } of ENV_KEYS) {
    const host = process.env[`POSTGRES_${key}_HOST`];
    if (!host) continue;

    const user = process.env[`POSTGRES_${key}_USER`];
    const password = process.env[`POSTGRES_${key}_PASSWORD`];
    const database = process.env[`POSTGRES_${key}_DATABASE`];

    if (!user || !password || !database) {
      console.error(
        `Incomplete config for "${name}": POSTGRES_${key}_USER, _PASSWORD and _DATABASE are all required.`
      );
      process.exit(1);
    }

    const rawPort = process.env[`POSTGRES_${key}_PORT`] ?? "5432";
    const port = parseInt(rawPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port for "${name}": "${rawPort}"`);
      process.exit(1);
    }

    const sslRaw = process.env[`POSTGRES_${key}_SSL`];
    const ssl = sslRaw === undefined ? true : sslRaw !== "false";

    environments[name] = {
      host,
      port,
      database,
      user,
      password,
      schema: process.env[`POSTGRES_${key}_SCHEMA`] || null,
      ssl,
    };
  }

  if (Object.keys(environments).length === 0) {
    console.error(
      "No environments configured. Copy .env.dist to .env and fill in your credentials."
    );
    process.exit(1);
  }

  return environments;
}

export const ENV_CONFIGS = loadConfig();
export const ENV_NAMES = Object.keys(ENV_CONFIGS);

// ── Protection config ─────────────────────────────────────────────────────────
function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1) {
    console.error(`Invalid value for ${label}: "${value}", using default (${fallback})`);
    return fallback;
  }
  return parsed;
}

export const RATE_LIMIT    = parsePositiveInt(process.env.RATE_LIMIT_PER_MINUTE, 60,    "RATE_LIMIT_PER_MINUTE");
export const QUERY_TIMEOUT = parsePositiveInt(process.env.QUERY_TIMEOUT_MS,      30000, "QUERY_TIMEOUT_MS");
export const MAX_ROWS      = parsePositiveInt(process.env.MAX_ROWS,               1000,  "MAX_ROWS");

// ── Rate limiter (sliding window, per minute) ─────────────────────────────────
const requestTimestamps: number[] = [];

export function checkRateLimit(): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT) return false;
  requestTimestamps.push(now);
  return true;
}

// ── Auto LIMIT ────────────────────────────────────────────────────────────────
const LIMIT_PATTERN = /\bLIMIT\b/i;

export function enforceLimit(sql: string): { sql: string; injected: boolean } {
  if (LIMIT_PATTERN.test(sql)) return { sql, injected: false };
  const trimmed = sql.trim().replace(/;+$/, ""); // strip trailing semicolons before appending
  return { sql: `${trimmed} LIMIT ${MAX_ROWS}`, injected: true };
}

// ── Connection pools ──────────────────────────────────────────────────────────
export const pools: Record<string, pg.Pool> = {};

const WRITE_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE",
  "ALTER", "CREATE", "REPLACE", "GRANT", "REVOKE",
  "MERGE", "UPSERT", "VACUUM", "REINDEX",
  "COPY", "DO", "CALL",
];

const WRITE_PATTERNS = WRITE_KEYWORDS.map((kw) => ({
  direct: new RegExp(`^${kw}\\b`),
  cte: new RegExp(`^WITH[\\s\\S]*?\\s${kw}\\b`),
}));

// Strips SQL block comments (/* ... */) and line comments (-- ...) from a query.
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
}

// Strips EXPLAIN + parenthesized options + bare option keywords (ANALYZE, VERBOSE, etc.)
// Handles both: EXPLAIN ANALYZE ... and EXPLAIN (ANALYZE, BUFFERS) ...
const EXPLAIN_PREFIX =
  /^EXPLAIN\s*(?:\([^)]*\))?\s*(?:(?:ANALYZE|VERBOSE|COSTS|SETTINGS|GENERIC_PLAN|BUFFERS|WAL|TIMING|SUMMARY|MEMORY)\s+)*/;

export function isWriteQuery(sql: string): boolean {
  const normalized = stripSqlComments(sql).toUpperCase();

  // EXPLAIN ANALYZE actually executes the statement, check the inner query too.
  if (normalized.startsWith("EXPLAIN") && /\bANALYZE\b/.test(normalized)) {
    const inner = normalized.replace(EXPLAIN_PREFIX, "").trim();
    if (WRITE_PATTERNS.some(({ direct, cte }) => direct.test(inner) || cte.test(inner))) {
      return true;
    }
  }

  return WRITE_PATTERNS.some(
    ({ direct, cte }) => direct.test(normalized) || cte.test(normalized)
  );
}

export function getPool(envName: string): pg.Pool {
  if (pools[envName]) return pools[envName];

  const config = ENV_CONFIGS[envName];
  if (!config) {
    throw new Error(
      `Unknown environment: "${envName}". Available: ${ENV_NAMES.join(", ")}`
    );
  }

  pools[envName] = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    options: `-c statement_timeout=${QUERY_TIMEOUT}`,
  });

  pools[envName].on("error", (err) => {
    console.error(`Pool error (${envName}):`, err.message);
  });

  return pools[envName];
}

// ── Tool definitions ──────────────────────────────────────────────────────────
function buildTools(): Tool[] {
  const envDescription = ENV_NAMES.join(", ");

  return [
    {
      name: "query",
      description: `Execute a read-only SQL query on a PostgreSQL database.

⛔ WRITE OPERATIONS ARE STRICTLY FORBIDDEN (INSERT, UPDATE, DELETE, DROP, etc.)
- Always use schema-qualified table names (e.g., schema.table_name)
- Only SELECT queries are accepted
- Use parameterized queries for user-provided values`,
      inputSchema: {
        type: "object",
        properties: {
          env: {
            type: "string",
            description: `Target environment (${envDescription})`,
            enum: ENV_NAMES,
          },
          sql: {
            type: "string",
            description: "SQL SELECT query to execute (read-only)",
          },
          params: {
            type: "array",
            description: "Optional parameters for parameterized queries",
            items: { type: ["string", "number", "boolean", "null"] },
          },
        },
        required: ["env", "sql"],
      },
    },
    {
      name: "list-tables",
      description: "List all tables in a schema",
      inputSchema: {
        type: "object",
        properties: {
          env: {
            type: "string",
            description: `Environment (${envDescription})`,
            enum: ENV_NAMES,
          },
          schema: {
            type: "string",
            description: "Schema name (defaults to the environment's configured schema)",
          },
        },
        required: ["env"],
      },
    },
    {
      name: "describe-table",
      description: "Get the structure of a table (columns, types, nullability, defaults)",
      inputSchema: {
        type: "object",
        properties: {
          env: {
            type: "string",
            description: `Environment (${envDescription})`,
            enum: ENV_NAMES,
          },
          table: {
            type: "string",
            description: "Table name",
          },
          schema: {
            type: "string",
            description: "Schema name (defaults to the environment's configured schema)",
          },
        },
        required: ["env", "table"],
      },
    },
    {
      name: "list-schemas",
      description: "List all user-defined schemas in the database",
      inputSchema: {
        type: "object",
        properties: {
          env: {
            type: "string",
            description: `Environment (${envDescription})`,
            enum: ENV_NAMES,
          },
        },
        required: ["env"],
      },
    },
    {
      name: "list-environments",
      description: "List all configured database environments",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

const TOOLS = buildTools();

// ── Logging ───────────────────────────────────────────────────────────────────
const USE_COLORS = process.stderr.isTTY === true;

const ENV_COLORS: Record<string, string> = {
  prod: "\x1b[31m",
  stg:  "\x1b[33m",
  tst:  "\x1b[36m",
};
const RESET = "\x1b[0m";

function colorEnv(env: string): string {
  if (!USE_COLORS) return env.toUpperCase();
  const color = ENV_COLORS[env] ?? "\x1b[37m";
  return `${color}${env.toUpperCase()}${RESET}`;
}

export function log(parts: Record<string, string | number | undefined>): void {
  const { env, tool, ...rest } = parts;
  const time = new Date().toTimeString().slice(0, 8);
  const envPart = env !== undefined ? ` ${colorEnv(String(env))}` : "";
  const toolPart = tool !== undefined ? ` ${tool}` : "";
  const restPart = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" | ");
  console.error(`[${time}]${envPart}${toolPart}${restPart ? " | " + restPart : ""}`);
}

// ── MCP server factory ────────────────────────────────────────────────────────
export function createMcpServer(): Server {
  const server = new Server(
    { name: "mcp-postgresdb-readonly", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== "list-environments" && !checkRateLimit()) {
      log({ tool: name, status: "RATE LIMITED", limit: `${RATE_LIMIT}/min` });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "RATE LIMIT",
                message: `Too many requests. Max ${RATE_LIMIT} queries per minute.`,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    try {
      switch (name) {
        case "list-environments": {
          const t = Date.now();
          const envs = ENV_NAMES.map((envName) => ({
            name: envName,
            host: ENV_CONFIGS[envName].host,
            database: ENV_CONFIGS[envName].database,
            defaultSchema: ENV_CONFIGS[envName].schema ?? "all",
            ssl: ENV_CONFIGS[envName].ssl,
            readOnly: true,
          }));
          log({ tool: "list-environments", duration: `${Date.now() - t}ms`, envs: ENV_NAMES.join(",") });
          return {
            content: [{ type: "text", text: JSON.stringify(envs, null, 2) }],
          };
        }

        case "query": {
          const t = Date.now();
          const { env, sql, params } = args as {
            env: string;
            sql: string;
            params?: unknown[];
          };

          if (!ENV_CONFIGS[env]) {
            throw new Error(
              `Unknown environment: "${env}". Available: ${ENV_NAMES.join(", ")}`
            );
          }

          if (isWriteQuery(sql)) {
            log({ tool: "query", env, status: "BLOCKED (write)", sql: sql.trim().replace(/\s+/g, " ").slice(0, 120) });
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      error: "READ-ONLY RESTRICTION",
                      message: "Write operations are not allowed on this server.",
                      detail: "Only SELECT queries are permitted.",
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }

          const { sql: finalSql, injected } = enforceLimit(sql);
          const sqlPreview = finalSql.trim().replace(/\s+/g, " ").slice(0, 120);

          const pool = getPool(env);
          const result = await pool.query(finalSql, params as unknown[]);
          log({
            tool: "query",
            env,
            duration: `${Date.now() - t}ms`,
            rows: result.rowCount ?? 0,
            ...(injected ? { limit: `auto:${MAX_ROWS}` } : {}),
            sql: sqlPreview,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    rowCount: result.rowCount,
                    rows: result.rows,
                    fields: result.fields.map((f) => ({
                      name: f.name,
                      dataTypeID: f.dataTypeID,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "list-tables": {
          const t = Date.now();
          const { env, schema: rawSchema } = args as { env: string; schema?: string };
          const schema = rawSchema ?? ENV_CONFIGS[env].schema;

          const pool = getPool(env);
          let result;
          if (schema) {
            result = await pool.query(
              `SELECT
                table_name,
                (SELECT COUNT(*)
                 FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name = t.table_name
                ) AS column_count
              FROM information_schema.tables t
              WHERE table_schema = $1
                AND table_type = 'BASE TABLE'
              ORDER BY table_name`,
              [schema]
            );
          } else {
            result = await pool.query(
              `SELECT
                table_schema,
                table_name,
                (SELECT COUNT(*)
                 FROM information_schema.columns c
                 WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name
                ) AS column_count
              FROM information_schema.tables t
              WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                AND table_schema NOT LIKE 'pg_temp_%'
                AND table_type = 'BASE TABLE'
              ORDER BY table_schema, table_name`
            );
          }
          log({ tool: "list-tables", env, schema: schema ?? "all", duration: `${Date.now() - t}ms`, tables: result.rowCount ?? 0 });

          return {
            content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
          };
        }

        case "describe-table": {
          const t = Date.now();
          const { env, table, schema: rawSchema } = args as { env: string; table: string; schema?: string };
          const schema = rawSchema ?? ENV_CONFIGS[env].schema;

          const pool = getPool(env);
          let result;
          if (schema) {
            result = await pool.query(
              `SELECT
                column_name,
                data_type,
                character_maximum_length,
                numeric_precision,
                numeric_scale,
                is_nullable,
                column_default
              FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = $2
              ORDER BY ordinal_position`,
              [schema, table]
            );
          } else {
            result = await pool.query(
              `SELECT
                table_schema,
                column_name,
                data_type,
                character_maximum_length,
                numeric_precision,
                numeric_scale,
                is_nullable,
                column_default
              FROM information_schema.columns
              WHERE table_name = $1
                AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                AND table_schema NOT LIKE 'pg_temp_%'
              ORDER BY table_schema, ordinal_position`,
              [table]
            );
          }
          log({ tool: "describe-table", env, schema: schema ?? "all", table, duration: `${Date.now() - t}ms`, columns: result.rowCount ?? 0 });

          return {
            content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
          };
        }

        case "list-schemas": {
          const t = Date.now();
          const { env } = args as { env: string };

          const pool = getPool(env);
          const result = await pool.query(
            `SELECT
              schema_name,
              (SELECT COUNT(*)
               FROM information_schema.tables
               WHERE table_schema = s.schema_name
              ) AS table_count
            FROM information_schema.schemata s
            WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            ORDER BY schema_name`
          );
          log({ tool: "list-schemas", env, duration: `${Date.now() - t}ms`, schemas: result.rowCount ?? 0 });

          return {
            content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: error instanceof Error ? error.message : String(error) },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
