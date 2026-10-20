import { NATIVE_VIDEO_MODEL } from './nativeVideo'

/** Reuse independently captured words. No video minutes or paid model fallback. */
export async function readFreeVideoText(prompt: string, key: string, fetchFn = fetch): Promise<string> {
  if (!key) throw new Error('native-configuration')
  const response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${NATIVE_VIDEO_MODEL}:generateContent`, {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 8000, thinkingConfig: { thinkingLevel: 'MINIMAL' },
        responseSchema: { type: 'OBJECT', required: ['tickers', 'themes'], properties: {
          themes: { type: 'ARRAY', items: { type: 'STRING' } },
          tickers: { type: 'ARRAY', items: { type: 'OBJECT', required: ['sym', 'stance', 'evidenceQuote'], properties: {
            sym: { type: 'STRING' }, company: { type: 'STRING', nullable: true },
            stance: { type: 'STRING', enum: ['bull', 'bear', 'neutral'] }, evidenceQuote: { type: 'STRING' },
            thesis: { type: 'STRING' }, condition: { type: 'STRING', nullable: true }, horizon: { type: 'STRING', nullable: true }, hype: { type: 'BOOLEAN' },
            levels: { type: 'ARRAY', items: { type: 'NUMBER' } },
            priceLevels: { type: 'ARRAY', items: { type: 'OBJECT', properties: { kind: { type: 'STRING' }, value: { type: 'NUMBER' }, quote: { type: 'STRING' } } } },
            facts: { type: 'ARRAY', items: { type: 'OBJECT', properties: { metric: { type: 'STRING' }, value: { type: 'NUMBER' }, unit: { type: 'STRING' }, periodStart: { type: 'STRING' }, periodEnd: { type: 'STRING' }, quote: { type: 'STRING' } } } },
          } } },
        } },
      } }),
  })
  if (!response.ok) throw new Error(`native-http-${response.status}`)
  const data = await response.json() as { candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[] }
  const candidate = data.candidates?.[0]
  if (candidate?.finishReason !== 'STOP') throw new Error('native-incomplete-text')
  return candidate.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('') ?? ''
}
