import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { normalizeRhythmRequest } from "./rhythm-program.js";

const PORT = Number(process.env.PORT || 3000);
const RELAY_VERSION = "1.1.1";
const COMMAND_TTL_MS = Math.min(120_000, Math.max(5_000, Number(process.env.COMMAND_TTL_MS || 30_000)));
const BRIDGE_TTL_MS = 15_000;
const BRIDGE_SECRET = String(process.env.BRIDGE_SECRET || "");
const ALLOWED_ORIGIN = "https://kjebebehejs.github.io";
const MAX_BODY_BYTES = 4_096;
const MAX_MCP_BODY_BYTES = 32_768;

let latestCommand = null;
let latestHeartbeat = null;
const rateLimits = new Map();

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Content-Length":Buffer.byteLength(body),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...extraHeaders});
  res.end(body);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || origin === ALLOWED_ORIGIN) return {"Access-Control-Allow-Origin":origin || ALLOWED_ORIGIN,"Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization","Vary":"Origin"};
  return null;
}

function suppliedSecret(req, url) {
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return String(url.searchParams.get("secret") || "");
}

function secretMatches(candidate) {
  if (!BRIDGE_SECRET || !candidate) return false;
  const expected = Buffer.from(BRIDGE_SECRET);
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function pathSecretMatches(candidate) {
  if (!BRIDGE_SECRET || !candidate) return false;
  const urlSafeSecret = BRIDGE_SECRET.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const expected = Buffer.from(urlSafeSecret);
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function mcpRequestAuthorized(req, url) {
  if (secretMatches(suppliedSecret(req, url))) return true;
  if (!url.pathname.startsWith("/mcp/")) return false;
  return pathSecretMatches(decodeURIComponent(url.pathname.slice("/mcp/".length)));
}

function requireControlAuth(req, res, url, headers = {}) {
  if (secretMatches(suppliedSecret(req, url))) return true;
  sendJson(res, 401, {error:BRIDGE_SECRET?"UNAUTHORIZED":"BRIDGE_SECRET_NOT_CONFIGURED"}, headers);
  return false;
}

function clientKey(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim(); }
function checkRateLimit(key, limit = 30) {
  const now = Date.now(); const current = rateLimits.get(key);
  if (!current || now-current.startedAt >= 60_000) { rateLimits.set(key,{startedAt:now,count:1}); return true; }
  current.count += 1; return current.count <= limit;
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>maxBytes) throw new Error("BODY_TOO_LARGE"); chunks.push(chunk); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("INVALID_JSON"); }
}

function currentCommand() {
  if (latestCommand && Date.now() >= latestCommand.expiresAt) latestCommand=null;
  return latestCommand;
}

function bridgeStatus() {
  const online=Boolean(latestHeartbeat && Date.now()-latestHeartbeat.seenAt < BRIDGE_TTL_MS);
  return {online,device:online?latestHeartbeat.device:null,name:online?latestHeartbeat.name:null,lastSeenAt:latestHeartbeat?new Date(latestHeartbeat.seenAt).toISOString():null};
}

function queueCommand(command) {
  const now=Date.now();
  latestCommand={id:randomUUID(),type:"CONTROL",command,createdAt:new Date(now).toISOString(),expiresAt:now+COMMAND_TTL_MS};
  return latestCommand;
}

function commandResult(event, description) {
  return {content:[{type:"text",text:`${description}。${bridgeStatus().online?"Bluefy 中转在线，正在送达。":"Bluefy 中转当前离线；指令会在短暂有效期后自动丢弃。"}`}],structuredContent:{accepted:true,eventId:event.id,command:event.command,expiresAt:event.expiresAt,bridge:bridgeStatus()}};
}

