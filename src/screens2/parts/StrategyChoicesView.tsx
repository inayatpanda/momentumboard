import { getStrategyChoices } from '../../lib/apiViews'
import { useSlice } from '../../lib/useSlice'
import { StrategyChoices } from './StrategyChoices'

export default function StrategyChoicesView() {
  const { data, error, refresh, refreshing } = useSlice('strategy-choices', getStrategyChoices)
  return <StrategyChoices snapshot={data?.snapshot} historicalStudy={data?.historicalStudy} error={error} onRefresh={refresh} refreshing={refreshing} />
}
