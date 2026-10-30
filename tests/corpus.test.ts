// @vitest-environment jsdom
// Robustness sweep over a folder of decoded Packet Tracer files (e.g. the sample
// networks that ship with Packet Tracer). Point NETFORGE_CORPUS at a directory of
// XML produced by `pktconv text`. Nothing from that folder is committed.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { importPkt, exportPkt } from '../src/io/pkt';
import { buildTopo, settleDhcp } from '../src/engine/network';
import { exec, newSession, runningConfig } from '../src/engine/ios';

const dir = process.env.NETFORGE_CORPUS ?? '';
const files = dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.xml')).sort() : [];

test.skipIf(!files.length)('every corpus file imports, simulates, exports and re-imports', () => {
  const failures: string[] = [];
  let devices = 0;
  let links = 0;
  for (const f of files) {
    const xml = readFileSync(join(dir, f), 'utf8');
    try {
      const r = importPkt(xml, f);
      const p = r.project;
      devices += p.devices.length;
      links += p.links.length;
      buildTopo(p);
      settleDhcp(p);
      for (const d of p.devices) {
        if (!d.ios) continue;
        runningConfig(d);
        const s = newSession();
        for (const cmd of ['enable', 'show ip interface brief', 'show running-config']) exec(p, d, s, cmd);
      }
      if (p.sourceXml) {
        const out = exportPkt(p);
        const again = importPkt(out.xml, f).project;
        if (again.devices.length !== p.devices.length) failures.push(`${f}: device count changed on round-trip`);
        if (again.links.length !== p.links.length) failures.push(`${f}: link count changed on round-trip`);
      }
    } catch (e) {
      failures.push(`${f}: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
    }
  }
  console.log(`corpus: ${files.length} files, ${devices} devices, ${links} links, ${failures.length} failures`);
  expect(failures).toEqual([]);
}, 600_000);
