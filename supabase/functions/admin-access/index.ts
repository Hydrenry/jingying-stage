// Self-contained for the Supabase Dashboard editor. No emails are sent by this function.
import { createClient, type User } from "npm:@supabase/supabase-js@2.118.0";

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
type Member = { user_id: string; role: "owner" | "editor"; added_at: string };
type AdminClient = ReturnType<typeof createClient>;
const MAX_BODY_BYTES = 16 * 1024;
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

function settings() {
  const raw = Deno.env.get("SITE_URL");
  const apiUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!raw || !apiUrl || !serviceKey) throw new HttpError(503, "NOT_CONFIGURED", "后台服务尚未完成配置。");
  const site = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname);
  const development = Deno.env.get("ENVIRONMENT") === "development";
  if (site.username || site.password || site.search || site.hash ||
    (local ? !development || !["https:", "http:"].includes(site.protocol) : site.protocol !== "https:")) {
    throw new HttpError(503, "INVALID_SITE_URL", "网站地址配置有误。");
  }
  if (!site.pathname.endsWith("/")) site.pathname += "/";
  return { site, apiUrl, serviceKey };
}

function response(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "Vary": "Origin", ...cors,
  } });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "JSON_REQUIRED", "请使用 JSON 格式提交。");
  }
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new HttpError(413, "BODY_TOO_LARGE", "提交内容不能超过 16 KB。");
  }
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

function emailAddress(input: unknown): string {
  if (typeof input !== "string") throw new HttpError(400, "INVALID_EMAIL", "请填写有效邮箱。");
  const email = input.trim().toLowerCase();
  const parts = email.split("@");
  if (email.length > 254 || parts.length !== 2) throw new HttpError(400, "INVALID_EMAIL", "请填写有效邮箱，最长 254 个字符。");
  const [local, domain] = parts;
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || domain.split(".").length < 2 ||
    domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new HttpError(400, "INVALID_EMAIL", "请填写有效邮箱。");
  }
  return email;
}

async function member(admin: AdminClient, userId: string) {
  const { data, error } = await admin.from("schedule_members").select("role").eq("user_id", userId).maybeSingle();
  if (error) throw new HttpError(503, "ACCESS_UNAVAILABLE", "暂时无法验证管理权限。");
  return data as { role: string } | null;
}

async function findUser(admin: AdminClient, email: string): Promise<User | null> {
  // A dedicated small project is expected; fail explicitly rather than silently miss a large directory.
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new HttpError(error.status === 429 ? 429 : 503, "USERS_UNAVAILABLE", "暂时无法查询账号，请稍后重试。");
    const found = data.users.find(user => user.email?.trim().toLowerCase() === email);
    if (found) return found;
    if (data.users.length < 1000) return null;
  }
  throw new HttpError(503, "DIRECTORY_LIMIT", "账号目录较大，请联系维护者处理授权。");
}

async function accessList(admin: AdminClient, owner: User) {
  const { data, error } = await admin.from("schedule_members").select("user_id, role, added_at").order("added_at");
  if (error) throw new HttpError(503, "LIST_UNAVAILABLE", "暂时无法读取授权名单。");
  const editors = [];
  for (const row of (data || []) as Member[]) {
    if (row.role !== "editor") continue;
    const result = await admin.auth.admin.getUserById(row.user_id);
    if (result.error || !result.data.user?.email) {
      throw new HttpError(503, "LIST_UNAVAILABLE", "账号信息发生变化，请刷新授权名单。");
    }
    const user = result.data.user;
    editors.push({ email: user.email!.toLowerCase(), userId: row.user_id, addedAt: row.added_at,
      status: user.last_sign_in_at ? "active" : "invited" });
  }
  return { ownerEmail: owner.email || "", editors };
}

