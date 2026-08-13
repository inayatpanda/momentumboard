// Cloudflare Pages Functions — `/download/*`.
//
// netlify.toml rewrites `/download/*` to `download?platform=:splat`. The shared
// router performs the identical splat-to-query lift (PREFIX_ROUTES), so the
// handler receives a byte-identical Request on either host.

import { pagesHandler, type PagesContext } from '../../netlify/functions/lib/router'

export const onRequest = (ctx: PagesContext): Promise<Response> => pagesHandler(ctx)
