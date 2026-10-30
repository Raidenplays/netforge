import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { Canvas } from './ui/Canvas';
import { Inspector } from './ui/Inspector';
import { BottomPanel, Library, Palette, Toasts, type Command } from './ui/Panels';
import { I } from './ui/Icons';
import { openDialog, openPath, saveProject, serializeNative, setTitle, startupFile, isTauri, type Opened } from './io/platform';
import { importPkt } from './io/pkt';
import { sampleProject } from './sample';
import { deleteSelection, duplicate, fitView, runPing, primaryIp } from './actions';
import { TEMPLATES } from './model/catalog';

interface Notice {
  title: string;
  body: string;
  items?: string[];
}

export default function App() {
  const project = useStore((s) => s.project);
  const dirty = useStore((s) => s.dirty);
  const mode = useStore((s) => s.mode);
  const theme = useStore((s) => s.theme);
  const palette = useStore((s) => s.palette);
  const past = useStore((s) => s.past);
  const future = useStore((s) => s.future);
  const set = useStore((s) => s.set);
  const wide = useStore((s) => {
    const d = s.project.devices.find((x) => x.id === s.selected);
    return s.inspectorTab === 'cli' && !!d && !d.home;
  });
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('nf-theme', theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  useEffect(() => {
    setTitle(`${dirty ? '• ' : ''}${project.fileName ?? 'Untitled'} — NetForge`);
  }, [dirty, project.fileName]);

  const applyOpened = useCallback((o: Opened | null) => {
    if (!o) return;
    const st = useStore.getState();
    if (o.report) {
      st.load(o.report.project);
      const n = o.report.project.devices.length;
      st.toast(`Opened ${o.report.project.fileName} · ${n} devices, ${o.report.project.links.length} cables`, 'good');
      if (o.report.warnings.length) setNotice({ title: 'Imported with notes', body: 'Some parts of this lab are shown but not simulated yet:', items: o.report.warnings });
    } else if (o.project) {
      st.load(o.project);
      st.toast(`Opened ${o.project.fileName}`, 'good');
    }
  }, []);

  const doOpen = useCallback(async () => {
    try {
      applyOpened(await openDialog());
    } catch (e) {
      useStore.getState().toast(`Couldn't open file: ${(e as Error).message ?? e}`, 'bad');
    }
  }, [applyOpened]);

  const doSave = useCallback(async (as: 'auto' | 'pkt' | 'netforge', dialog = false) => {
    const st = useStore.getState();
    try {
      const r = await saveProject(st.project, as, dialog);
      if (!r) return;
      if (r.path) {
        const name = r.path.split(/[\\/]/).pop()!;
        useStore.setState((s) => ({ dirty: false, project: { ...s.project, filePath: r.path!, fileName: name } }));
        st.toast(`Saved ${name}`, 'good');
      } else if (r.content) {
        await navigator.clipboard?.writeText(r.content).catch(() => undefined);
        st.toast('Browser preview: project copied to clipboard (run the desktop app to save files).', 'info');
      }
      if (r.notExported.length)
        setNotice({
          title: 'Saved — some devices stayed out of the .pkt',
          body: 'New devices added in NetForge can’t be written into Packet Tracer files yet. They’re kept when you save as .netforge:',
          items: r.notExported,
        });
    } catch (e) {
      st.toast(`Save failed: ${(e as Error).message ?? e}`, 'bad');
    }
  }, []);

  const loadSample = useCallback(() => {
    useStore.getState().load(sampleProject());
  }, []);

  // first run + "open with"
  useEffect(() => {
    const onOpen = () => doOpen();
    const onSample = () => loadSample();
    window.addEventListener('nf:open', onOpen);
    window.addEventListener('nf:sample', onSample);
    startupFile()
      .then((p) => (p ? openPath(p).then(applyOpened) : undefined))
      .catch((e) => useStore.getState().toast(`Couldn't open file: ${e}`, 'bad'));
    // test/automation hook: load decoded Packet Tracer XML directly
    (window as unknown as Record<string, unknown>).__nf = {
      loadXml: (xml: string, name = 'lab.pkt') => applyOpened({ report: importPkt(xml, name, name) }),
      store: useStore,
      native: () => serializeNative(useStore.getState().project),
    };
    return () => {
      window.removeEventListener('nf:open', onOpen);
      window.removeEventListener('nf:sample', onSample);
    };
  }, [doOpen, loadSample, applyOpened]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') return e.preventDefault(), doOpen();
      if (mod && e.key.toLowerCase() === 's') return e.preventDefault(), doSave('auto', e.shiftKey);
      if (mod && e.key.toLowerCase() === 'k') return e.preventDefault(), st.set({ palette: !st.palette });
      if (mod && e.key.toLowerCase() === 'm') return e.preventDefault(), st.set({ mode: st.mode === 'realtime' ? 'simulation' : 'realtime', flight: null });
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') return e.preventDefault(), e.shiftKey ? st.redo() : st.undo();
      if (mod && e.key.toLowerCase() === 'y') return e.preventDefault(), st.redo();
      if (mod && e.key.toLowerCase() === 'd' && st.selected) return e.preventDefault(), duplicate(st.selected);
      if (e.key === 'Delete' || e.key === 'Backspace') return deleteSelection();
      if (e.key === 'Escape') return st.set({ tool: 'select', cableFrom: null, pduFrom: null, placing: null, palette: false });
      const k = e.key.toLowerCase();
      if (mod) return;
      if (k === 'v') st.set({ tool: 'select', cableFrom: null, pduFrom: null });
      if (k === 'c') st.set({ tool: 'cable', pduFrom: null, placing: null });
      if (k === 'p') st.set({ tool: 'pdu', cableFrom: null, placing: null });
      if (k === 'n') st.set({ tool: 'note' });
      if (k === 'l') st.set({ showPorts: !st.showPorts });
      if (k === 'f') {
        const r = document.querySelector('.canvas-wrap')!.getBoundingClientRect();
        fitView(r.width, r.height);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doOpen, doSave]);

  const commands: Command[] = useMemo(() => {
    const st = useStore.getState();
    const cmds: Command[] = [
      { id: 'open', label: 'Open file…', hint: 'Ctrl O', run: doOpen },
      { id: 'save', label: 'Save', hint: 'Ctrl S', run: () => doSave('auto') },
      { id: 'save-nf', label: 'Save as NetForge project…', run: () => doSave('netforge', true) },
      ...(project.sourceXml ? [{ id: 'save-pkt', label: 'Save as Packet Tracer .pkt…', run: () => doSave('pkt', true) }] : []),
      { id: 'sample', label: 'Load sample network', run: loadSample },
      { id: 'sim', label: `Switch to ${mode === 'realtime' ? 'simulation' : 'realtime'} mode`, hint: 'Ctrl M', run: () => st.set({ mode: mode === 'realtime' ? 'simulation' : 'realtime', flight: null }) },
      { id: 'theme', label: `Use ${theme === 'dark' ? 'light' : 'dark'} theme`, run: () => st.set({ theme: theme === 'dark' ? 'light' : 'dark' }) },
      { id: 'ports', label: 'Toggle port labels', hint: 'L', run: () => st.set({ showPorts: !st.showPorts }) },
    ];
    for (const t of TEMPLATES) cmds.push({ id: `add-${t.model}`, label: `Add ${t.label}`, hint: t.blurb, run: () => st.set({ placing: t.model }) });
    for (const d of project.devices) {
      cmds.push({ id: `sel-${d.id}`, label: `Go to ${d.name}`, hint: primaryIp(d) ?? d.model, run: () => st.set({ selected: d.id, inspectorTab: 'overview' }) });
      cmds.push({ id: `cli-${d.id}`, label: `Open terminal on ${d.name}`, run: () => st.set({ selected: d.id, inspectorTab: 'cli' }) });
    }
    // quick pings between named devices
    const pingable = project.devices.filter((d) => primaryIp(d));
    for (const a of pingable) for (const b of pingable) if (a !== b && pingable.length < 25) cmds.push({ id: `ping-${a.id}-${b.id}`, label: `Ping ${a.name} → ${b.name}`, hint: primaryIp(b), run: () => runPing(a.id, primaryIp(b)!) });
    return cmds;
  }, [project, mode, theme, doOpen, doSave, loadSample]);

  const ptFile = !!project.sourceXml;

  return (
    <div className={`app ${wide ? 'wide-insp' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <I.logo size={24} />
          NetForge
          <span className="file">{project.fileName ?? 'Untitled'}</span>
          {dirty && <span className="dirty" title="Unsaved changes" />}
        </div>
        <button className="btn" onClick={doOpen} title="Open (Ctrl O)">
          <I.open size={16} /> Open
        </button>
        <button className="btn" onClick={() => doSave('auto')} title="Save (Ctrl S)">
          <I.save size={16} /> Save
        </button>
        {ptFile && (
          <button className="btn" onClick={() => doSave('pkt', true)} title="Save back to Packet Tracer format">
            Export .pkt
          </button>
        )}
        <div className="sep" />
        <button className="btn icon" disabled={!past.length} onClick={() => useStore.getState().undo()} title="Undo (Ctrl Z)">
          <I.undo size={16} />
        </button>
        <button className="btn icon" disabled={!future.length} onClick={() => useStore.getState().redo()} title="Redo (Ctrl Shift Z)">
          <I.redo size={16} />
        </button>
        <div className="spacer" />
        <button className="btn outline" style={{ width: 260, justifyContent: 'space-between', color: 'var(--text-3)' }} onClick={() => set({ palette: true })}>
          <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
            <I.search size={15} /> Search or run a command
          </span>
          <span className="kbd">Ctrl K</span>
        </button>
        <div className="spacer" />
        <div className="segmented" title="Ctrl M">
          <button className={mode === 'realtime' ? 'on' : ''} onClick={() => set({ mode: 'realtime', flight: null })}>
            Realtime
          </button>
          <button className={mode === 'simulation' ? 'on sim' : ''} onClick={() => set({ mode: 'simulation', flight: null, bottomOpen: true })}>
            Simulation
          </button>
        </div>
        <button className="btn icon" title="Theme" onClick={() => set({ theme: theme === 'dark' ? 'light' : 'dark' })}>
          {theme === 'dark' ? <I.sun size={16} /> : <I.moon size={16} />}
        </button>
      </header>

      <Library />
      <Canvas />
      <BottomPanel />
      <Inspector />

      <footer className="statusbar">
        <span className={mode === 'simulation' ? 'mode-sim' : ''}>{mode === 'simulation' ? '● Simulation' : '● Realtime'}</span>
        <span>
          {project.devices.length} devices · {project.links.length} cables
        </span>
        {project.ptVersion && <span>Packet Tracer {project.ptVersion}</span>}
        <span className="spacer" />
        <span>{isTauri() ? 'Desktop' : 'Browser preview'}</span>
      </footer>

      {palette && <Palette commands={commands} />}
      {notice && (
        <div className="overlay" onPointerDown={() => setNotice(null)}>
          <div className="dialog" onPointerDown={(e) => e.stopPropagation()}>
            <h3>{notice.title}</h3>
            <p>{notice.body}</p>
            {notice.items && (
              <ul>
                {notice.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
            <div className="actions">
              <button className="btn primary" onClick={() => setNotice(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
      <Toasts />
    </div>
  );
}
