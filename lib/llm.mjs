// lib/llm.mjs — LLM provider adapter for sizmo ask. Zero new deps: Node 22 built-in fetch.
// Anthropic (claude-haiku-4-5-20251001) + OpenAI (gpt-4o-mini). Returns parsed JSON only.

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 20_000;

export async function callLlm({ apiKey, provider = 'anthropic', systemPrompt, userMessage }) {
  if (!apiKey) throw new Error('no AI key — run: sizmo config set --profile <name> --ai-key <key>');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return provider === 'openai'
      ? await callOpenAI({ apiKey, systemPrompt, userMessage, signal: ac.signal })
      : await callAnthropic({ apiKey, systemPrompt, userMessage, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function callAnthropic({ apiKey, systemPrompt, userMessage, signal }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`); }
  const d = await r.json();
  return parseJson(d?.content?.[0]?.text ?? '');
}

async function callOpenAI({ apiKey, systemPrompt, userMessage, signal }) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL, max_tokens: 512,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`OpenAI ${r.status}: ${t.slice(0, 200)}`); }
  const d = await r.json();
  return parseJson(d?.choices?.[0]?.message?.content ?? '');
}

function parseJson(text) {
  const s = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch { throw new Error(`LLM returned non-JSON: ${text.slice(0, 200)}`); }
}
