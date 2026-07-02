export async function sendTelegram(botToken: string, chatId: string, text: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  })
  const j = (await res.json()) as { ok: boolean; description?: string }
  if (!j.ok) throw new Error(`telegram: ${j.description ?? res.status}`)
}
