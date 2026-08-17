// The v2 route table (plan Task 10 + CX-3/10). Today is EAGER — it is the
// home screen and must paint with the entry chunk; everything else is lazy.
// `label` present ⇒ a nav tab; Board is deliberately unlabelled (reached from
// Today's counts rail and the desktop board column).

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import Today from '../screens2/Today'

export interface RouteDef {
  path: string
  /** nav highlight group — which tab lights up while this route is active */
  key: 'today' | 'stocks' | 'intel' | 'record' | 'more'
  label?: string
  /** A LABEL THE LEFT RAIL SHOWS AND THE PHONE NEVER DOES (owner iteration 2:
   * "More section - we can bring more sections from it into main tabs shown
   * outside on Nav bar"). The desktop rail has vertical room the phone's five
   * ratified tabs do not, so these three are promoted out of More there and
   * hidden below 1024px by CSS alone — no JS width check, so the phone bar is
   * byte-identical to what was ratified. `key` stays 'more', which is what
   * keeps the phone's More tab lighting up inside these pages.  */
  railOnly?: true
  component: ComponentType<Record<string, never>> | LazyExoticComponent<ComponentType<Record<string, never>>> | ComponentType<{ sym: string }>
}

export const ROUTES: readonly RouteDef[] = [
  { path: '/', key: 'today', label: 'Today', component: Today },
  { path: '/board', key: 'today', component: lazy(() => import('../screens2/Board')) },
  { path: '/stocks', key: 'stocks', label: 'Stocks', component: lazy(() => import('../screens2/Stocks')) },
  { path: '/stocks/movers', key: 'stocks', component: lazy(() => import('../screens2/Movers')) },
  { path: '/stocks/sectors', key: 'stocks', component: lazy(() => import('../screens2/Sectors')) },
  { path: '/stock/:sym', key: 'stocks', component: lazy(() => import('../screens2/StockPage')) as RouteDef['component'] },
  { path: '/intel', key: 'intel', label: 'Intel', component: lazy(() => import('../screens2/Intel')) },
  { path: '/record', key: 'record', label: 'Track record', component: lazy(() => import('../screens2/Record')) },
  // the three promoted onto the desktop rail, BEFORE More so they read as
  // siblings of the ratified tabs rather than as an afterthought below it.
  // Owner 2026-08-17 recut the trio: Gates & learning DEMOTED ("present
  // twice, outside and inside More"), and the daily edition promoted into
  // its own fresh tab in that slot ("move… just the Today paper").
  { path: '/more/research', key: 'more', label: 'Research', railOnly: true, component: lazy(() => import('../screens2/Research2')) },
  { path: '/more/calendar', key: 'more', label: 'Calendar', railOnly: true, component: lazy(() => import('../screens2/Calendar2')) },
  { path: '/more/paper', key: 'more', label: 'The paper', railOnly: true, component: lazy(() => import('../screens2/Paper2')) },
  { path: '/more/gates', key: 'more', component: lazy(() => import('../screens2/GatesLearning')) },
  { path: '/more', key: 'more', label: 'More', component: lazy(() => import('../screens2/More')) },
  { path: '/settings', key: 'more', component: lazy(() => import('../screens2/Settings')) },
] as const

export const NAV_ROUTES = ROUTES.filter(r => r.label)
