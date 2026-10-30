export const ipToInt = (ip: string): number | null => {
  const p = ip.trim().split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
};

export const intToIp = (n: number) =>
  [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

export const isIp = (s?: string) => !!s && ipToInt(s) !== null;

export const isMask = (s?: string) => {
  const n = s ? ipToInt(s) : null;
  if (n === null) return false;
  const inv = ~n >>> 0;
  return (inv & (inv + 1)) === 0;
};

export const maskToPrefix = (mask: string) => {
  let n = ipToInt(mask) ?? 0;
  let c = 0;
  while (n & 0x80000000) {
    c++;
    n = (n << 1) >>> 0;
  }
  return c;
};

export const prefixToMask = (p: number) => intToIp(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);

export const network = (ip: string, mask: string) =>
  ((ipToInt(ip) ?? 0) & (ipToInt(mask) ?? 0)) >>> 0;

export const sameSubnet = (a: string, b: string, mask: string) =>
  network(a, mask) === network(b, mask);

export const inNet = (ip: string, net: string, mask: string) =>
  network(ip, mask) === network(net, mask);

export const broadcast = (ip: string, mask: string) =>
  (network(ip, mask) | (~(ipToInt(mask) ?? 0) >>> 0)) >>> 0;

export const classfulMask = (ip: string) => {
  const first = Number(ip.split('.')[0]);
  if (first < 128) return '255.0.0.0';
  if (first < 192) return '255.255.0.0';
  return '255.255.255.0';
};

export const randomMac = () => {
  const h = () => Math.floor(Math.random() * 65536).toString(16).toUpperCase().padStart(4, '0');
  return `00${Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0')}.${h()}.${h()}`;
};
