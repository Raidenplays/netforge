import type { DeviceKind } from '../model/types';

type P = { size?: number; className?: string };

const S = ({ size = 24, className, children }: P & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    {children}
  </svg>
);

export const DeviceGlyph = ({ kind, ...p }: P & { kind: DeviceKind }) => {
  switch (kind) {
    case 'router':
      return (
        <S {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 6.5v4M10.3 8.3 12 6.5l1.7 1.8M12 17.5v-4M10.3 15.7 12 17.5l1.7-1.8M6.5 12h4M8.3 10.3 6.5 12l1.8 1.7M17.5 12h-4M15.7 10.3 17.5 12l-1.8 1.7" />
        </S>
      );
    case 'switch':
      return (
        <S {...p}>
          <rect x="2.5" y="6.5" width="19" height="11" rx="2.5" />
          <path d="M6 10.5h8.5M12.5 8.8l2 1.7-2 1.7M18 13.5H9.5M11.5 11.8l-2 1.7 2 1.7" />
        </S>
      );
    case 'pc':
      return (
        <S {...p}>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M9 20h6M12 16v4" />
        </S>
      );
    case 'laptop':
      return (
        <S {...p}>
          <rect x="4.5" y="5" width="15" height="10" rx="1.5" />
          <path d="M2.5 18.5h19l-1.5-3.5h-16z" />
        </S>
      );
    case 'server':
      return (
        <S {...p}>
          <rect x="4" y="3" width="16" height="7.5" rx="1.8" />
          <rect x="4" y="13.5" width="16" height="7.5" rx="1.8" />
          <path d="M7.5 6.75h.01M7.5 17.25h.01M11 6.75h5.5M11 17.25h5.5" />
        </S>
      );
    case 'tablet':
      return (
        <S {...p}>
          <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
          <path d="M11 18.5h2" />
        </S>
      );
    case 'phone':
      return (
        <S {...p}>
          <rect x="7" y="2.5" width="10" height="19" rx="2.2" />
          <path d="M11 18.5h2" />
        </S>
      );
    case 'printer':
      return (
        <S {...p}>
          <path d="M7 8V3.5h10V8" />
          <rect x="3" y="8" width="18" height="8" rx="2" />
          <path d="M7 13.5h10v7H7z" />
        </S>
      );
    case 'homerouter':
      return (
        <S {...p}>
          <rect x="3" y="13" width="18" height="7" rx="2" />
          <path d="M7 16.5h.01M10 16.5h.01M8.5 10a5 5 0 0 1 7 0M6.2 7.6a8.3 8.3 0 0 1 11.6 0M12 12.3v.7" />
        </S>
      );
    case 'cloud':
      return (
        <S {...p}>
          <path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.8 3.8 0 0 1 17.5 18.5z" />
        </S>
      );
    default:
      return (
        <S {...p}>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M9 12h6" />
        </S>
      );
  }
};

export const I = {
  cursor: (p: P) => (
    <S {...p}>
      <path d="m5 3 14 7.5-6.2 1.7L10 19z" />
    </S>
  ),
  cable: (p: P) => (
    <S {...p}>
      <path d="M5 19c0-6 14-8 14-14" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="5" r="2" />
    </S>
  ),
  note: (p: P) => (
    <S {...p}>
      <path d="M5 4h14v11l-5 5H5z" />
      <path d="M14 20v-5h5" />
    </S>
  ),
  envelope: (p: P) => (
    <S {...p}>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </S>
  ),
  open: (p: P) => (
    <S {...p}>
      <path d="M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9.5A1.5 1.5 0 0 0 19.5 8H12l-2-2.5H4.5A1.5 1.5 0 0 0 3 7z" />
    </S>
  ),
  save: (p: P) => (
    <S {...p}>
      <path d="M5 3.5h11l3.5 3.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z" />
      <path d="M7.5 3.5v5h8v-5M7.5 20.5v-6h9v6" />
    </S>
  ),
  plus: (p: P) => (
    <S {...p}>
      <path d="M12 5v14M5 12h14" />
    </S>
  ),
  undo: (p: P) => (
    <S {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </S>
  ),
  redo: (p: P) => (
    <S {...p}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </S>
  ),
  play: (p: P) => (
    <S {...p}>
      <path d="M7 4.5v15l12-7.5z" />
    </S>
  ),
  pause: (p: P) => (
    <S {...p}>
      <path d="M8 5v14M16 5v14" />
    </S>
  ),
  step: (p: P) => (
    <S {...p}>
      <path d="M5 5v14l10-7zM19 5v14" />
    </S>
  ),
  reset: (p: P) => (
    <S {...p}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3.5 4v4.5H8" />
    </S>
  ),
  sun: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </S>
  ),
  moon: (p: P) => (
    <S {...p}>
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" />
    </S>
  ),
  search: (p: P) => (
    <S {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </S>
  ),
  trash: (p: P) => (
    <S {...p}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4h6v3" />
    </S>
  ),
  power: (p: P) => (
    <S {...p}>
      <path d="M12 3v8M6.5 6.5a7.5 7.5 0 1 0 11 0" />
    </S>
  ),
  terminal: (p: P) => (
    <S {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M12.5 15H17" />
    </S>
  ),
  tag: (p: P) => (
    <S {...p}>
      <path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z" />
      <circle cx="8" cy="8" r="1.2" />
    </S>
  ),
  fit: (p: P) => (
    <S {...p}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </S>
  ),
  x: (p: P) => (
    <S {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </S>
  ),
  check: (p: P) => (
    <S {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </S>
  ),
  copy: (p: P) => (
    <S {...p}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
    </S>
  ),
  logo: (p: P) => (
    <svg width={p.size ?? 24} height={p.size ?? 24} viewBox="0 0 32 32" className={p.className}>
      <defs>
        <linearGradient id="nfg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b9dff" />
          <stop offset="1" stopColor="#2fd6b5" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#nfg)" />
      <g stroke="#fff" strokeWidth="2.2" strokeLinecap="round" fill="none">
        <path d="M10 22 16 10l6 12" />
        <circle cx="16" cy="10" r="2.2" fill="#fff" />
        <circle cx="10" cy="22" r="2.2" fill="#fff" />
        <circle cx="22" cy="22" r="2.2" fill="#fff" />
        <path d="M10 22h12" />
      </g>
    </svg>
  ),
};