export async function handler(req: Request): Promise<Response> {
  let cors: Record<string, string> = {};
  try {
    const config = settings();
    if (req.headers.get("origin") !== config.site.origin) throw new HttpError(403, "ORIGIN_DENIED", "请求必须来自配置的网站。");
    cors = { "Access-Control-Allow-Origin": config.site.origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Vary": "Origin", "Cache-Control": "no-store" } });
    if (req.method !== "POST") return response({ error: "仅支持 POST。", code: "METHOD_NOT_ALLOWED" }, 405, { ...cors, "Allow": "POST, OPTIONS" });
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") || "");
    if (!bearer) throw new HttpError(401, "LOGIN_REQUIRED", "请先登录站主账号。");

    // Never forward the user's Authorization header to this service-role database client.
    const admin = createClient(config.apiUrl, config.serviceKey, clientOptions);
    const verified = await admin.auth.getUser(bearer[1]);
    if (verified.error || !verified.data.user) throw new HttpError(401, "INVALID_SESSION", "登录已过期，请重新登录。");
    const owner = verified.data.user;
    if ((await member(admin, owner.id))?.role !== "owner") throw new HttpError(403, "OWNER_REQUIRED", "只有站主可以管理授权。");
    const body = await readBody(req);
    if (body.action === "list") return response(await accessList(admin, owner), 200, cors);
    if (body.action !== "invite" && body.action !== "revoke") throw new HttpError(400, "INVALID_ACTION", "授权操作无效。");
    const email = emailAddress(body.email);
    if (email === owner.email?.trim().toLowerCase()) throw new HttpError(400, "OWNER_IMMUTABLE", "不能通过此页面更改站主权限。");
    const existing = await findUser(admin, email);
    if (existing && (await member(admin, existing.id))?.role === "owner") throw new HttpError(400, "OWNER_IMMUTABLE", "不能更改站主账号。");

    if (body.action === "revoke") {
      if (existing) {
        const result = await admin.from("schedule_members").delete().eq("user_id", existing.id).eq("role", "editor");
        if (result.error) throw new HttpError(503, "REVOKE_FAILED", "撤销未完成，请刷新名单核对。");
      }
      // JWTs or pending Auth links may remain valid; every schedule RPC checks membership anew.
      return response(await accessList(admin, owner), 200, cors);
    }

    const type = existing ? "recovery" : "invite";
    // generateLink returns a token; unlike inviteUserByEmail it does not send an email.
    const generated = await admin.auth.admin.generateLink({ type, email,
      options: { redirectTo: new URL("invitation.html", config.site).href } });
    if (generated.error) throw new HttpError(generated.error.status === 429 ? 429 : 503, "INVITE_FAILED", "邀请链接暂未生成，请稍后重试。");
    const { user, properties } = generated.data;
    if (!user?.id || user.email?.trim().toLowerCase() !== email || !properties?.hashed_token ||
      !["invite", "recovery"].includes(properties.verification_type)) {
      throw new HttpError(503, "INVITE_FAILED", "邀请结果不完整，请刷新名单后重试。");
    }
    // Preserve an existing member's timestamp and never overwrite owner with an editor role.
    const grant = await admin.from("schedule_members").upsert({ user_id: user.id, role: "editor", added_by: owner.id },
      { onConflict: "user_id", ignoreDuplicates: true });
    if (grant.error || (await member(admin, user.id))?.role !== "editor") {
      throw new HttpError(503, "GRANT_FAILED", "账号已生成但授权未完成，请刷新名单后重新邀请。");
    }
    const inviteUrl = new URL("invitation.html", config.site);
    inviteUrl.hash = new URLSearchParams({ token_hash: properties.hashed_token, type: properties.verification_type }).toString();
    // No invented expiry: Supabase project Email OTP expiry controls the native token lifetime.
    return response({ email, inviteUrl: inviteUrl.href }, 200, cors);
  } catch (error) {
    if (error instanceof HttpError) return response({ error: error.message, code: error.code }, error.status, cors);
    return response({ error: "授权服务暂时不可用，请稍后再试。", code: "SERVICE_UNAVAILABLE" }, 503, cors);
  }
}

Deno.serve(handler);
