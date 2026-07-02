// GradeChip — a rounded chip for the engine's letter grades.
//
// A letter (A/B/C) in a rounded pill with simple per-grade colour coding:
// green-tinted A (a positive market grade), amber B, neutral C. Reads as
// data, not a button. Styles live in index.css (`.grade-chip` and friends).
//
// Props:
//   grade        the letter to show: 'A' | 'B' | 'C' (any other string
//                falls back to the neutral "C" treatment).
//   provisional  when true, appends a small "prov" tag — the thin-evidence
//                bucket whose grade isn't yet fully earned.
//   shadow       when true, renders the chip ghosted + dashed — a shadow /
//                "what-if" grade rather than a live, actionable call.
//   title        optional tooltip text (e.g. why the grade landed here).
//   className    optional extra classes for layout/spacing at the call site.

export interface GradeChipProps {
  grade: string
  provisional?: boolean
  shadow?: boolean
  title?: string
  className?: string
}

export function GradeChip({ grade, provisional, shadow, title, className }: GradeChipProps) {
  const key = grade.trim().toUpperCase()
  const tone = key === 'A' ? 'g-a' : key === 'B' ? 'g-b' : 'g-c'
  const classes = ['grade-chip', tone, shadow ? 'is-shadow' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return (
    <span className={classes} title={title} aria-label={`Grade ${key}${provisional ? ', provisional' : ''}${shadow ? ', shadow' : ''}`}>
      <span aria-hidden="true">{key}</span>
      {provisional && <span className="prov" aria-hidden="true">prov</span>}
    </span>
  )
}
