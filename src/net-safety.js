const dns = require('dns').promises;
const net = require('net');

const DNS_CACHE_TTL_MS = 60 * 1000;
const dnsCache = new Map();

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 0) return true;
  if (parts[0] >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateIpv6(ip) {
  const lower = String(ip || '').toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('fe80')) return true; // link-local
  return false;
}

function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
}

function sanitizeOutboundUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }

  if (!parsed.hostname) {
    throw new Error('URL hostname is required');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URL must not include credentials');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('Private/internal hosts are not allowed');
  }

  return parsed.toString();
}

async function resolveHostIps(hostname) {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && now - cached.ts < DNS_CACHE_TTL_MS) {
    return cached.ips;
  }

  const results = await dns.lookup(hostname, { all: true });
  const ips = [...new Set(results.map(r => r.address).filter(Boolean))];
  dnsCache.set(hostname, { ts: now, ips });
  return ips;
}

async function assertSafeOutboundUrl(rawUrl, options = {}) {
  if (String(process.env.ENABLE_OUTBOUND_SAFETY || 'true').toLowerCase() === 'false') {
    return sanitizeOutboundUrl(rawUrl);
  }

  const allowPrivateByEnv = String(process.env.ALLOW_PRIVATE_TARGETS || '').toLowerCase() === 'true';
  const allowPrivate = !!options.allowPrivate || allowPrivateByEnv;

  const normalized = sanitizeOutboundUrl(rawUrl);
  if (allowPrivate) return normalized;

  const parsed = new URL(normalized);
  const host = parsed.hostname;
  const directIpFamily = net.isIP(host);
  if (directIpFamily) {
    if (isPrivateIp(host)) {
      throw new Error('Private IP targets are blocked');
    }
    return normalized;
  }

  const ips = await resolveHostIps(host);
  if (ips.length === 0) {
    throw new Error('Unable to resolve host');
  }
  if (ips.some(isPrivateIp)) {
    throw new Error('Host resolves to private/internal IP');
  }
  return normalized;
}

module.exports = {
  assertSafeOutboundUrl,
  sanitizeOutboundUrl,
  isPrivateIp
};
