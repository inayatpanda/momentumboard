// Cloudflare Pages Functions — `/report`.
//
// netlify.toml redirects `/report` to the report function; it sits outside
// /api/ because it is a reader-facing URL (the morning paper), and the Pages
// catch-all under functions/api/ cannot see it. Same shared router.

import { pagesHandler, type PagesContext } from '../netlify/functions/lib/router'
import { withCors } from './cors'

// withCors: the desktop shell reads the paper cross-origin (Intel's
// ?format=json fetch) — same exact-match Tauri allow-list as /api/*.
export const onRequest = withCors((ctx: PagesContext) => pagesHandler(ctx))
