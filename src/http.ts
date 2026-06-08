/**
 * Streamable HTTP transport for remote MCP clients (ChatGPT, web, multi-device).
 *
 * Security posture (per current MCP guidance):
 *  - Bearer-token auth on /mcp when MINDMAP_TOKEN is set (constant-time compare).
 *  - Origin allow-listing to block DNS-rebinding from browsers.
 *  - Binds to loopback by default; binding publicly without a token is refused.
 *  - Stateless JSON mode: a fresh server + transport per request (no shared state,
 *    no request-id collisions). TLS is expected to be terminated by a proxy/host.
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";

import { createServer } from "./server.js";

const TOKEN = process.env.MINDMAP_TOKEN;
const HOST = process.env.MINDMAP_HOST || "127.0.0.1";
const PORT = parseInt(process.env.MINDMAP_PORT || process.env.PORT || "3000", 10);
const ALLOWED_ORIGINS = (process.env.MINDMAP_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function tokensMatch(provided: string): boolean {
  if (!TOKEN) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bearer-token gate. No-op (with a startup warning) when TOKEN is unset. */
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!TOKEN) {
    next();
    return;
  }
  const header = req.header("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !tokensMatch(match[1])) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
      id: null,
    });
    return;
  }
  next();
}

/** Reject browser requests from un-allowed origins (DNS-rebinding protection). */
function originMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header("origin");
  // Non-browser clients (e.g. ChatGPT's backend) send no Origin — allowed.
  if (!origin) {
    next();
    return;
  }
  let allowed = ALLOWED_ORIGINS.includes(origin);
  try {
    if (!allowed && isLoopback(new URL(origin).hostname)) allowed = true;
  } catch {
    /* malformed origin -> not allowed */
  }
  if (!allowed) {
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32002, message: `Forbidden origin: ${origin}` },
      id: null,
    });
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  next();
}

export async function runHttp(): Promise<void> {
  if (!isLoopback(HOST) && !TOKEN) {
    console.error(
      "[mindmap] REFUSING to bind to a non-loopback host without MINDMAP_TOKEN set. " +
        "Set a token, or bind to 127.0.0.1 behind a trusted proxy.",
    );
    process.exit(1);
  }

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.options("/mcp", originMiddleware, (_req, res) => {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.sendStatus(204);
  });

  app.post("/mcp", originMiddleware, authMiddleware, async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mindmap] request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode: GET/DELETE streams aren't used.
  app.all("/mcp", (_req, res) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed; use POST." },
      id: null,
    }),
  );

  app.listen(PORT, HOST, () => {
    console.error(`[mindmap] HTTP transport on http://${HOST}:${PORT}/mcp`);
    console.error(
      `[mindmap] auth: ${TOKEN ? "bearer token required" : "OPEN (set MINDMAP_TOKEN to secure)"}`,
    );
  });
}
