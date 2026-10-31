// Native Supabase OTP verification atomically consumes the invitation before any password change.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const MAX_BODY_BYTES = 16 * 1024;

function settings() {
  const siteValue = Deno.env.get("SITE_URL");
  const apiUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!siteValue || !apiUrl || !anonKey) throw new HttpError(503, "NOT_CONFIGURED", "邀请服务尚未完成配置。");
  const site = new URL(siteValue);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname);
  if (site.username || site.password || site.search || site.hash ||
    (local ? Deno.env.get("ENVIRONMENT") !== "development" || !["https:", "http:"].includes(site.protocol) : site.protocol !== "https:")) {
    throw new HttpError(503, "INVALID_SITE_URL", "网站地址配置有误。");
  }
  return { site, apiUrl, anonKey };
}

function response(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "Vary": "Origin", ...cors,
  } });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, "JSON_REQUIRED", "请使用 JSON 格式提交。");
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new HttpError(413, "BODY_TOO_LARGE", "提交内容不能超过 16 KB。");
  if (!req.body) throw new HttpError(400, "INVALID_BODY", "提交内容为空。");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new HttpError(413, "BODY_TOO_LARGE", "提交内容不能超过 16 KB。"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, "INVALID_JSON", "提交内容不是有效的 JSON 对象。"); }
}

export async function handler(req: Request): Promise<Response> {
  let cors: Record<string, string> = {};
  let verified = false;
  let client: ReturnType<typeof createClient> | null = null;
  try {
    const config = settings();
    if (req.headers.get("origin") !== config.site.origin) throw new HttpError(403, "ORIGIN_DENIED", "请求必须来自配置的网站。");
    cors = { "Access-Control-Allow-Origin": config.site.origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Vary": "Origin", "Cache-Control": "no-store" } });
    if (req.method !== "POST") return response({ error: "仅支持 POST。", code: "METHOD_NOT_ALLOWED" }, 405, { ...cors, "Allow": "POST, OPTIONS" });
    const body = await readBody(req);
    if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) throw new HttpError(400, "INVALID_PASSWORD", "密码须为 12 至 128 个字符。");
    if (typeof body.token_hash !== "string" || !/^[a-zA-Z0-9_-]{16,512}$/.test(body.token_hash) ||
      (body.type !== "invite" && body.type !== "recovery")) {
      throw new HttpError(400, "INVALID_INVITATION", "邀请链接无效，请向站主重新申请。");
    }
    // A fresh anon client becomes only the verified recipient; no service-role password bypass.
    client = createClient(config.apiUrl, config.anonKey,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const checked = await client.auth.verifyOtp({ token_hash: body.token_hash, type: body.type });
    if (checked.error || !checked.data.session || !checked.data.user) {
      throw new HttpError(checked.error?.status === 429 ? 429 : 400, "INVALID_INVITATION", "邀请已使用、已过期或无效，请向站主重新申请。");
    }
    verified = true;
    const access = await client.rpc("get_schedule_role");
    if (access.error) throw new HttpError(503, "ACCESS_UNAVAILABLE", "邀请已验证但权限检查未完成，请联系站主重新邀请。");
    if (access.data !== "editor") throw new HttpError(403, "ACCESS_REVOKED", "此账号已无编辑权限，请联系站主。");
    const changed = await client.auth.updateUser({ password: body.password });
    if (changed.error || !changed.data.user) {
      throw new HttpError(400, "PASSWORD_NOT_SET", "邀请已验证，但密码未能设置；请联系站主重新邀请后再试。");
    }
    // Re-check after the Auth request: revocation during password update must not grant app access.
    const finalAccess = await client.rpc("get_schedule_role");
    if (finalAccess.error) throw new HttpError(503, "ACCESS_UNAVAILABLE", "设置未能确认，请联系站主重新邀请。");
    if (finalAccess.data !== "editor") throw new HttpError(403, "ACCESS_REVOKED", "编辑权限已被撤销，请联系站主。");
    const session = { ...checked.data.session, user: changed.data.user };
    return response({ session }, 200, cors);
  } catch (error) {
    if (verified && client) {
      try { await client.auth.signOut({ scope: "local" }); } catch { /* RLS remains the authority even if logout fails. */ }
    }
    if (error instanceof HttpError) return response({ error: error.message, code: error.code }, error.status, cors);
    return response({ error: verified ? "邀请已验证但操作未完成，请联系站主重新邀请。" : "邀请服务暂时不可用，请稍后再试。", code: "SERVICE_UNAVAILABLE" }, 503, cors);
  }
}

Deno.serve(handler);
