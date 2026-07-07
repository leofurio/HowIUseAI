// Modulo analisi cronologia Git: recupera i commit via API del provider
// (nessun clone necessario) e cerca anomalie compatibili con generazione
// massiva di codice. Disponibile solo per analisi da URL, non da ZIP.

import { CommitAnalysis, CommitInfo } from "./types";
import { RepoRef } from "./acquisition";

const MAX_COMMITS = 300;

const GENERIC_MESSAGE_PATTERNS: RegExp[] = [
  /^(update|updates|updated)( .{0,20})?$/i,
  /^(fix|fixes|fixed)( .{0,20})?$/i,
  /^(wip|misc|changes|stuff|test|tmp)$/i,
  /^initial commit$/i,
  /^(add|added) (files?|code)$/i,
  /^minor (changes|fixes|updates)$/i,
  /^refactor$/i,
];

const AI_SIGNATURE_PATTERNS: RegExp[] = [
  /co-authored-by:\s*(claude|github copilot|copilot|chatgpt|cursor|aider|devin|codex)/i,
  /generated (with|by) \[?(claude|chatgpt|copilot|cursor|aider|gemini)/i,
  /🤖 generated/i,
];

function emptyAnalysis(): CommitAnalysis {
  return {
    available: false,
    source: null,
    totalCommits: 0,
    truncated: false,
    authors: [],
    timeline: [],
    genericMessageRatio: 0,
    aiSignedCommits: 0,
    anomalies: [],
    recentCommits: [],
  };
}

interface RawCommit {
  sha: string;
  author: string;
  date: string;
  message: string;
}

async function fetchGitHubCommits(ref: RepoRef, branch: string): Promise<RawCommit[]> {
  const headers: Record<string, string> = {
    "User-Agent": "ai-code-usage-analyzer",
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const commits: RawCommit[] = [];
  for (let page = 1; page <= 3 && commits.length < MAX_COMMITS; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=100&page=${page}`,
      { headers }
    );
    if (!res.ok) break;
    const batch = (await res.json()) as any[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const c of batch) {
      commits.push({
        sha: c.sha,
        author: c.commit?.author?.name ?? c.author?.login ?? "sconosciuto",
        date: c.commit?.author?.date ?? "",
        message: c.commit?.message ?? "",
      });
    }
    if (batch.length < 100) break;
  }
  return commits;
}

async function fetchGitLabCommits(ref: RepoRef, branch: string): Promise<RawCommit[]> {
  const headers: Record<string, string> = { "User-Agent": "ai-code-usage-analyzer" };
  if (process.env.GITLAB_TOKEN) headers["PRIVATE-TOKEN"] = process.env.GITLAB_TOKEN;
  const id = encodeURIComponent(`${ref.owner}/${ref.repo}`);
  const commits: RawCommit[] = [];
  for (let page = 1; page <= 3 && commits.length < MAX_COMMITS; page++) {
    const res = await fetch(
      `https://gitlab.com/api/v4/projects/${id}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=100&page=${page}`,
      { headers }
    );
    if (!res.ok) break;
    const batch = (await res.json()) as any[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const c of batch) {
      commits.push({
        sha: c.id,
        author: c.author_name ?? "sconosciuto",
        date: c.committed_date ?? c.created_at ?? "",
        message: [c.title, c.message].filter(Boolean).join("\n"),
      });
    }
    if (batch.length < 100) break;
  }
  return commits;
}

async function fetchBitbucketCommits(ref: RepoRef, branch: string): Promise<RawCommit[]> {
  const commits: RawCommit[] = [];
  let url: string | null =
    `https://api.bitbucket.org/2.0/repositories/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(branch)}?pagelen=100`;
  for (let page = 0; page < 3 && url && commits.length < MAX_COMMITS; page++) {
    const res = await fetch(url, { headers: { "User-Agent": "ai-code-usage-analyzer" } });
    if (!res.ok) break;
    const data = (await res.json()) as any;
    for (const c of data.values ?? []) {
      commits.push({
        sha: c.hash,
        author: c.author?.user?.display_name ?? c.author?.raw?.replace(/<.*>/, "").trim() ?? "sconosciuto",
        date: c.date ?? "",
        message: c.message ?? "",
      });
    }
    url = data.next ?? null;
  }
  return commits;
}

/** Analizza la cronologia commit del repository (best effort, mai bloccante). */
export async function analyzeCommits(ref: RepoRef, branch: string): Promise<CommitAnalysis> {
  let raw: RawCommit[] = [];
  let source = "";
  try {
    if (ref.provider === "github") {
      raw = await fetchGitHubCommits(ref, branch);
      source = "GitHub API";
    } else if (ref.provider === "gitlab") {
      raw = await fetchGitLabCommits(ref, branch);
      source = "GitLab API";
    } else {
      raw = await fetchBitbucketCommits(ref, branch);
      source = "Bitbucket API";
    }
  } catch {
    return emptyAnalysis();
  }
  if (raw.length === 0) return emptyAnalysis();

  const authorCount = new Map<string, number>();
  const timeline = new Map<string, number>();
  const dayCount = new Map<string, number>();
  let generic = 0;
  let aiSigned = 0;

  for (const c of raw) {
    authorCount.set(c.author, (authorCount.get(c.author) ?? 0) + 1);
    const month = c.date.slice(0, 7);
    if (month) timeline.set(month, (timeline.get(month) ?? 0) + 1);
    const day = c.date.slice(0, 10);
    if (day) dayCount.set(day, (dayCount.get(day) ?? 0) + 1);
    const firstLine = c.message.split("\n")[0].trim();
    if (GENERIC_MESSAGE_PATTERNS.some((p) => p.test(firstLine))) generic++;
    if (AI_SIGNATURE_PATTERNS.some((p) => p.test(c.message))) aiSigned++;
  }

  const anomalies: string[] = [];
  if (aiSigned > 0) {
    anomalies.push(
      `${aiSigned} commit contengono firme esplicite di strumenti AI (es. "Co-Authored-By: Claude").`
    );
  }
  const genericRatio = generic / raw.length;
  if (genericRatio > 0.4) {
    anomalies.push(
      `${Math.round(genericRatio * 100)}% dei messaggi di commit è generico ("update", "fix"…): poca tracciabilità delle modifiche.`
    );
  }
  // Giornate con burst anomali di commit rispetto alla mediana
  const counts = [...dayCount.values()].sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] ?? 0;
  const burstDays = [...dayCount.entries()].filter(([, n]) => n >= Math.max(10, median * 5));
  for (const [day, n] of burstDays.slice(0, 3)) {
    anomalies.push(`Il ${day} sono stati registrati ${n} commit in un solo giorno: possibile generazione massiva di codice.`);
  }
  if (raw.length <= 3) {
    anomalies.push(
      "Cronologia molto corta: gran parte del codice è arrivata in pochissimi commit, pattern compatibile con generazione in blocco."
    );
  }

  return {
    available: true,
    source,
    totalCommits: raw.length,
    truncated: raw.length >= MAX_COMMITS,
    authors: [...authorCount.entries()]
      .map(([name, commits]) => ({ name, commits }))
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 15),
    timeline: [...timeline.entries()]
      .map(([period, commits]) => ({ period, commits }))
      .sort((a, b) => a.period.localeCompare(b.period)),
    genericMessageRatio: genericRatio,
    aiSignedCommits: aiSigned,
    anomalies,
    recentCommits: raw.slice(0, 20).map(
      (c): CommitInfo => ({
        sha: c.sha.slice(0, 8),
        author: c.author,
        date: c.date,
        message: c.message.split("\n")[0].slice(0, 120),
        filesChanged: null,
      })
    ),
  };
}

export function emptyCommitAnalysis(): CommitAnalysis {
  return emptyAnalysis();
}
