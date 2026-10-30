/** IPv6 address helpers (BigInt based). Addresses are shown in Packet Tracer's style: upper case, compressed. */

export function v6ToBig(s: string): bigint | null {
  const a = s.trim().split('%')[0];
  if (!/^[0-9a-fA-F:.]+$/.test(a) || !a.includes(':')) return null;
  const parts = a.split('::');
  if (parts.length > 2) return null;
  const side = (x: string) => (x ? x.split(':') : []);
  const head = side(parts[0]);
  const tail = parts.length === 2 ? side(parts[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 && head.length !== 8) return null;
  if (missing < 0 || (parts.length === 2 && missing < 1)) return null;
  const groups = [...head, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

export const isV6 = (s?: string) => !!s && v6ToBig(s) !== null;

export function bigToV6(n: bigint): string {
  const g: number[] = [];
  for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  // compress the longest run of zero groups (2 or more)
  let best = -1;
  let len = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > len && j - i >= 2) {
      best = i;
      len = j - i;
    }
    i = j;
  }
  const hex = g.map((x) => x.toString(16).toUpperCase());
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + len).join(':')}`;
}

export const normV6 = (s: string) => {
  const n = v6ToBig(s);
  return n === null ? s : bigToV6(n);
};

const maskOf = (len: number) => (len === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - len)) - 1n));

export function v6Prefix(addr: string, len: number): string {
  const n = v6ToBig(addr);
  return n === null ? addr : bigToV6(n & maskOf(len));
}

export function inV6(addr: string, prefix: string, len: number): boolean {
  const a = v6ToBig(addr);
  const p = v6ToBig(prefix);
  if (a === null || p === null) return false;
  return (a & maskOf(len)) === (p & maskOf(len));
}

/** the 64-bit interface identifier from a MAC address (modified EUI-64) */
export function eui64(mac: string): bigint {
  const h = mac.replace(/[.:-]/g, '').toLowerCase().padStart(12, '0');
  const b = h.match(/../g)!.map((x) => parseInt(x, 16));
  b[0] ^= 2;
  const bytes = [b[0], b[1], b[2], 0xff, 0xfe, b[3], b[4], b[5]];
  return bytes.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
}

export const linkLocal = (mac: string) => bigToV6((0xfe80n << 112n) | eui64(mac));

export function slaac(prefix: string, mac: string): string {
  const p = v6ToBig(prefix) ?? 0n;
  return bigToV6((p & maskOf(64)) | eui64(mac));
}

export const isLinkLocal = (s: string) => inV6(s, 'FE80::', 10);

/** "2001:DB8::1/64" → [addr, len] */
export function splitPrefix(s: string): [string, number] | null {
  const [a, l] = s.split('/');
  const len = Number(l);
  if (!isV6(a) || !Number.isInteger(len) || len < 0 || len > 128) return null;
  return [normV6(a), len];
}
