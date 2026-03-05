import crypto from "node:crypto";

export function isAuthorizedControlPlaneRequest(
  providedToken: string,
  configuredToken: string
): boolean {
  if (!configuredToken) return true;
  if (!providedToken) return false;
  const a = Buffer.from(providedToken);
  const b = Buffer.from(configuredToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isAllowedMap(map: string, allowedMaps: Set<string>): boolean {
  return allowedMaps.has(map);
}

export function isAllowedMode(mode: string, allowedModes: Set<string>): boolean {
  return allowedModes.has(mode as never);
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
