/** Shape only; the server authenticates the signature. Never use this helper
 * to grant permissions. The random identifier scopes a device's local data. */
export function freeDeviceId(token:string|null|undefined):string|null {
  return token?.match(/^ss_free_v1\.([a-f0-9]{48})\.[a-f0-9]{64}$/)?.[1]??null
}
export function deviceDatabaseName(token:string|null|undefined):string {
  const id=freeDeviceId(token)
  return id?`momentumboard-free-${id}`:'momentumboard'
}
