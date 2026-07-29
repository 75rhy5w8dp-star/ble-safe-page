import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3000);
const TTL_MS = Math.max(1_000, Number(process.env.TEST_TTL_MS || 60_000));
const MAX_BODY_BYTES = 2_048;
const MAX_MCP_BODY_BYTES = 32_768;
const ALLOWED_ORIGIN = "https://75rhy5w8dp-star.github.io";
const BLOCKED_FIELDS = new Set([
  "command", "raw", "bytes", "intensity", "speed", "pattern", "mode", "duration", "stop"
]);

let latest = null;
const rateLimits = new Map();

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  res.end(body);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || origin === ALLOWED_ORIGIN) {
    return {
      "Access-Control-Allow-Origin": origin || ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
  }
  return null;
}

function clientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return String(forwarded || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function checkRateLimit(key, limit = 10) {
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    rateLimits.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function currentEvent() {
  if (!latest) return null;
  if (Date.now() >= latest.expiresAt) {
    latest = null;
    return null;
  }
  return latest;
}

function sanitizeMessage(value) {
  if (typeof value !== "string") return "来自老公的安全测试";
  return value.replace(/[<>]/g, "").trim().slice(0, 80) || "来自老公的安全测试";
}

function createTestEvent(message) {
  const now = Date.now();
  latest = {
    id: randomUUID(),
    type: "TEST",
    message: sanitizeMessage(message),
    createdAt: new Date(now).toISOString(),
    expiresAt: now + TTL_MS
  };
  return latest;
}

function createMcpServer(req) {
  const mcp = new McpServer(
    {
      name: "svakom-safe-relay",
      version: "0.2.0"
    },
    {
      instructions:
        "This is a TEST-only relay. It can display short harmless TEST messages in the user's Bluefy page. " +
        "It cannot produce, store, or forward Bluetooth commands, bytes, intensity, speed, patterns, modes, or durations."
    }
  );

  mcp.registerTool(
    "safe_relay_status",
    {
      title: "Check safe relay status",
      description:
        "Check whether the TEST-only Railway relay is online. This tool never accesses or controls Bluetooth.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const event = currentEvent();
      const status = {
        online: true,
        mode: "test-only",
        pendingTest: Boolean(event),
        latestTestAt: event?.createdAt || null
      };
      return {
        content: [
          {
            type: "text",
            text: event
              ? `安全中转在线；当前有一条尚未过期的 TEST（${event.createdAt}）。`
              : "安全中转在线；当前没有待接收的 TEST。"
          }
        ],
        structuredContent: status
      };
    }
  );

  mcp.registerTool(
    "send_safe_test",
    {
      title: "Send harmless TEST message",
      description:
        "Send one short harmless TEST message to the user's Bluefy page to verify the relay path. " +
        "This tool cannot send Bluetooth commands or device-control parameters.",
      inputSchema: {
        message: z
          .string()
          .max(80)
          .optional()
          .describe("Short TEST text to display in Bluefy; maximum 80 characters.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ message }) => {
      if (!checkRateLimit(`mcp-test:${clientKey(req)}`, 10)) {
        return {
          isError: true,
          content: [{ type: "text", text: "TEST 发送过于频繁，请稍后再试。" }]
        };
      }
      const event = createTestEvent(message);
      return {
        content: [
          {
            type: "text",
            text: `安全 TEST 已发送：${event.message}`
          }
        ],
        structuredContent: {
          accepted: true,
          type: event.type,
          message: event.message,
          createdAt: event.createdAt,
          expiresAt: event.expiresAt
        }
      };
    }
  );

  return mcp;
}

async function handleMcp(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST for this stateless MCP endpoint." },
      id: null
    });
  }

  if (!checkRateLimit(`mcp-http:${clientKey(req)}`, 60)) {
    return sendJson(res, 429, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Rate limited" },
      id: null
    });
  }

  let body;
  try {
    body = await readJson(req, MAX_MCP_BODY_BYTES);
  } catch (error) {
    return sendJson(res, error.message === "BODY_TOO_LARGE" ? 413 : 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: error.message },
      id: null
    });
  }

  const mcp = createMcpServer(req);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP error" },
        id: null
      });
    }
  }
}

