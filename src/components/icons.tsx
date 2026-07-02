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
export const IconFlame = ({ size = 13 }: { size?: number }) => <I size={size} d="M12 22c4 0 7-3 7-7 0-3-2-5-3.5-7C14 6 13 4 13 2c-3 2-4 5-4 7-1-1-1.5-2-1.5-3.5C5.5 7.5 5 10 5 12c0 4 3 10 7 10z" />
export const IconWarn = ({ size = 14 }: { size?: number }) => <I size={size} d="M12 3L2 20h20L12 3zm0 7v4m0 3v.5" />
export const IconSun = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)
export const IconMoon = ({ size = 14 }: { size?: number }) => <I size={size} d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z" />
export const IconSparkle = ({ size = 13 }: { size?: number }) => <I size={size} d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8L19 17z" />
export const IconBalloon = ({ size = 13 }: { size?: number }) => <I size={size} d="M12 2a7 7 0 017 7c0 4-3 8-7 8s-7-4-7-8a7 7 0 017-7zm0 15l-1 2h2l-1 2" />

/** Alert texts carry emoji for Telegram; the app renders them clean. */
export const stripEmoji = (s: string) => s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim()
