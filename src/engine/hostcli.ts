import { isIp } from '../model/ip';
import type { Device, Project } from '../model/types';
import { ping, renew } from './network';

export const hostPrompt = () => 'C:\\>';

export const HOST_CMDS = ['arp', 'cls', 'help', 'hostname', 'ipconfig', 'ping', 'tracert', 'exit'];

/** Mutates p (immer draft) for ipconfig /renew. Returns output; '\f' clears the screen. */
export function hostExec(p: Project, d: Device, line: string): string {
  const w = line.trim().split(/\s+/);
  const c = (w[0] ?? '').toLowerCase();
  if (!c) return '';
  const i = d.ifaces.find((x) => !x.shutdown) ?? d.ifaces[0];

  switch (c) {
    case 'help':
    case '?':
      return 'Available commands:\n  arp -a\n  cls\n  hostname\n  ipconfig [/all | /renew | /release]\n  ping <ip> [-n count]\n  tracert <ip>\n';
    case 'cls':
      return '\f';
    case 'hostname':
      return `${d.name}\n`;
    case 'ipconfig': {
      const flag = (w[1] ?? '').toLowerCase();
      if (flag === '/renew') {
        if (!d.dhcpClient) d.dhcpClient = true;
        const o = renew(p, d.id);
        if (!o) return '\nDHCP request failed.\n';
        return `\n   IP Address......................: ${i.ip}\n   Subnet Mask.....................: ${i.mask}\n   Default Gateway.................: ${d.gateway}\n   DNS Server......................: ${d.dns}\n`;
      }
      if (flag === '/release') {
        i.ip = '0.0.0.0';
        i.mask = '0.0.0.0';
        d.gateway = '0.0.0.0';
        return '\n   IP Address......................: 0.0.0.0\n   Subnet Mask.....................: 0.0.0.0\n   Default Gateway.................: 0.0.0.0\n';
      }
      const all = flag === '/all';
      return d.ifaces
        .map(
          (x) =>
            `\n${x.media === 'wireless' ? 'Wireless' : 'FastEthernet'}0 Connection:(default port)\n\n` +
            (all ? `   Physical Address................: ${x.mac}\n   DHCP Enabled....................: ${d.dhcpClient ? 'Yes' : 'No'}\n` : '') +
            `   Connection-specific DNS Suffix..: \n   IPv4 Address....................: ${x.ip ?? '0.0.0.0'}\n   Subnet Mask.....................: ${x.mask ?? '0.0.0.0'}\n   Default Gateway.................: ${d.gateway || '0.0.0.0'}\n` +
            (all ? `   DNS Servers.....................: ${d.dns || '0.0.0.0'}\n` : ''),
        )
        .join('');
    }
    case 'ping': {
      const target = w.find((x, k) => k > 0 && isIp(x));
      const nIdx = w.findIndex((x) => x === '-n');
      const n = nIdx > 0 ? Math.max(1, Math.min(20, Number(w[nIdx + 1]) || 4)) : 4;
      if (!target) return w[1] ? `Ping request could not find host ${w[1]}. Please check the name and try again.\n` : 'Usage: ping <ip> [-n count]\n';
      const r = ping(p, d.id, target);
      let out = `\nPinging ${target} with 32 bytes of data:\n\n`;
      for (let k = 0; k < n; k++) {
        if (r.ok) out += `Reply from ${target}: bytes=32 time${r.hops.length > 2 ? '=' + r.hops.length + 'ms' : '<1ms'} TTL=${128 - r.routers.length}\n`;
        else out += r.reason?.startsWith('Destination') ? `Reply from ${r.srcIp}: Destination host unreachable.\n` : 'Request timed out.\n';
      }
      const ok = r.ok ? n : 0;
      out += `\nPing statistics for ${target}:\n    Packets: Sent = ${n}, Received = ${ok}, Lost = ${n - ok} (${Math.round(((n - ok) / n) * 100)}% loss),\n`;
      return out;
    }
    case 'tracert': {
      const target = w[1];
      if (!isIp(target)) return 'Usage: tracert <ip>\n';
      const r = ping(p, d.id, target);
      let out = `\nTracing route to ${target} over a maximum of 30 hops: \n\n`;
      let k = 1;
      for (const h of r.routers) out += `  ${k++}   0 ms      0 ms      0 ms      ${h.ip}\n`;
      if (r.ok) out += `  ${k}   0 ms      0 ms      0 ms      ${target}\n\nTrace complete.\n`;
      else out += `  ${k}   *         *         *         Request timed out.\n`;
      return out;
    }
    case 'arp':
      return 'No ARP Entries Found\n';
    case 'exit':
      return '';
    default:
      return 'Invalid Command.\n';
  }
}
