import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type Redis from "ioredis";

export type AppRole = "player" | "moderator" | "admin";

export function hasPrivilegedRole(role: string): role is "moderator" | "admin" {
  return role === "moderator" || role === "admin";
}

export function secureEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function normalizeSafeRelativePath(input: string | undefined, fallback = "/"): string {
  if (!input) return fallback;
  if (!input.startsWith("/")) return fallback;
  if (input.startsWith("//")) return fallback;
  if (input.includes("\\")) return fallback;
  return input;
}

function buildSigningPayload(req: FastifyRequest, timestamp: string, nonce: string): string {
  const method = req.method.toUpperCase();
  const route = req.url.split("?")[0];
  const body = req.body ? JSON.stringify(req.body) : "";
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return `${timestamp}.${nonce}.${method}.${route}.${bodyHash}`;
}

function hmac(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function verifyInternalRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: {
    token?: string;
    secret?: string;
    redis?: Redis;
    nonceTtlSeconds?: number;
    maxSkewMs?: number;
    onFailure?: (reason: string) => Promise<void> | void;
  }
): Promise<boolean> {
  const token = String(req.headers["x-internal-token"] ?? "");
  const configuredToken = opts.token ?? "";
  const configuredSecret = opts.secret ?? "";

  // Development fallback: if no internal auth configured, allow internal routes.
  if (!configuredToken && !configuredSecret) {
    return true;
  }

  if (configuredToken && token && secureEquals(token, configuredToken)) {
    return true;
  }

  const timestamp = String(req.headers["x-internal-timestamp"] ?? "");
  const nonce = String(req.headers["x-internal-nonce"] ?? "");
  const signature = String(req.headers["x-internal-signature"] ?? "");
  if (!configuredSecret || !timestamp || !nonce || !signature) {
    await opts.onFailure?.("missing_auth");
    await reply.code(401).send({ error: "Unauthorized internal request" });
    return false;
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    await opts.onFailure?.("invalid_timestamp");
    await reply.code(401).send({ error: "Invalid signature timestamp" });
    return false;
  }
  const skew = Math.abs(Date.now() - ts);
  if (skew > (opts.maxSkewMs ?? 5 * 60 * 1000)) {
    await opts.onFailure?.("stale_timestamp");
    await reply.code(401).send({ error: "Stale signature timestamp" });
    return false;
  }

  if (!/^[a-fA-F0-9_-]{12,128}$/.test(nonce)) {
    await opts.onFailure?.("invalid_nonce");
    await reply.code(401).send({ error: "Invalid signature nonce" });
    return false;
  }

  if (opts.redis) {
    const nonceKey = `internal:req:nonce:${nonce}`;
    const ok = await opts.redis.set(nonceKey, "1", "EX", opts.nonceTtlSeconds ?? 600, "NX");
    if (ok !== "OK") {
      await opts.onFailure?.("replay");
      await reply.code(409).send({ error: "Replay detected" });
      return false;
    }
  }

  const payload = buildSigningPayload(req, timestamp, nonce);
  const expected = hmac(configuredSecret, payload);
  if (!secureEquals(expected, signature)) {
    await opts.onFailure?.("bad_signature");
    await reply.code(401).send({ error: "Invalid request signature" });
    return false;
  }

  return true;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((x) => Number(x));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((nums[0] << 24) >>> 0) + (nums[1] << 16) + (nums[2] << 8) + nums[3]) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split("/");
  if (!net || !bitsRaw) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(net);
  if (ipInt === null || netInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return (ipInt & mask) === (netInt & mask);
}

export function isIpAllowed(ip: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const normalizedIp = String(ip ?? "").replace("::ffff:", "");
  for (const entry of allowlist) {
    const rule = entry.trim();
    if (!rule) continue;
    if (rule.includes("/")) {
      if (inCidr(normalizedIp, rule)) return true;
      continue;
    }
    if (normalizedIp === rule) return true;
  }
  return false;
}
