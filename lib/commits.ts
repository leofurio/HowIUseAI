// Modulo analisi cronologia Git: recupera i commit via API del provider
// (nessun clone necessario) e cerca anomalie compatibili con generazione
// massiva di codice. Disponibile solo per analisi da URL, non da ZIP.

import { AiAuthor, AiBranch, CommitAnalysis, CommitInfo } from "./types";
import { RepoRef } from "./acquisition";

const MAX_COMMITS = 300;
const MAX_BRANCH_PAGES = 3; // 100 branch per pagina

// Prefissi/pattern di branch creati dagli strumenti di coding AI.
const AI_BRANCH_PATTERNS: { pattern: RegExp; tool: string }[] = [
  { pattern: /^claude([\/_-]|$)/i, tool: "Claude Code" },
  { pattern: /^copilot([\/_-]|$)/i, tool: "GitHub Copilot" },
  { pattern: /^codex([\/_-]|$)/i, tool: "OpenAI Codex" },
  { pattern: /^cursor([\/_-]|$)/i, tool: "Cursor" },
  { pattern: /^aider([\/_-]|$)/i, tool: "Aider" },
  { pattern: /^devin([\/_-]|$)/i, tool: "Devin" },
  { pattern: /^sweep([\/_-]|$)/i, tool: "Sweep" },
  { pattern: /^openhands([\/_-]|$)/i, tool: "OpenHands" },
  { pattern: /^windsurf([\/_-]|$)/i, tool: "Windsurf" },
  { pattern: /^jules([\/_-]|$)/i, tool: "Jules" },
  { pattern: /^(gpt|chatgpt)([\/_-]|$)/i, tool: "ChatGPT" },
  { pattern: /ai[-_]?generated/i, tool: "generico (ai-generated)" },
];

export function matchAiBranch(name: string, state: AiBranch["state"] = "attivo"): AiBranch | null {
  for (const { pattern, tool } of AI_BRANCH_PATTERNS) {
    if (pattern.test(name)) return { name, tool, state };
  }
  return null;
}

// Autori di commit riconducibili a strumenti/bot di codegen AI. I bot di
// automazione (dependabot, renovate, github-actions, vercel…) NON contano:
// aggiornano dipendenze/config, non generano codice applicativo.
const AI_AUTHOR_PATTERNS: { pattern: RegExp; tool: string }[] = [
  { pattern: /\bclaude\b|anthropic/i, tool: "Claude" },
  { pattern: /copilot/i, tool: "GitHub Copilot" },
  { pattern: /devin/i, tool: "Devin" },
  { pattern: /\baider\b/i, tool: "Aider" },
  { pattern: /cursor\s*(agent|ai|\[bot\])|cursoragent/i, tool: "Cursor" },
  { pattern: /\bcodex\b|openai/i, tool: "OpenAI Codex" },
  { pattern: /sweep[-_ ]?ai|sweep\[bot\]/i, tool: "Sweep" },
  { pattern: /openhands|all[-_ ]?hands/i, tool: "OpenHands" },
  { pattern: /\bjules\b.*(bot|google)|google-labs-jules/i, tool: "Jules" },
];

const AUTOMATION_BOTS = /dependabot|renovate|github-actions|vercel|netlify|snyk|greenkeeper|imgbot|codecov|semantic-release|pre-commit/i;

/** Classifica un autore di commit: ritorna lo strumento AI o null. */
export function classifyAiAuthor(name: string, email = ""): string | null {
  const id = `${name} ${email}`;
  if (AUTOMATION_BOTS.test(id)) return null;
  for (const { pattern, tool } of AI_AUTHOR_PATTERNS) {
    if (pattern.test(id)) return tool;
  }
  return null;
}

/** true se il messaggio di commit contiene firme esplicite di strumenti AI. */
export function hasAiSignature(message: string): boolean {
  return AI_SIGNATURE_PATTERNS.some((p) => p.test(message));
}

// Branch chiusi: i nomi sopravvivono nei merge commit anche quando il branch
// è stato cancellato ("Merge pull request #N from owner/branch", "Merge branch 'x'").
const MERGE_MESSAGE_PATTERNS = [
  /^Merge pull request #\d+ from [^/\s]+\/(\S+)/,
  /^Merge branch '([^']+)'/,
  /^Merged in (\S+) \(pull request #\d+\)/, // Bitbucket
];

export function branchNamesFromMergeMessages(messages: string[]): string[] {
  const names = new Set<string>();
  for (const msg of messages) {
    const firstLine = msg.split("\n")[0];
    for (const p of MERGE_MESSAGE_PATTERNS) {
      const m = firstLine.match(p);
      if (m?.[1]) names.add(m[1]);
    }
  }
  return [...names];
}

