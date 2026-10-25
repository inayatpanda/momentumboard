import { getStrategyChoices } from '../../lib/apiViews'
import { useSlice } from '../../lib/useSlice'
import { SellReview } from './SellReview'

export default function SellReviewView({ watchSymbols, watchLoaded }: { watchSymbols: string[]; watchLoaded: boolean }) {
  const { data, error, refresh, refreshing } = useSlice('strategy-choices', getStrategyChoices)
  return <SellReview snapshot={data?.snapshot?.sellReview} watchSymbols={watchSymbols} watchLoaded={watchLoaded} error={error} onRefresh={refresh} refreshing={refreshing} />
}
