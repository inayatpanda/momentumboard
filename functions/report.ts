// Cloudflare Pages Functions — `/report`.
//
// netlify.toml redirects `/report` to the report function; it sits outside
// /api/ because it is a reader-facing URL (the morning paper), and the Pages
// catch-all under functions/api/ cannot see it. Same shared router.

import { pagesHandler, type PagesContext } from '../netlify/functions/lib/router'

export const onRequest = (ctx: PagesContext): Promise<Response> => pagesHandler(ctx)