/** Branch sorgente delle PR/MR chiuse (sopravvivono alla cancellazione del branch). */
async function fetchClosedPrBranches(ref: RepoRef): Promise<string[]> {
  try {
    const names = new Set<string>();
    if (ref.provider === "github") {
      const headers: Record<string, string> = {
        "User-Agent": "ai-code-usage-analyzer",
        Accept: "application/vnd.github+json",
      };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      for (let page = 1; page <= 2; page++) {
        const res = await fetch(
          `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls?state=closed&per_page=100&page=${page}`,
          { headers }
        );
        if (!res.ok) break;
        const batch = (await res.json()) as any[];
        for (const pr of batch) if (pr.head?.ref) names.add(String(pr.head.ref));
        if (batch.length < 100) break;
      }
    } else if (ref.provider === "gitlab") {
      const headers: Record<string, string> = { "User-Agent": "ai-code-usage-analyzer" };
      if (process.env.GITLAB_TOKEN) headers["PRIVATE-TOKEN"] = process.env.GITLAB_TOKEN;
      const id = encodeURIComponent(`${ref.owner}/${ref.repo}`);
      for (let page = 1; page <= 2; page++) {
        const res = await fetch(
          `https://gitlab.com/api/v4/projects/${id}/merge_requests?state=all&per_page=100&page=${page}`,
          { headers }
        );
        if (!res.ok) break;
        const batch = (await res.json()) as any[];
        for (const mr of batch) if (mr.source_branch) names.add(String(mr.source_branch));
        if (batch.length < 100) break;
      }
    } else {
      let url: string | null =
        `https://api.bitbucket.org/2.0/repositories/${ref.owner}/${ref.repo}/pullrequests?state=MERGED&state=DECLINED&state=SUPERSEDED&pagelen=50`;
      for (let page = 0; page < 3 && url; page++) {
        const res = await fetch(url, { headers: { "User-Agent": "ai-code-usage-analyzer" } });
        if (!res.ok) break;
        const data = (await res.json()) as any;
        for (const pr of data.values ?? []) {
          const n = pr.source?.branch?.name;
          if (n) names.add(String(n));
        }
        url = data.next ?? null;
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

async function fetchBranchNames(ref: RepoRef): Promise<string[] | null> {
  try {
    const names: string[] = [];
    if (ref.provider === "github") {
      const headers: Record<string, string> = {
        "User-Agent": "ai-code-usage-analyzer",
        Accept: "application/vnd.github+json",
      };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
        const res = await fetch(
          `https://api.github.com/repos/${ref.owner}/${ref.repo}/branches?per_page=100&page=${page}`,
          { headers }
        );
        if (!res.ok) return page === 1 ? null : names;
        const batch = (await res.json()) as any[];
        names.push(...batch.map((b) => String(b.name)));
        if (batch.length < 100) break;
      }
    } else if (ref.provider === "gitlab") {
      const headers: Record<string, string> = { "User-Agent": "ai-code-usage-analyzer" };
      if (process.env.GITLAB_TOKEN) headers["PRIVATE-TOKEN"] = process.env.GITLAB_TOKEN;
      const id = encodeURIComponent(`${ref.owner}/${ref.repo}`);
      for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
        const res = await fetch(
          `https://gitlab.com/api/v4/projects/${id}/repository/branches?per_page=100&page=${page}`,
          { headers }
        );
        if (!res.ok) return page === 1 ? null : names;
        const batch = (await res.json()) as any[];
        names.push(...batch.map((b) => String(b.name)));
        if (batch.length < 100) break;
      }
    } else {
      let url: string | null =
        `https://api.bitbucket.org/2.0/repositories/${ref.owner}/${ref.repo}/refs/branches?pagelen=100`;
      for (let page = 0; page < MAX_BRANCH_PAGES && url; page++) {
        const res = await fetch(url, { headers: { "User-Agent": "ai-code-usage-analyzer" } });
        if (!res.ok) return page === 0 ? null : names;
        const data = (await res.json()) as any;
        names.push(...(data.values ?? []).map((b: any) => String(b.name)));
        url = data.next ?? null;
      }
    }
    return names;
  } catch {
    return null;
  }
}

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
    totalBranches: null,
    aiBranches: [],
    aiAuthors: [],
    aiCommitRatio: 0,
    blame: null,
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
  email: string;
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
        email: c.commit?.author?.email ?? "",
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
        email: c.author_email ?? "",
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
        email: c.author?.raw?.match(/<([^>]+)>/)?.[1] ?? "",
        date: c.date ?? "",
        message: c.message ?? "",
      });
    }
    url = data.next ?? null;
  }
  return commits;
}

