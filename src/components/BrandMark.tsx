/** One vector identity shared by the app shell and installed app icons. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return <img className="brand-mark" src="/icon.svg?v=signal-20261020" width={size} height={size} alt="" aria-hidden="true" />
}
