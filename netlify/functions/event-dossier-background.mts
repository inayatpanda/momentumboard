import { blobAppStore } from './lib/store'
import { authenticate } from './lib/auth'
import { fetchYahooChart } from './lib/yahoo'
import { MACRO_ASSETS, shockAnalogues, type MacroEvent } from './lib/macroEvents'
import { callLlm } from './ai-insights.mts'
import { sendTelegram } from './lib/telegram'

// Background (15-min budget): when the sentinel detects a macro shock or an
// unsustainable stretch, this composes the full event dossier — measured
// analogues, an informed magnitude guess, and the instrument playbook — then
// pings Telegram and stores it for the Research screen.

export default async (req: Request) => {
  const auth = await authenticate(req.headers, { APP_TOKEN: process.env.APP_TOKEN }, blobAppStore)
  if (auth?.level !== 'admin') return new Response('admin-only', { status: 401 })

  const event = (await req.json()) as MacroEvent
  const asset = MACRO_ASSETS.find(a => a.sym === event.sym)
  if (!asset) return new Response('unknown-asset', { status: 400 })

  const nowSec = Math.floor(Date.now() / 1000)
  try {
    const { candles, quote } = await fetchYahooChart(asset.sym, '5y')
    const movePct = event.kind === 'shock' ? event.movePct : 0
    const analogues = event.kind === 'shock' ? shockAnalogues(candles, movePct, event.dir) : null

    const { fetchSymbolNews } = await import('./lib/news')
    const news = await fetchSymbolNews(asset.sym, process.env.FINNHUB_API_KEY ?? '', nowSec, fetch, asset.name).catch(() => [])

    const prompt =
      event.kind === 'shock'
        ? `You are a seasoned macro-equity strategist. ${asset.name} moved ${movePct}% today (now ${quote.price}). Headlines: ${news.slice(0, 4).map(n => n.title).join(' | ') || 'none found'}.
MEASURED HISTORY (${analogues!.n} comparable ${event.dir}-moves in 5 years): median further move next 5 sessions ${analogues!.median5}%, 75th percentile ${analogues!.p75_5}%, median 20-session ${analogues!.median20}%, most extreme 5-session extension ${analogues!.maxExt5}%.
Write the event assessment for a UK swing trader (Trading 212 ISA, LSE leveraged/inverse ETPs available: ${asset.etps}):
1. WHAT HAPPENED and the most likely driver (from headlines).
2. INFORMED MAGNITUDE GUESS: ground it in the analogue numbers above — give a base case and a stretch case with the historical odds.
3. EQUITY PLAYBOOK: who benefits, who bleeds (${event.dir === 'up' ? asset.watch.up : asset.watch.down}); the 2-3 most actionable tickers with WHY.
4. THE OTHER SIDE: at what point does this become an unsustainable extreme worth fading via ${asset.etps}, and what would signal that moment.
Max 250 words. Decisive, numbered reasons, one honesty line at the end.`
        : `You are a seasoned macro-equity strategist. ${asset.name} is STRETCHED: ${event.zScore} standard deviations from its 90-session mean, RSI ${event.rsi} (now ${quote.price}). Headlines: ${news.slice(0, 3).map(n => n.title).join(' | ') || 'none'}.
For a UK swing trader with LSE inverse ETPs available (${asset.etps}): assess the mean-reversion case — extremes like this are historically unsustainable, but timing the turn is the hard part. Give: 1) how stretched this is vs history, 2) the reversion trade and its trigger (do NOT fade a freight train without a reversal signal — specify what to wait for), 3) sizing discipline for a leveraged inverse ETP (max ~5 sessions, decay), 4) what invalidates the fade. Max 200 words, decisive, one honesty line.`

    const { text } = await callLlm(prompt, { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL, GROQ_API_KEY: process.env.GROQ_API_KEY })

    const dossiers = (await blobAppStore.read<unknown[]>('event-dossiers')) ?? []
    dossiers.push({ ...event, price: quote.price, analogues, assessment: text.trim(), at: nowSec })
    await blobAppStore.write('event-dossiers', dossiers.slice(-10))

    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      const headline =
        event.kind === 'shock'
          ? `⚡ MACRO EVENT: ${asset.name} ${movePct > 0 ? '+' : ''}${movePct}% — full assessment ready`
          : `🎈 STRETCHED: ${asset.name} at ${event.zScore}σ, RSI ${event.rsi} — reversion assessment ready`
      await sendTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, `${headline}\n\n${text.trim().slice(0, 900)}`).catch(() => {})
    }
    return new Response('ok')
  } catch (e) {
    return new Response(String(e), { status: 502 })
  }
}
