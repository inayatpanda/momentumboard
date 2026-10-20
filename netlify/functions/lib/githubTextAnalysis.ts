import type { LlmEnv, LlmResult } from './llm'
import type { AppStore } from './storeProvider'
import { reserveSocialBudget } from './socialBudget'

export class GithubTextBudgetWait extends Error {
  constructor(public retryAfterSec: number) { super('video-text-fallback-capped') }
}

/** The new cloud lane cannot take the morning paper's first claim on shared
 * free quotas. DeepSeek remains primary; shared text fallbacks get at most two
 * bounded section requests a day, after 08:00 UTC. No video-watch calls here. */
export async function githubTextAnalysis(
  prompt: string, store: AppStore, env: LlmEnv,
  call: (prompt: string, env: LlmEnv) => Promise<LlmResult>,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<LlmResult> {
  try {
    return await call(prompt, {
      strict: true, LLM_PROVIDER: 'openai', maxTokens: 4000,
      OPENAI_API_KEY: env.OPENAI_API_KEY, OPENAI_BASE_URL: env.OPENAI_BASE_URL, OPENAI_MODEL: env.OPENAI_MODEL,
    })
  } catch (error) {
    if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY) throw error
    const todayEight = Math.floor(nowSec / 86400) * 86400 + 8 * 3600
    if (nowSec < todayEight || !await reserveSocialBudget(store, 'github-text', nowSec)) {
      throw new GithubTextBudgetWait((nowSec < todayEight ? todayEight : todayEight + 86400) - nowSec)
    }
    return call(prompt, {
      strict: true, maxTokens: 4000,
      GROQ_API_KEY: env.GROQ_API_KEY, GROQ_MODEL: env.GROQ_MODEL,
      GEMINI_API_KEY: env.GEMINI_API_KEY, GEMINI_MODEL: env.GEMINI_MODEL,
      GOOGLE_GEMINI_BASE_URL: env.GOOGLE_GEMINI_BASE_URL,
    })
  }
}
