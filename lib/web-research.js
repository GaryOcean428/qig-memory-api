// Live web research via the Tavily API (https://docs.tavily.com).
//
// Two capabilities, mirroring the Tavily REST surface:
//   search(...)  → POST /search   — find sources for a query
//   extract(...) → POST /extract  — pull full page content from known URLs
//
// Results are trimmed before they reach a model: Tavily's raw_content can be
// hundreds of KB per page, and the helper agent runs on a bounded step budget.
// Failures return a shaped { error, message } instead of throwing so one bad
// lookup degrades an answer rather than aborting the whole agent run.

const TAVILY_API = 'https://api.tavily.com';
const SEARCH_CONTENT_CHARS = 1_200;
const EXTRACT_CONTENT_CHARS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;

// Two spellings are accepted because this project carries both: the hand-set
// TAVILY_API_KEY and `tavilyApiKey`, the name a Vercel Marketplace Tavily
// integration injects. Same precedent as GITHUB_TOKEN / GH_TOKEN elsewhere.
function tavilyKey() {
  return process.env.TAVILY_API_KEY || process.env.tavilyApiKey || '';
}

export function isWebResearchConfigured() {
  return Boolean(tavilyKey());
}

async function tavilyPost(path, body) {
  const key = tavilyKey();
  if (!key) {
    return {
      error: 'not_configured',
      message: 'Web research is unavailable: neither TAVILY_API_KEY nor tavilyApiKey is set on this deployment.',
    };
  }
  let res;
  try {
    res = await fetch(`${TAVILY_API}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    return { error: 'upstream_unavailable', message: `Tavily request failed: ${cause?.message || cause}` };
  }
  if (!res.ok) {
    // Surface Tavily's own reason (quota, bad key, invalid arg) — a generic
    // failure string would leave the agent with nothing actionable to say.
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.detail?.error || body?.detail || body?.error || '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    const code =
      res.status === 401 || res.status === 403 ? 'auth_failed' : res.status === 429 ? 'rate_limited' : 'upstream_error';
    return { error: code, status: res.status, message: `Tavily ${res.status}: ${String(detail).slice(0, 300)}` };
  }
  return res.json();
}

/** Search the live web. Returns trimmed, ranked sources with URLs to cite. */
export async function webSearch({
  query,
  max_results = 5,
  search_depth = 'basic',
  topic = 'general',
  time_range,
  include_domains,
  exclude_domains,
  include_raw_content = false,
} = {}) {
  const data = await tavilyPost('/search', {
    query,
    max_results,
    search_depth,
    topic,
    ...(time_range ? { time_range } : {}),
    ...(include_domains?.length ? { include_domains } : {}),
    ...(exclude_domains?.length ? { exclude_domains } : {}),
    ...(include_raw_content ? { include_raw_content: 'markdown' } : {}),
  });
  if (data.error) return data;
  return {
    query: data.query,
    result_count: (data.results || []).length,
    results: (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      score: r.score,
      content: String(r.content || '').slice(0, SEARCH_CONTENT_CHARS),
      ...(r.raw_content ? { raw_content: String(r.raw_content).slice(0, EXTRACT_CONTENT_CHARS) } : {}),
    })),
  };
}

/** Extract full readable content from specific URLs already known to the agent. */
export async function webExtract({ urls, extract_depth = 'basic', query } = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean).slice(0, 5);
  if (!list.length) return { error: 'invalid_input', message: 'Provide at least one URL to extract.' };
  const data = await tavilyPost('/extract', {
    urls: list,
    extract_depth,
    format: 'markdown',
    ...(query ? { query } : {}),
  });
  if (data.error) return data;
  return {
    results: (data.results || []).map((r) => ({
      url: r.url,
      content: String(r.raw_content || '').slice(0, EXTRACT_CONTENT_CHARS),
      truncated: String(r.raw_content || '').length > EXTRACT_CONTENT_CHARS,
    })),
    failed: (data.failed_results || []).map((f) => ({ url: f.url, error: f.error })),
  };
}
