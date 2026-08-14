// Settings v2 (plan Task 21) — ported from the legacy src/screens/
// SettingsScreen.tsx: licence status, the admin-unlock flow, the admin-only
// licence manager + briefing recipients, the BYOK AI key (inverse-gated,
// non-admin only), notifications, theme and install.
//
// OWNER DECISION D11 (hard rule): NO broker-integration rows of any kind —
// no broker connect, no key pair, nothing. This file imports neither the
// legacy broker-connect component nor any of its API calls, and
// Settings.test.tsx greps this very file's source for the broker's number
// so the rule can never regress silently (which is why this comment spells
// it out in words).

import { AdminUnlock, LicenceManager, LicenceStatusRow, useIsAdmin } from './parts/SettingsAdmin'
import { AppearanceGroup, ByoAiKey, NotificationRow, ReportRecipients } from './parts/SettingsExtras'
import { InstallRow } from './parts/InstallRow'

export default function Settings() {
  const { isAdmin, licences, reload } = useIsAdmin()

  return (
    <div className="set2">
      <h1>Settings</h1>

      <LicenceStatusRow isAdmin={isAdmin} />

      <AppearanceGroup />

      <NotificationRow />

      <ByoAiKey isAdmin={isAdmin} />

      {isAdmin === false && <AdminUnlock />}
      {isAdmin === true && (
        <>
          <LicenceManager licences={licences} reload={reload} />
          <ReportRecipients />
        </>
      )}

      <section className="menu-group">
        <div className="menu-title">App</div>
        <InstallRow />
      </section>
    </div>
  )
}
