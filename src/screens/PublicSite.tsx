import { Landing } from './Landing'
import { EnginePage, FaqPage, LedgerPage, PaperPage, PrivacyPage, siteRouteFor } from './SitePages'
import '../styles/public-site.css'

export default function PublicSite({ licensed, onUnlocked }: { licensed: boolean; onUnlocked: () => void }) {
  const page = siteRouteFor(location.pathname)
  if (page === 'engine') return <EnginePage />
  if (page === 'paper') return <PaperPage />
  if (page === 'ledger') return <LedgerPage />
  if (page === 'faq') return <FaqPage />
  if (page === 'privacy') return <PrivacyPage />
  return <Landing licensed={licensed} onUnlocked={onUnlocked} />
}
