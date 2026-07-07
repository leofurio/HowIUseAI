// Modulo acquisizione repository: da un URL GitHub/GitLab/Bitbucket scarica
// l'archivio ZIP del ramo di default (nessun binario `git` richiesto: tutto
// via HTTPS, compatibile con l'ambiente serverless di Vercel).

export interface RepoRef {
  provider: "github" | "gitlab" | "bitbucket";
  owner: string;
  repo: string;
  /** ramo esplicito nell'URL (es. .../tree/develop), se presente */
  branch: string | null;
  label: string;
}

export const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024; // 80 MB

export function parseRepoUrl(input: string): RepoRef {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("URL non valido. Inserire un URL completo, es. https://github.com/owner/repo");
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("URL incompleto: atteso il formato https://provider.com/owner/repo");
  }
  const [owner, repo] = parts;
  let branch: string | null = null;
  if (parts[2] === "tree" && parts[3]) branch = parts.slice(3).join("/");
  if (host.includes("github.com")) {
    return { provider: "github", owner, repo, branch, label: `${owner}/${repo}` };
  }
  if (host.includes("gitlab.com")) {
    // GitLab supporta gruppi annidati: owner può contenere più segmenti
    const treeIdx = parts.indexOf("-");
    const pathParts = treeIdx > 0 ? parts.slice(0, treeIdx) : parts;
    const glRepo = pathParts[pathParts.length - 1];
    const glOwner = pathParts.slice(0, -1).join("/");
    if (treeIdx > 0 && parts[treeIdx + 1] === "tree" && parts[treeIdx + 2]) {
      branch = parts.slice(treeIdx + 2).join("/");
    }
    return { provider: "gitlab", owner: glOwner, repo: glRepo, branch, label: `${glOwner}/${glRepo}` };
  }
  if (host.includes("bitbucket.org")) {
    if (parts[2] === "src" && parts[3]) branch = parts[3];
    return { provider: "bitbucket", owner, repo, branch, label: `${owner}/${repo}` };
  }
  throw new Error("Provider non supportato. Sono supportati GitHub, GitLab e Bitbucket.");
}

function authHeaders(provider: RepoRef["provider"]): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "ai-code-usage-analyzer" };
  if (provider === "github" && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  if (provider === "gitlab" && process.env.GITLAB_TOKEN) {
    headers["PRIVATE-TOKEN"] = process.env.GITLAB_TOKEN;
  }
  return headers;
}

async function fetchDefaultBranch(ref: RepoRef): Promise<string | null> {
  try {
    if (ref.provider === "github") {
      const res = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, {
        headers: authHeaders("github"),
      });
      if (res.ok) return (await res.json()).default_branch ?? null;
    }
    if (ref.provider === "gitlab") {
      const id = encodeURIComponent(`${ref.owner}/${ref.repo}`);
      const res = await fetch(`https://gitlab.com/api/v4/projects/${id}`, {
        headers: authHeaders("gitlab"),
      });
      if (res.ok) return (await res.json()).default_branch ?? null;
    }
    if (ref.provider === "bitbucket") {
      const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${ref.owner}/${ref.repo}`, {
        headers: authHeaders("bitbucket"),
      });
      if (res.ok) return (await res.json()).mainbranch?.name ?? null;
    }
  } catch {
    // il fallback main/master gestisce il caso
  }
  return null;
}

function archiveUrl(ref: RepoRef, branch: string): string {
  switch (ref.provider) {
    case "github":
      return `https://codeload.github.com/${ref.owner}/${ref.repo}/zip/refs/heads/${branch}`;
    case "gitlab":
      return `https://gitlab.com/${ref.owner}/${ref.repo}/-/archive/${branch}/${ref.repo}-${branch.replace(/\//g, "-")}.zip`;
    case "bitbucket":
      return `https://bitbucket.org/${ref.owner}/${ref.repo}/get/${branch}.zip`;
  }
}

/** Scarica l'archivio ZIP del repository. Ritorna il buffer e il ramo usato. */
export async function downloadRepoZip(ref: RepoRef): Promise<{ zip: ArrayBuffer; branch: string }> {
  const candidates = ref.branch
    ? [ref.branch]
    : [(await fetchDefaultBranch(ref)) ?? "", "main", "master"].filter(Boolean);

  let lastStatus = 0;
  for (const branch of [...new Set(candidates)]) {
    const res = await fetch(archiveUrl(ref, branch), {
      headers: authHeaders(ref.provider),
      redirect: "follow",
    });
    if (res.ok) {
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > MAX_ARCHIVE_BYTES) {
        throw new Error(
          `Repository troppo grande (${Math.round(length / 1024 / 1024)} MB, limite ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB). Caricare uno ZIP con solo il codice sorgente.`
        );
      }
      const zip = await res.arrayBuffer();
      if (zip.byteLength > MAX_ARCHIVE_BYTES) {
        throw new Error("Repository troppo grande per l'analisi serverless. Caricare uno ZIP ridotto.");
      }
      return { zip, branch };
    }
    lastStatus = res.status;
  }
  if (lastStatus === 404) {
    throw new Error("Repository non trovato o privato. Verificare l'URL (per repo privati configurare GITHUB_TOKEN/GITLAB_TOKEN).");
  }
  if (lastStatus === 403 || lastStatus === 429) {
    throw new Error("Rate limit del provider raggiunto. Riprovare più tardi o configurare un token di accesso.");
  }
  throw new Error(`Impossibile scaricare il repository (HTTP ${lastStatus || "sconosciuto"}).`);
}
