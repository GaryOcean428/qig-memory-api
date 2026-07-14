// Science article collection for the daily reviewer.
//
// Uses the arXiv Atom API (https://export.arxiv.org/api/query). It is free, needs
// no key, and returns recent preprints for a topic — ideal for surfacing QIG-
// relevant discoveries (information geometry, Fisher-Rao, natural gradient, etc.)
// without any credentials. We parse the small Atom payload with focused regexes
// rather than pulling in an XML dependency.

const ARXIV_API = 'https://export.arxiv.org/api/query';

function decodeXml(value = '') {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEntries(xml, topic) {
  const entries = [];
  const blocks = xml.split('<entry>').slice(1);
  for (const block of blocks) {
    const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const summary = decodeXml((block.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '');
    // The <id> is the canonical abstract URL; prefer the alternate link when present.
    const link =
      (block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || [])[1] ||
      (block.match(/<id>([\s\S]*?)<\/id>/) || [])[1] ||
      '';
    const published = (block.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || '';
    if (!title || !link) continue;
    entries.push({
      topic,
      title,
      summary: summary.slice(0, 400),
      url: link.trim(),
      published: published.trim(),
    });
  }
  return entries;
}

async function fetchTopic(topic, perTopic) {
  const query = `search_query=all:${encodeURIComponent(topic)}&sortBy=submittedDate&sortOrder=descending&max_results=${perTopic}`;
  const res = await fetch(`${ARXIV_API}?${query}`, {
    headers: { 'User-Agent': 'qig-memory-api-daily-reviewer' },
  });
  if (!res.ok) throw new Error(`arXiv ${res.status} for "${topic}"`);
  return parseEntries(await res.text(), topic);
}

// Collect a bounded set of recent articles across the configured topics.
// Per-topic failures are swallowed so a single flaky query never breaks the run.
export async function collectScienceArticles(topics = [], { perTopic = 3 } = {}) {
  const bounded = topics.slice(0, 8);
  const results = await Promise.all(
    bounded.map((topic) => fetchTopic(topic, perTopic).catch(() => [])),
  );
  const seen = new Set();
  const articles = [];
  for (const list of results) {
    for (const article of list) {
      if (seen.has(article.url)) continue;
      seen.add(article.url);
      articles.push(article);
    }
  }
  return articles;
}
