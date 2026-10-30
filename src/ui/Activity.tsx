import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { grade, type Verdict } from '../engine/grade';
import { I } from './Icons';

/** Raw bytes from the file arrive as U+F700+n; instructions are usually Windows-1252 Word HTML. */
function fixRaw(s: string) {
  return s.replace(/[-]+/g, (m) => {
    const bytes = Uint8Array.from([...m].map((c) => c.charCodeAt(0) - 0xf700));
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return '';
    }
  });
}

const THEME_CSS = `
<style>
  html { background: #fff; }
  body { font: 14px/1.55 system-ui, 'Segoe UI', sans-serif; color: #1b2230; padding: 18px 24px; max-width: 880px; margin: 0 auto; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #d6dbe4; padding: 4px 8px; }
</style>`;

export function ActivityButton() {
  const project = useStore((s) => s.project);
  const set = useStore((s) => s.set);
  const report = useMemo(() => grade(project), [project]);
  if (!project.activity) return null;
  const pct = report && report.checkable ? Math.round((report.earned / report.checkable) * 100) : null;
  return (
    <button className="btn outline" onClick={() => set({ activityOpen: true })} title="Instructions and results">
      <I.note size={15} /> Activity
      {pct !== null && <span className={`pill ${pct === 100 ? 'good' : ''}`}>{pct}%</span>}
    </button>
  );
}

export function ActivityDialog() {
  const project = useStore((s) => s.project);
  const open = useStore((s) => s.activityOpen);
  const set = useStore((s) => s.set);
  const [tab, setTab] = useState<'instructions' | 'results'>('instructions');
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<'all' | Verdict>('all');
  const act = project.activity;
  const report = useMemo(() => (open ? grade(project) : null), [project, open]);
  if (!open || !act) return null;

  const html = act.pages[page] ? fixRaw(act.pages[page]).replace(/contenteditable="true"/gi, '').replace(/<head>/i, `<head>${THEME_CSS}`) : '<p>No instructions in this activity.</p>';
  const pct = report && report.checkable ? Math.round((report.earned / report.checkable) * 100) : 0;
  const counts = { pass: 0, fail: 0, unchecked: 0 };
  report?.results.forEach((r) => counts[r.verdict]++);
  const shown = report?.results.filter((r) => filter === 'all' || r.verdict === filter) ?? [];

  return (
    <div className="overlay" style={{ paddingTop: '5vh' }} onPointerDown={() => set({ activityOpen: false })}>
      <div className="activity" onPointerDown={(e) => e.stopPropagation()}>
        <div className="activity-head">
          <div>
            <div style={{ fontWeight: 650, fontSize: 15 }}>{act.title ?? project.fileName?.replace(/\.pka$/i, '') ?? 'Activity'}</div>
            <div style={{ color: 'var(--text-3)', fontSize: 12 }}>Packet Tracer activity</div>
          </div>
          <div className="segmented" style={{ marginLeft: 'auto' }}>
            <button className={tab === 'instructions' ? 'on' : ''} onClick={() => setTab('instructions')}>
              Instructions
            </button>
            <button className={tab === 'results' ? 'on' : ''} onClick={() => setTab('results')}>
              Check results
            </button>
          </div>
          <button className="btn icon" title="Close" onClick={() => set({ activityOpen: false })}>
            <I.x size={16} />
          </button>
        </div>

        {tab === 'instructions' ? (
          <>
            <iframe className="activity-doc" sandbox="" srcDoc={html} title="Activity instructions" />
            {act.pages.length > 1 && (
              <div className="activity-foot">
                <button className="btn sm outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  Previous
                </button>
                <span style={{ color: 'var(--text-3)' }}>
                  Page {page + 1} of {act.pages.length}
                </span>
                <button className="btn sm outline" disabled={page >= act.pages.length - 1} onClick={() => setPage(page + 1)}>
                  Next
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="activity-results">
            {report ? (
              <>
                <div className="score">
                  <div className="ring" style={{ ['--p' as string]: pct }}>
                    <span>{pct}%</span>
                  </div>
                  <div>
                    <div style={{ fontWeight: 620, fontSize: 15 }}>
                      {report.earned} of {report.checkable} points on items NetForge can check
                    </div>
                    <p style={{ margin: '4px 0 0', color: 'var(--text-2)' }}>
                      {counts.unchecked > 0
                        ? `${counts.unchecked} item${counts.unchecked === 1 ? '' : 's'} (${report.total - report.checkable} points) can't be checked here yet, such as cable types and DHCP-assigned addresses. `
                        : ''}
                      This is an estimate. Packet Tracer's own Check Results is what your instructor sees.
                    </p>
                  </div>
                </div>
                <div className="segmented" style={{ margin: '0 0 10px' }}>
                  {(['all', 'fail', 'pass', 'unchecked'] as const).map((f) => (
                    <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                      {f === 'all' ? `All ${report.results.length}` : f === 'fail' ? `Incorrect ${counts.fail}` : f === 'pass' ? `Correct ${counts.pass}` : `Not checked ${counts.unchecked}`}
                    </button>
                  ))}
                </div>
                <div className="results-list">
                  {shown.map((r, i) => (
                    <div key={i} className={`result ${r.verdict}`}>
                      <span className="mark">{r.verdict === 'pass' ? '✓' : r.verdict === 'fail' ? '✕' : '–'}</span>
                      <span className="path">{r.label}</span>
                      <span className="pts">{r.item.points} pt</span>
                    </div>
                  ))}
                  {!shown.length && <div className="blank">Nothing here.</div>}
                </div>
              </>
            ) : (
              <div className="blank">This activity has no assessment items.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
