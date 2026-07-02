// One consistent icon family (Lucide-style strokes) replacing emoji glyphs.
const I = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: '-2px' }}>
    <path d={d} />
  </svg>
)

export const IconGear = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)
export const IconNews = ({ size = 16 }: { size?: number }) => <I size={size} d="M4 5h13v14H6a2 2 0 01-2-2V5zm13 4h3v8a2 2 0 01-2 2M7 9h7M7 13h7M7 17h4" />
export const IconLandmark = ({ size = 16 }: { size?: number }) => <I size={size} d="M3 21h18M4 18h16M6 18v-7m4 7v-7m4 7v-7m4 7v-7M3 8l9-5 9 5z" />
export const IconCalendar = ({ size = 16 }: { size?: number }) => <I size={size} d="M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zM8 3v4m8-4v4M3 10h18" />
export const IconBell = ({ size = 16 }: { size?: number }) => <I size={size} d="M6 9a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6m4 9a2 2 0 004 0" />
export const IconShare = ({ size = 16 }: { size?: number }) => <I size={size} d="M12 3v12m0-12L8 7m4-4l4 4M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" />
export const IconBack = ({ size = 18 }: { size?: number }) => <I size={size} d="M15 18l-6-6 6-6" />
export const IconPlay = ({ size = 13 }: { size?: number }) => <I size={size} d="M7 5l12 7-12 7z" />
export const IconTarget = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </svg>
)
export const IconPin = ({ size = 13 }: { size?: number }) => <I size={size} d="M12 17v5m-5-9l1.5-6.5h7L17 13m-10 0h10l-1 2H8z" />
export const IconSwap = ({ size = 15 }: { size?: number }) => <I size={size} d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4" />