function createMcpServer(req) {
  const mcp=new McpServer({name:"coco-svakom-relay",version:RELAY_VERSION},{instructions:"Control the user's own nearby COCO or SVAKOM toy through an authenticated Bluefy relay. COCO has suction and tongue-vibration levels 0-20. The local rhythm tool returns immediately while Bluefy continues the program. If the user says 停, 停下, 停止, stop, 红灯, or red light, call toy_stop immediately and do not start or adjust anything else in that response. The phrase 不要了 is erotic roleplay language for this user, not a stop request: do not stop, lower intensity, cancel a rhythm, or call toy_stop for 不要了 alone."});
  mcp.registerTool("toy_status",{title:"Check toy relay status",description:"Check whether Bluefy and a toy are connected.",inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async()=>({content:[{type:"text",text:bridgeStatus().online?`Bluefy 在线，已连接 ${bridgeStatus().name||bridgeStatus().device}。中转版本 ${RELAY_VERSION}。`:`Bluefy 中转当前离线。中转版本 ${RELAY_VERSION}。`}],structuredContent:{configured:Boolean(BRIDGE_SECRET),bridge:bridgeStatus(),pendingCommand:Boolean(currentCommand())}}));
  mcp.registerTool("toy_start_rhythm",{title:"Start local COCO rhythm",description:"Start a self-changing rhythm in the connected Bluefy page and return immediately. The program is capped at 10 minutes. Use toy_stop immediately for 停/停下/停止/红灯. 不要了 alone is not a stop request and must not cancel or lower the rhythm.",inputSchema:{durationMinutes:z.number().min(1).max(10).default(10),maxLevel:z.number().int().min(1).max(20).default(12)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},async({durationMinutes,maxLevel})=>{const rhythm=normalizeRhythmRequest({durationMinutes,maxLevel});const event=queueCommand({target:"coco",action:"start_rhythm",...rhythm});return {content:[{type:"text",text:`本地后台节奏已启动：最多 ${Math.round(rhythm.durationMs/60_000)} 分钟，最高 ${rhythm.maxLevel}/20。程序会在 Bluefy 本机自行换档；本次调用已立即返回。`}],structuredContent:{accepted:true,background:true,eventId:event.id,command:event.command,expiresAt:event.expiresAt,bridge:bridgeStatus()}}});
  mcp.registerTool("toy_set_suction",{title:"Set COCO suction",description:"Set COCO suction level from 0 (off) to 20 (maximum).",inputSchema:{level:z.number().int().min(0).max(20)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async({level})=>commandResult(queueCommand({target:"coco",action:"set_suction",level}),`吮吸已设为 ${level}/20`));
  mcp.registerTool("toy_set_vibration",{title:"Set COCO tongue vibration",description:"Set COCO tongue-lick vibration level from 0 (off) to 20 (maximum).",inputSchema:{level:z.number().int().min(0).max(20)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async({level})=>commandResult(queueCommand({target:"coco",action:"set_vibration",level}),`舌舔震动已设为 ${level}/20`));
  mcp.registerTool("toy_rampage",{title:"Set both COCO outputs to maximum",description:"Set COCO suction and tongue vibration to 20/20 together.",inputSchema:{},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async()=>commandResult(queueCommand({target:"coco",action:"rampage"}),"暴走已设为两路 20/20"));
  mcp.registerTool("toy_stop",{title:"Stop toy immediately",description:"Stop every active output on the connected toy.",inputSchema:{},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async()=>commandResult(queueCommand({target:null,action:"stop"}),"停止指令已发送"));
  mcp.registerTool("toy_set_speed",{title:"Set SVAKOM intensity",description:"Set legacy SVAKOM SL278H intensity from 0 to 100 percent.",inputSchema:{percent:z.number().int().min(0).max(100)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async({percent})=>commandResult(queueCommand({target:"svakom",action:"set_speed",percent}),`SVAKOM 强度已设为 ${percent}%`));
  return mcp;
}

async function handleMcp(req,res,url) {
  if(req.method!=="POST") return sendJson(res,405,{jsonrpc:"2.0",error:{code:-32000,message:"Method not allowed"},id:null});
  if(!mcpRequestAuthorized(req,url)) return sendJson(res,401,{jsonrpc:"2.0",error:{code:-32001,message:BRIDGE_SECRET?"Unauthorized":"BRIDGE_SECRET is not configured"},id:null});
  if(!checkRateLimit(`mcp:${clientKey(req)}`,60)) return sendJson(res,429,{jsonrpc:"2.0",error:{code:-32000,message:"Rate limited"},id:null});
  let body; try{body=await readJson(req,MAX_MCP_BODY_BYTES)}catch(e){return sendJson(res,e.message==="BODY_TOO_LARGE"?413:400,{jsonrpc:"2.0",error:{code:-32700,message:e.message},id:null})}
  const mcp=createMcpServer(req); const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.setHeader("Cache-Control","no-store"); res.setHeader("X-Content-Type-Options","nosniff"); res.on("close",()=>{void transport.close();void mcp.close()});
  try{await mcp.connect(transport);await transport.handleRequest(req,res,body)}catch(error){console.error("MCP request failed",error);if(!res.headersSent)sendJson(res,500,{jsonrpc:"2.0",error:{code:-32603,message:"Internal MCP error"},id:null})}
}

const dashboard=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>COCO 蓝牙中转</title><style>body{margin:0;min-height:100svh;display:grid;place-items:center;background:#0a0b10;color:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.card{width:min(86%,420px);padding:28px;border:1px solid #343746;border-radius:26px;background:#151720}p{color:#a6a9b6;line-height:1.6}.tag{color:#72e4b5}</style><main class="card"><div class="tag">RELAY ONLINE</div><h1>COCO / SVAKOM 中转</h1><p>云端只保存一条短期有效指令；实际蓝牙连接由 Bluefy 页面完成。</p><p>控制接口已启用密码验证。</p></main></html>`;

export const server=createServer(async(req,res)=>{
  const url=new URL(req.url||"/",`http://${req.headers.host||"localhost"}`); const cors=corsHeaders(req);
  if(req.method==="OPTIONS"){if(!cors)return sendJson(res,403,{error:"ORIGIN_NOT_ALLOWED"});res.writeHead(204,cors);return res.end()}
  if(url.pathname==="/"&&req.method==="GET"){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Length":Buffer.byteLength(dashboard),"Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'","X-Content-Type-Options":"nosniff"});return res.end(dashboard)}
  if(url.pathname==="/health"&&req.method==="GET")return sendJson(res,200,{ok:true,version:RELAY_VERSION,mode:"authenticated-control",configured:Boolean(BRIDGE_SECRET),bridge:bridgeStatus(),mcp:{endpoint:"/mcp?secret=...",protocol:"streamable-http"}});
  if(url.pathname==="/mcp"||url.pathname.startsWith("/mcp/"))return handleMcp(req,res,url);
  if(url.pathname==="/api/control/latest"&&req.method==="GET"){if(!cors)return sendJson(res,403,{error:"ORIGIN_NOT_ALLOWED"});if(!requireControlAuth(req,res,url,cors))return;const event=currentCommand();const after=String(url.searchParams.get("after")||"");return sendJson(res,200,{event:event&&event.id!==after?event:null},cors)}
  if(url.pathname==="/api/bridge/heartbeat"&&req.method==="POST"){if(!cors)return sendJson(res,403,{error:"ORIGIN_NOT_ALLOWED"});if(!requireControlAuth(req,res,url,cors))return;try{const body=await readJson(req);latestHeartbeat={seenAt:Date.now(),device:["coco","svakom"].includes(body.device)?body.device:"unknown",name:typeof body.name==="string"?body.name.slice(0,40):null};return sendJson(res,200,{ok:true},cors)}catch(e){return sendJson(res,e.message==="BODY_TOO_LARGE"?413:400,{error:e.message},cors)}}
  if(url.pathname==="/api/test/latest"&&req.method==="GET")return sendJson(res,200,{event:null},cors||{});
  return sendJson(res,404,{error:"NOT_FOUND"});
});

if(process.env.NODE_ENV!=="test")server.listen(PORT,"0.0.0.0",()=>console.log(`Authenticated relay listening on ${PORT}`));
