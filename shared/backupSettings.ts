/** Only non-secret preferences belong in a journal backup. Unknown settings
 * stay on the device so future credentials cannot silently become backups. */
const BACKUP_SETTINGS = new Set(['capital', 'ytChannels', 'lastSeen'])

export function backupSettings(rows: unknown): { key: string; value: string }[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap(row => row && typeof row === 'object' &&
    typeof row.key === 'string' && BACKUP_SETTINGS.has(row.key) && typeof row.value === 'string'
    ? [{ key: row.key, value: row.value }] : [])
}
