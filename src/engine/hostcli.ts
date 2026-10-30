import { isIp } from '../model/ip';
import type { Device, Project } from '../model/types';
import { ping, renew } from './network';
import { ownerOf, resolve } from './services';
import { settleV6, v6Of } from './ipv6';
import { isV6, normV6 } from '../model/ip6';

export const hostPrompt = () => 'C:\\>';

export const HOST_CMDS = ['arp', 'cls', 'help', 'hostname', 'ipconfig', 'ipv6config', 'nslookup', 'ping', 'ssh', 'telnet', 'tracert', 'exit'];

/** addresses each host has already reached (for the first-ping ARP loss) */
const hostArp = new Map<string, Set<string>>();

/** Mutates p (immer draft) for ipconfig /renew. Returns output; '\f' clears the screen. */
export function hostExec(p: Project, d: Device, line: string): string {
  const w = line.trim().split(/\s+/);
  const c = (w[0] ?? '').toLowerCase();
  if (!c) return '';
  const i = d.ifaces.find((x) => !x.shutdown && x.media !== 'console') ?? d.ifaces[0];

  switch (c) {
    case 'help':
    case '?':
      return 'Available commands:\n  arp -a\n  cls\n  hostname\n  ipconfig [/all | /renew | /release]\n  nslookup <name>\n  ping <ip or name> [-n count]\n  ssh -l <username> <ip>\n  telnet <ip>\n  tracert <ip or name>\n';
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
        .filter((x) => x.media !== 'console')
        .map((x) => {
          const v = v6Of(d, x);
          const g6 = v.globals[0]?.addr ?? '::';
          return (
            `\n${x.media === 'wireless' ? 'Wireless' : x.name.replace(/\d+$/, '')}0 Connection:(default port)\n\n` +
            (all ? `   Physical Address................: ${x.mac}\n   DHCP Enabled....................: ${d.dhcpClient ? 'Yes' : 'No'}\n` : '') +
            `   Connection-specific DNS Suffix..: \n   Link-local IPv6 Address.........: ${v.ll ?? '::'}\n   IPv6 Address....................: ${g6}\n   IPv4 Address....................: ${x.ip ?? '0.0.0.0'}\n   Subnet Mask.....................: ${x.mask ?? '0.0.0.0'}\n   Default Gateway.................: ${d.gateway6 || '::'}\n                                     ${d.gateway || '0.0.0.0'}\n` +
            (all ? `   DHCPv6 Client DUID..............: 00-01-00-01-${x.mac.replace(/\./g, '').match(/../g)!.join('-')}\n   DNS Servers.....................: ${d.dns6 || '::'}\n                                     ${d.dns || '0.0.0.0'}\n` : '')
          );
        })
        .join('');
    }
    case 'nslookup': {
      if (!w[1]) return 'Usage: nslookup <name>\n';
      const r = resolve(p, d, w[1]);
      const srv = d.dns || '0.0.0.0';
      return r.ok ? `\nServer: [${srv}]\nAddress:  ${srv}\n\nNon-authoritative answer:\nName:   ${w[1]}\nAddress:  ${r.ip}\n\n` : `\nServer: [${srv}]\nAddress:  ${srv}\n\nDNS request timed out.\n   timeout was 15000 milli seconds.\n*** UnKnown can't find ${w[1]}: Non-existent domain\n`;
    }
    case 'ping': {
      const nIdx = w.findIndex((x) => x === '-n');
      const n = nIdx > 0 ? Math.max(1, Math.min(20, Number(w[nIdx + 1]) || 4)) : 4;
      const arg = w.find((x, k) => k > 0 && !x.startsWith('-') && w[k - 1] !== '-n');
      if (!arg) return 'Usage: ping <ip or name> [-n count]\n';
      if (isV6(arg)) {
        const r = ping(p, d.id, arg, { count: true });
        const t = normV6(arg);
        let out = `\nPinging ${t} with 32 bytes of data:\n\n`;
        for (let k = 0; k < n; k++) out += r.ok ? `Reply from ${t}: bytes=32 time<1ms TTL=${128 - r.routers.length}\n` : r.unreachFrom ? `Reply from ${r.unreachFrom}: Destination host unreachable.\n` : 'Request timed out.\n';
        const got = r.ok ? n : 0;
        return out + `\nPing statistics for ${t}:\n    Packets: Sent = ${n}, Received = ${got}, Lost = ${n - got} (${Math.round(((n - got) / n) * 100)}% loss),\n`;
      }
      let target = arg;
      if (!isIp(arg)) {
        const look = resolve(p, d, arg);
        if (!look.ok) return `Ping request could not find host ${arg}. Please check the name and try again.\n`;
        target = look.ip;
      }
      const r = ping(p, d.id, target, { count: true });
      const owner = ownerOf(p, target);
      const ttl = (owner && (owner.ios || owner.home) ? 255 : 128) - Math.max(0, r.routers.filter((x) => x.ip !== target).length);
      // the first echo through a router is often lost while ARP resolves
      const seen = hostArp.get(d.id) ?? hostArp.set(d.id, new Set()).get(d.id)!;
      const cold = r.ok && r.routers.length > 0 && !seen.has(target);
      if (r.ok) seen.add(target);
      let out = `\nPinging ${isIp(arg) ? target : `${arg} [${target}]`} with 32 bytes of data:\n\n`;
      for (let k = 0; k < n; k++) {
        if (r.ok && !(cold && k === 0)) out += `Reply from ${target}: bytes=32 time${r.hops.length > 2 ? '=' + r.hops.length + 'ms' : '<1ms'} TTL=${ttl}\n`;
        else if (r.ok) out += 'Request timed out.\n';
        else out += r.reason?.startsWith('Destination') ? `Reply from ${r.unreachFrom ?? r.srcIp}: Destination host unreachable.\n` : 'Request timed out.\n';
      }
      const ok = r.ok ? n - (cold ? 1 : 0) : 0;
      out += `\nPing statistics for ${target}:\n    Packets: Sent = ${n}, Received = ${ok}, Lost = ${n - ok} (${Math.round(((n - ok) / n) * 100)}% loss),\n`;
      return out;
    }
    case 'tracert': {
      let target = w[1];
      if (!target) return 'Usage: tracert <ip or name>\n';
      if (!isIp(target)) {
        const look = resolve(p, d, target);
        if (!look.ok) return `Unable to resolve target system name ${target}.\n`;
        target = look.ip;
      }
      const r = ping(p, d.id, target);
      let out = `\nTracing route to ${target} over a maximum of 30 hops: \n\n`;
      let k = 1;
      for (const h of r.routers) out += `  ${k++}   0 ms      0 ms      0 ms      ${h.ip}\n`;
      if (r.ok) out += `  ${k}   0 ms      0 ms      0 ms      ${target}\n\nTrace complete.\n`;
      else out += `  ${k}   *         *         *         Request timed out.\n`;
      return out;
    }
    case 'ipv6config': {
      const x = d.ifaces.find((y) => y.media !== 'console' && !y.shutdown) ?? d.ifaces[0];
      const v = v6Of(d, x);
      if (w[1] === '/renew' || w[1] === 'autoconfig') {
        d.v6Mode = w[1] === '/renew' ? 'dhcp' : 'auto';
        settleV6(p);
      }
      return `\nIPv6 Address....................: ${(x.v6 ?? v.globals)[0] ? `${(x.v6 ?? v.globals)[0].addr}/${(x.v6 ?? v.globals)[0].len}` : '::'}\nLink-local IPv6 Address.........: ${v.ll}\nDefault Gateway.................: ${d.gateway6 || '::'}\nDNS Server......................: ${d.dns6 || '::'}\n`;
    }
    case 'arp':
      return 'No ARP Entries Found\n';
    case 'exit':
      return '';
    default:
      return 'Invalid Command.\n';
  }
}
