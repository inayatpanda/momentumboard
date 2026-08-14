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
  { path: '/more', key: 'more', label: 'More', component: lazy(() => import('../screens2/More')) },
  { path: '/more/research', key: 'more', component: lazy(() => import('../screens2/Research2')) },
  { path: '/more/calendar', key: 'more', component: lazy(() => import('../screens2/Calendar2')) },
  { path: '/more/gates', key: 'more', component: lazy(() => import('../screens2/GatesLearning')) },
  { path: '/settings', key: 'more', component: lazy(() => import('../screens2/Settings')) },
] as const

export const NAV_ROUTES = ROUTES.filter(r => r.label)
