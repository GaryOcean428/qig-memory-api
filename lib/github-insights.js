// Lightweight GitHub signal collection for the daily reviewer.
//
// Uses the public GitHub REST API. A token is OPTIONAL: when GITHUB_TOKEN (or
// GH_TOKEN) is set we send it for higher rate limits and private-repo access;
// without one, public repos still work under the unauthenticated rate limit.
// We keep requests minimal (2 per repo) so a daily scan of a few repos stays
// well within limits and never becomes the reason a run fails.

const GITHUB_API = 'https://api.github.com';

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'qig-memory-api-daily-reviewer',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function ghJson(path) {
  const res = await fetch(`${GITHUB_API}${path}`, { headers: githubHeaders() });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} for ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Collect a compact signal bundle for one repo: recent commit subjects and open
// issues (bug-labelled first). Everything is trimmed so the digest handed to the
// model stays small and cheap. Failures are captured, never thrown, so one bad
// repo can't abort the whole review.
export async function collectRepoSignals({ owner, name }) {
  const repo = `${owner}/${name}`;
  const signal = { repo, commits: [], issues: [], error: null };
  try {
    const [commits, issues] = await Promise.all([
      ghJson(`/repos/${owner}/${name}/commits?per_page=10`).catch((e) => {
        if (e.status === 409) return []; // empty repository
        throw e;
      }),
      ghJson(`/repos/${owner}/${name}/issues?state=open&per_page=15&sort=updated`),
    ]);

    signal.commits = (commits || [])
      .map((c) => c?.commit?.message?.split('\n')[0]?.slice(0, 140))
      .filter(Boolean)
      .slice(0, 10);

    // Exclude pull requests (the issues endpoint returns both).
    const realIssues = (issues || []).filter((i) => !i.pull_request);
    const labelWeight = (i) =>
      (i.labels || []).some((l) => /bug|regression|error|crash|security/i.test(l.name || '')) ? 0 : 1;
    signal.issues = realIssues
      .sort((a, b) => labelWeight(a) - labelWeight(b))
      .slice(0, 12)
      .map((i) => ({
        title: (i.title || '').slice(0, 160),
        labels: (i.labels || []).map((l) => l.name).filter(Boolean).slice(0, 6),
        url: i.html_url,
      }));
  } catch (error) {
    signal.error = error.message;
  }
  return signal;
}

export async function collectAllRepoSignals(repos = []) {
  const bounded = repos.slice(0, 8);
  return Promise.all(bounded.map((r) => collectRepoSignals(r)));
}
