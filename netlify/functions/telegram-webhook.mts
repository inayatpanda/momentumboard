import type { Context } from '@netlify/functions'
import { blobAppStore, type AppStore } from './lib/store'
import { sendTelegram } from './lib/telegram'
import { parseCallText, toExtract, type PunditExtract } from './lib/punditCalls'
import { addLicenceVerified, generateLicenceKey, readLicencesFresh, type Licence } from './lib/auth'
import { CANONICAL_SITE } from './lib/site'

/** Two-way Telegram commands: /status /portfolio /mute [hours] /unmute /report
 * /call /key /revoke. Authenticated via Telegram's secret_token header (set at
 * webhook registration) AND pinned to the owner's chat id — which is what makes
 * the licence-minting commands safe to expose here. */
export async function routeTelegramWebhook(
  headers: Headers,
  bodyText: string | null,
  env: { REPORT_TOKEN?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string; URL?: string },
  store: AppStore,
  send: typeof sendTelegram = sendTelegram,
): Promise<Response> {
  if (!env.REPORT_TOKEN || headers.get('x-telegram-bot-api-secret-token') !== env.REPORT_TOKEN) {
    return new Response('unauthorized', { status: 401 })
  }
  const update = bodyText ? (JSON.parse(bodyText) as { message?: { chat?: { id: number }; text?: string } }) : null
  const chatId = String(update?.message?.chat?.id ?? '')
  const rawText = (update?.message?.text ?? '').trim() // ticker parsing needs the RAW case
  const text = rawText.toLowerCase()
  // only answer the owner's chat
  if (!chatId || chatId !== env.TELEGRAM_CHAT_ID || !env.TELEGRAM_BOT_TOKEN) return new Response('ok')

  const reply = (msg: string) => send(env.TELEGRAM_BOT_TOKEN!, chatId, msg).catch(() => {})
  const nowSec = Math.floor(Date.now() / 1000)

  if (text.startsWith('/status')) {
    const runlog = ((await store.read<{ at: number; events: number; sent: number; errors: string[] }[]>('runlog')) ?? []).slice(-1)[0]
    const mute = (await store.read<number>('mute-until')) ?? 0
    await reply(
      runlog
        ? `Last check ${Math.round((nowSec - runlog.at) / 60)} min ago · ${runlog.events} events · ${runlog.sent} sent${runlog.errors.length ? ` · errors: ${runlog.errors.join('; ')}` : ''}${mute > nowSec ? `\n🔇 muted for another ${Math.round((mute - nowSec) / 60)} min` : ''}`
        : 'No runs logged yet.',
    )
  } else if (text.startsWith('/portfolio')) {
    const p = await store.read<{ capital: number; openPositions: { symbol: string; positionValue: number; entryPrice: number; stop: number }[]; stats: { realizedPnl: number; winRate: number | null } }>('portfolio')
    await reply(
      p && p.openPositions.length
        ? `Open: ${p.openPositions.map(o => `${o.symbol} £${o.positionValue.toFixed(0)} (stop ${o.stop})`).join(' · ')}\nRealised P&L £${p.stats.realizedPnl.toFixed(0)}${p.stats.winRate != null ? ` · win ${Math.round(p.stats.winRate * 100)}%` : ''}`
        : 'Journal is empty — log trades in the app.',
    )
  } else if (text.startsWith('/mute')) {
    const hours = Math.min(24, Math.max(0.5, parseFloat(text.split(/\s+/)[1]) || 2))
    await store.write('mute-until', nowSec + hours * 3600)
    await reply(`🔇 Alerts muted for ${hours}h. /unmute to resume.`)
  } else if (text.startsWith('/unmute')) {
    await store.write('mute-until', 0)
    await reply('🔔 Alerts resumed.')
  } else if (text.startsWith('/report')) {
    await reply(`📰 ${CANONICAL_SITE}/report`)
  } else if (text.startsWith('/call')) {
    // log a pundit's forwarded stock call into the graded channel-stance store
    const { name, tickers } = parseCallText(rawText) // RAW text — not the lowercased copy
    if (name && tickers.length) {
      const extracts = (await store.read<PunditExtract[]>('video-extracts')) ?? []
      extracts.push(toExtract(name, tickers, nowSec, 'telegram-bridge'))
      await store.write('video-extracts', extracts.slice(-400))
      await reply(`logged: ${name} — ${tickers.map(t => `${t.sym} ${t.stance}`).join(', ')}`)
    } else {
      await reply('Usage: /call obi $TSLA long [$PLTR short] or /call obi <forwarded text>')
    }
  } else if (text === '/key' || text.startsWith('/key ')) {
    // mint a full (non-expiring) licence from the Helm chat: /key <label>
    // (exact-prefix match so /keys falls through to the list command below)
    const label = rawText.split(/\s+/).slice(1).join(' ').slice(0, 40)
    if (!label) {
      await reply('Usage: /key <label> — e.g. /key PK. Mints a lifetime licence and replies with its unlock link.')
    } else {
      const licences = await readLicencesFresh(store)
      if (licences.filter(l => !l.revoked && !l.trial).length >= 25) {
        await reply('Licence cap reached (25 active) — /revoke one first.')
      } else {
        const lic: Licence = { key: generateLicenceKey(), label, createdAt: nowSec }
        // verified add — plain read-push-write lost keys to stale replicas (2026-07-11)
        if (await addLicenceVerified(store, lic)) {
          await reply(`🔑 ${label} — one tap unlocks their device for life:\n${CANONICAL_SITE}/?key=${lic.key}\n/revoke ${label} kills it later.`)
        } else {
          await reply(`⚠️ Mint for "${label}" did not persist — try again.`)
        }
      }
    }
  } else if (text.startsWith('/revoke')) {
    const q = rawText.split(/\s+/).slice(1).join(' ').trim().toLowerCase()
    if (!q) {
      await reply('Usage: /revoke <label or key prefix>')
    } else {
      const licences = await readLicencesFresh(store)
      const matches = licences.filter(l => !l.revoked && (l.label.toLowerCase() === q || l.key.toLowerCase().startsWith(q)))
      if (!matches.length) {
        await reply(`No active licence matches "${q}". /keys lists them.`)
      } else if (matches.length > 1) {
        await reply(`Ambiguous — ${matches.length} active licences match: ${matches.map(m => m.label).join(', ')}. Revoke by key prefix instead.`)
      } else {
        matches[0].revoked = true
        await store.write('licences', licences)
        await reply(`🚫 Revoked "${matches[0].label}". Takes ~1 min to bite on their device.`)
      }
    }
  } else if (text.startsWith('/house')) {
    // flip a licence's house flag: the owner's own devices get the server's AI
    // keys (Ask the desk etc.) without holding the admin token; plain licensees
    // keep bringing their own key. Toggle, so /house <label> twice undoes it.
    const q = rawText.split(/\s+/).slice(1).join(' ').trim().toLowerCase()
    if (!q) {
      await reply('Usage: /house <label or key prefix> — toggles server-key AI access for that licence (your own devices).')
    } else {
      const licences = await readLicencesFresh(store)
      const matches = licences.filter(l => !l.revoked && (l.label.toLowerCase() === q || l.key.toLowerCase().startsWith(q)))
      if (!matches.length) {
        await reply(`No active licence matches "${q}". /keys lists them.`)
      } else if (matches.length > 1) {
        await reply(`Ambiguous — ${matches.length} active licences match: ${matches.map(m => m.label).join(', ')}. Use a key prefix.`)
      } else {
        matches[0].house = !matches[0].house
        await store.write('licences', licences)
        await reply(matches[0].house ? `🏠 "${matches[0].label}" is now a house licence — AI features use the server's keys.` : `👤 "${matches[0].label}" is a plain licence again — AI needs their own key.`)
      }
    }
  } else if (text.startsWith('/keys')) {
    const licences = await readLicencesFresh(store)
    const active = licences.filter(l => !l.revoked)
    await reply(
      active.length
        ? active.map(l => `${l.trial ? '⏳' : l.house ? '🏠' : '🔑'} ${l.label} · ${l.key.slice(0, 10)}…${l.expiresAt ? ` · expires ${new Date(l.expiresAt * 1000).toISOString().slice(0, 10)}` : ''}`).join('\n')
        : 'No active licences.',
    )
  } else if (text.startsWith('/')) {
    await reply('Commands: /status /portfolio /mute [hours] /unmute /report /call /key <label> /keys /revoke <label> /house <label>')
  }
  return new Response('ok')
}

export default async (req: Request, _context: Context) =>
  routeTelegramWebhook(
    req.headers,
    await req.text(),
    {
      REPORT_TOKEN: process.env.REPORT_TOKEN,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
      URL: process.env.URL,
    },
    blobAppStore,
  )