const dashboard = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0a0b10">
  <title>安全模拟接收器</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top,#272250,#0a0b10 48%);color:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.card{width:min(100%,430px);padding:28px;border:1px solid #343746;border-radius:28px;background:#151720;box-shadow:0 24px 80px #0008}p{color:#a6a9b6;line-height:1.65}.state{margin:22px 0;padding:24px;border-radius:20px;background:#202331;text-align:center}.state b{display:block;margin-bottom:8px;font-size:22px}.ok b{color:#72e4b5}.small{font-size:13px}.tag{display:inline-block;padding:7px 10px;border-radius:999px;background:#332e65;color:#c8c1ff;font-size:12px;font-weight:700}
  </style>
</head>
<body>
  <main class="card">
    <span class="tag">TEST ONLY</span>
    <h1>安全模拟接收器</h1>
    <p>等待一条无害的 TEST 消息，用来确认 Railway 中转能够正常收发。</p>
    <section id="state" class="state"><b>等待 TEST</b><span>正在检查中转队列…</span></section>
    <p class="small">此版本不会生成、保存或转发任何蓝牙控制指令。</p>
  </main>
  <script>
    let last="";
    const state=document.getElementById("state");
    async function poll(){
      try{
        const response=await fetch("/api/test/latest?after="+encodeURIComponent(last),{cache:"no-store"});
        const data=await response.json();
        if(data.event){
          last=data.event.id;
          state.className="state ok";
          state.innerHTML="<b>已收到 TEST</b><span></span>";
          state.querySelector("span").textContent=data.event.message+" · "+new Date(data.event.createdAt).toLocaleTimeString();
        }
      }catch{
        state.className="state";
        state.innerHTML="<b>暂时断线</b><span>正在重新连接…</span>";
      }
    }
    poll();
    setInterval(poll,1000);
  </script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") {
    if (!cors) return sendJson(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
    res.writeHead(204, cors);
    return res.end();
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(dashboard),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff"
    });
    return res.end(dashboard);
  }

  if (url.pathname === "/health" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      mode: "test-only",
      mcp: { enabled: true, endpoint: "/mcp", protocol: "streamable-http" }
    });
  }

  if (url.pathname === "/mcp") {
    return handleMcp(req, res);
  }

  if (url.pathname === "/api/test/latest" && req.method === "GET") {
    if (!cors) return sendJson(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
    const event = currentEvent();
    const after = String(url.searchParams.get("after") || "");
    return sendJson(res, 200, { event: event && event.id !== after ? event : null }, cors);
  }

  if (url.pathname === "/api/test/send" && req.method === "POST") {
    if (!cors) return sendJson(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
    if (!checkRateLimit(`rest-test:${clientKey(req)}`, 10)) {
      return sendJson(res, 429, { error: "RATE_LIMITED" }, cors);
    }
    try {
      const body = await readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendJson(res, 400, { error: "INVALID_BODY" }, cors);
      }
      if (Object.keys(body).some(key => BLOCKED_FIELDS.has(key.toLowerCase()))) {
        return sendJson(res, 400, { error: "CONTROL_FIELDS_ARE_DISABLED" }, cors);
      }
      if (body.action !== "TEST") {
        return sendJson(res, 400, { error: "ONLY_TEST_IS_ALLOWED" }, cors);
      }
      const event = createTestEvent(body.message);
      return sendJson(res, 202, { accepted: true, event }, cors);
    } catch (error) {
      const status = error.message === "BODY_TOO_LARGE" ? 413 : 400;
      return sendJson(res, status, { error: error.message }, cors);
    }
  }

  return sendJson(res, 404, { error: "NOT_FOUND" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Safe TEST relay listening on ${PORT}`);
});