/** Analizza la cronologia commit e i branch del repository (best effort, mai bloccante). */
export async function analyzeCommits(ref: RepoRef, branch: string): Promise<CommitAnalysis> {
  let raw: RawCommit[] = [];
  let source = "";
  let branchNames: string[] | null = null;
  let allClosed: string[] = [];
  try {
    const commitsPromise =
      ref.provider === "github"
        ? fetchGitHubCommits(ref, branch)
        : ref.provider === "gitlab"
          ? fetchGitLabCommits(ref, branch)
          : fetchBitbucketCommits(ref, branch);
    source =
      ref.provider === "github" ? "GitHub API" : ref.provider === "gitlab" ? "GitLab API" : "Bitbucket API";
    let closedBranchNames: string[] = [];
    [raw, branchNames, closedBranchNames] = await Promise.all([
      commitsPromise,
      fetchBranchNames(ref),
      fetchClosedPrBranches(ref),
    ]);
    // I nomi dei branch cancellati sopravvivono anche nei merge commit.
    closedBranchNames = [
      ...new Set([...closedBranchNames, ...branchNamesFromMergeMessages(raw.map((c) => c.message))]),
    ];
    const activeSet = new Set(branchNames ?? []);
    allClosed = closedBranchNames.filter((n) => !activeSet.has(n));
  } catch {
    return emptyAnalysis();
  }

  const aiBranches: AiBranch[] = [
    ...(branchNames ?? []).map((n) => matchAiBranch(n, "attivo")),
    ...allClosed.map((n) => matchAiBranch(n, "chiuso")),
  ]
    .filter((b): b is AiBranch => b !== null)
    .slice(0, 30);

  if (raw.length === 0) {
    return { ...emptyAnalysis(), totalBranches: branchNames?.length ?? null, aiBranches };
  }

  const authorCount = new Map<string, number>();
  const aiAuthorTool = new Map<string, string>();
  const timeline = new Map<string, number>();
  const dayCount = new Map<string, number>();
  let generic = 0;
  let aiSigned = 0;
  let aiCommits = 0;

  for (const c of raw) {
    authorCount.set(c.author, (authorCount.get(c.author) ?? 0) + 1);
    const tool = classifyAiAuthor(c.author, c.email);
    if (tool) aiAuthorTool.set(c.author, tool);
    const month = c.date.slice(0, 7);
    if (month) timeline.set(month, (timeline.get(month) ?? 0) + 1);
    const day = c.date.slice(0, 10);
    if (day) dayCount.set(day, (dayCount.get(day) ?? 0) + 1);
    const firstLine = c.message.split("\n")[0].trim();
    if (GENERIC_MESSAGE_PATTERNS.some((p) => p.test(firstLine))) generic++;
    const signed = hasAiSignature(c.message);
    if (signed) aiSigned++;
    if (tool || signed) aiCommits++;
  }

  const aiAuthors: AiAuthor[] = [...aiAuthorTool.entries()]
    .map(([name, tool]) => ({ name, tool, commits: authorCount.get(name) ?? 0 }))
    .sort((a, b) => b.commits - a.commits);
  const aiCommitRatio = raw.length ? aiCommits / raw.length : 0;

  const anomalies: string[] = [];
  if (aiBranches.length > 0) {
    const tools = [...new Set(aiBranches.map((b) => b.tool))].join(", ");
    const closed = aiBranches.filter((b) => b.state === "chiuso").length;
    anomalies.push(
      `${aiBranches.length} branch con nomi tipici degli strumenti AI (${tools})` +
        (closed > 0 ? `, di cui ${closed} già chiusi/cancellati` : "") +
        `: es. "${aiBranches[0].name}".`
    );
  }
  if (aiAuthors.length > 0) {
    anomalies.push(
      `${aiAuthors.length} autori di commit riconducibili a strumenti AI (${aiAuthors
        .slice(0, 3)
        .map((a) => `${a.name}: ${a.commits} commit`)
        .join(", ")}).`
    );
  }
  if (aiCommitRatio >= 0.3) {
    anomalies.push(
      `${Math.round(aiCommitRatio * 100)}% dei commit è attribuito ad autori AI o contiene firme AI nel messaggio.`
    );
  }
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
    totalBranches: branchNames?.length ?? null,
    aiBranches,
    aiAuthors,
    aiCommitRatio,
    blame: null,
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
