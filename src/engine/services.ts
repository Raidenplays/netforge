/**
 * Application-layer services: DNS lookups and HTTP requests between devices, used by the
 * Desktop apps (Web Browser, nslookup).
 */
import { isIp } from '../model/ip';
import type { Device, Project, ServerServices } from '../model/types';
import { ping } from './network';

export const defaultPages = (name: string): Record<string, string> => ({
  'index.html': `<html>
<center><font size='+2' color='#2563eb'>${name}</font></center>
<hr>Welcome! This page is served by a NetForge web server.
<p>Quick links:
<br><a href='helloworld.html'>A small page</a>
</html>`,
  'helloworld.html': `<html>
<center><font size='+2' color='#2563eb'>Hello, world!</font></center>
<hr><p><a href='index.html'>Back to the home page</a>
</html>`,
});

export const defaultServices = (name: string): ServerServices => ({ http: true, pages: defaultPages(name), dns: false, records: [] });

/** the device that owns an IP address */
export function ownerOf(p: Project, ip: string): Device | undefined {
  return p.devices.find((d) => d.ifaces.some((i) => i.ip === ip) || d.home?.lanIp === ip || d.home?.wanIp === ip);
}

export type Lookup = { ok: true; ip: string; server?: string } | { ok: false; error: string };

/** Resolve a host name the way the client would: through its configured DNS server. */
export function resolve(p: Project, client: Device, host: string): Lookup {
  const name = host.trim().replace(/\.$/, '');
  if (isIp(name)) return { ok: true, ip: name };
  const dnsIp = client.dns;
  if (!dnsIp || !isIp(dnsIp) || dnsIp === '0.0.0.0') return { ok: false, error: 'no DNS server is configured' };
  const server = ownerOf(p, dnsIp);
  if (!server?.services?.dns || !server.powered || !ping(p, client.id, dnsIp).ok) return { ok: false, error: `DNS server ${dnsIp} didn't answer` };
  let want = name.toLowerCase();
  for (let hops = 0; hops < 8; hops++) {
    const rec = server.services.records.find((r) => r.name.toLowerCase() === want && (r.type === 'A' || r.type === 'CNAME'));
    if (!rec) break;
    if (rec.type === 'A') return { ok: true, ip: rec.value, server: dnsIp };
    want = rec.value.toLowerCase();
  }
  return { ok: false, error: `${name} has no DNS record on ${dnsIp}` };
}

export interface HttpResult {
  ok: boolean;
  url: string;
  html: string;
  status: string;
}

const errorPage = (title: string, detail: string) =>
  `<html><body style="font-family:sans-serif;padding:24px;color:#334"><h2 style="margin:0 0 8px">${title}</h2><p>${detail}</p></body></html>`;

/** GET a page from a server, as the client's web browser would. */
export function httpGet(p: Project, client: Device, rawUrl: string): HttpResult {
  const url = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `http://${rawUrl.trim()}`;
  const m = url.match(/^https?:\/\/([^/:]+)(?::\d+)?(\/.*)?$/i);
  if (!m) return { ok: false, url, status: 'Bad URL', html: errorPage('Invalid URL', `“${rawUrl}” isn't a web address.`) };
  const [, host, rawPath] = m;
  const look = resolve(p, client, host);
  if (!look.ok) return { ok: false, url, status: 'Host Name Unresolved', html: errorPage('Host Name Unresolved', `The name ${host} could not be resolved: ${look.error}.`) };
  const server = ownerOf(p, look.ip);
  if (!ping(p, client.id, look.ip).ok || !server?.powered)
    return { ok: false, url, status: 'Request Timeout', html: errorPage('Request Timeout', `${look.ip} didn't respond. Check cabling, addresses, gateways and routes.`) };
  if (!server.services?.http)
    return { ok: false, url, status: 'Connection refused', html: errorPage('Connection refused', `${server.name} (${look.ip}) isn't running a web server.`) };
  const path = decodeURIComponent((rawPath ?? '/').replace(/^\//, '').split('?')[0]) || 'index.html';
  const page = server.services.pages[path];
  if (page === undefined) return { ok: false, url, status: '404 Not Found', html: errorPage('404 Not Found', `${path} isn't on ${server.name}.`) };
  return { ok: true, url, status: '200 OK', html: page };
}
