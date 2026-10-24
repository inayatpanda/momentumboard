// Stocks opens with the entry chunk. Today is the second navigation tab;
// /stocks remains an alias so existing saved links keep working.
// `label` present ⇒ a nav tab; Board is deliberately unlabelled (reached from
// Today's counts rail and the desktop board column).

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import Stocks from '../screens2/Stocks'

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
  { path: '/', key: 'stocks', label: 'Stocks', component: Stocks },
  { path: '/today', key: 'today', label: 'Today', component: lazy(() => import('../screens2/Today')) },
  { path: '/board', key: 'today', component: lazy(() => import('../screens2/Board')) },
  { path: '/stocks', key: 'stocks', component: Stocks },
  { path: '/stocks/movers', key: 'stocks', component: lazy(() => import('../screens2/Movers')) },
  { path: '/stocks/sectors', key: 'stocks', component: lazy(() => import('../screens2/Sectors')) },
  { path: '/stock/:sym', key: 'stocks', component: lazy(() => import('../screens2/StockPage')) as RouteDef['component'] },
  { path: '/intel', key: 'intel', label: 'News', component: lazy(() => import('../screens2/Intel')) },
  { path: '/record', key: 'record', label: 'Results', component: lazy(() => import('../screens2/Record')) },
  // ANALYTICS, on the rail only for now: the screen is routed and reachable at
  // ≥1024px, and the phone's ratified five are untouched until the tab lands.
  { path: '/analytics', key: 'more', label: 'Analytics', railOnly: true, component: lazy(() => import('../screens2/Analytics')) },
  // the four promoted onto the desktop rail, BEFORE More so they read as
  // siblings of the ratified tabs rather than as an afterthought below it.
  // Owner 2026-08-17 recut the set twice: Gates & learning DEMOTED ("present
  // twice, outside and inside More"), the daily edition promoted into its own
  // fresh tab in that slot ("move… just the Today paper"), and then The street
  // added ("all in a new page/tab altogether") — FIRST of the four, because it
  // is the one the reader will open most.
  { path: '/more/street', key: 'more', label: 'YouTube & social', railOnly: true, component: lazy(() => import('../screens2/Street2')) },
  { path: '/more/research', key: 'more', label: 'Research', railOnly: true, component: lazy(() => import('../screens2/Research2')) },
  { path: '/more/calendar', key: 'more', label: 'Calendar', railOnly: true, component: lazy(() => import('../screens2/Calendar2')) },
  { path: '/more/paper', key: 'more', label: 'Daily report', railOnly: true, component: lazy(() => import('../screens2/Paper2')) },
  { path: '/more/gates', key: 'more', component: lazy(() => import('../screens2/GatesLearning')) },
  { path: '/more', key: 'more', label: 'More', component: lazy(() => import('../screens2/More')) },
  { path: '/settings', key: 'more', component: lazy(() => import('../screens2/Settings')) },
] as const

export const NAV_ROUTES = ROUTES.filter(r => r.label)
