// The one line a script calls before touching the store.
//
// Selection and validation live in storeProvider (the seam every handler reads
// through); the remote client lives in httpD1 (Node-only — it reads wrangler's
// token off disk). This glue exists so scripts/bg/ can't wire them together
// differently from each other: STORE_BACKEND=d1 → the HTTP client, anything
// else → storeProvider's own blobs-or-throw rules.

import { configureStoreForNodeProcess, type StoreBackendKind } from '../../netlify/functions/lib/storeProvider'

export async function configureStoreForScript(): Promise<StoreBackendKind> {
  if (process.env.STORE_BACKEND?.toLowerCase() === 'd1') {
    const { openHttpD1FromEnv } = await import('./httpD1')
    return configureStoreForNodeProcess(openHttpD1FromEnv())
  }
  return configureStoreForNodeProcess()
}
