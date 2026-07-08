// Modulo git blame: attribuisce le righe dei file più sospetti agli autori
// dei commit tramite l'API GraphQL di GitHub (richiede GITHUB_TOKEN).
// Una riga conta come "AI" se il commit che l'ha introdotta ha un autore
// riconducibile a uno strumento AI oppure una firma AI nel messaggio.

import { RepoRef } from "./acquisition";
import { classifyAiAuthor, hasAiSignature } from "./commits";
import { AnalysisReport, BlameSummary } from "./types";

const MAX_BLAME_FILES = 10;

interface BlameRange {
  startingLine: number;
  endingLine: number;
  commit: { author: { name: string | null; email: string | null } | null; message: string };
}

async function blameFile(ref: RepoRef, branch: string, path: string): Promise<BlameRange[] | null> {
  const query = `
    query($owner: String!, $name: String!, $ref: String!, $path: String!) {
      repository(owner: $owner, name: $name) {
        object(expression: $ref) {
          ... on Commit {
            blame(path: $path) {
              ranges {
                startingLine
                endingLine
                commit { author { name email } message }
              }
            }
          }
        }
      }
    }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "ai-code-usage-analyzer",
    },
    body: JSON.stringify({ query, variables: { owner: ref.owner, name: ref.repo, ref: branch, path } }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  return data.data?.repository?.object?.blame?.ranges ?? null;
}

/**
 * Esegue il blame sui file con score più alto e aggiorna il report in place:
 * - imposta aiLineRatio per file e alza lo score quando l'attribuzione è forte;
 * - riempie report.commitAnalysis.blame con il riepilogo.
 * Solo GitHub + GITHUB_TOKEN; per gli altri casi lascia una nota esplicativa.
 */
export async function runBlameAnalysis(
  ref: RepoRef,
  branch: string,
  report: AnalysisReport,
  onProgress: (done: number, total: number) => void
): Promise<void> {
  const summary: BlameSummary = {
    available: false,
    filesAnalyzed: 0,
    totalLines: 0,
    aiLines: 0,
    note: null,
  };
  report.commitAnalysis.blame = summary;

  if (ref.provider !== "github") {
    summary.note = "L'analisi degli autori delle righe (git blame) è disponibile solo per repository GitHub.";
    return;
  }
  if (!process.env.GITHUB_TOKEN) {
    summary.note = "Configurare GITHUB_TOKEN per abilitare l'analisi degli autori delle righe (git blame).";
    return;
  }

  const targets = [...report.files].sort((a, b) => b.score - a.score).slice(0, MAX_BLAME_FILES);
  let done = 0;
  for (const file of targets) {
    try {
      const ranges = await blameFile(ref, branch, file.path);
      if (ranges && ranges.length > 0) {
        let total = 0;
        let ai = 0;
        for (const r of ranges) {
          const lines = r.endingLine - r.startingLine + 1;
          total += lines;
          const tool = classifyAiAuthor(r.commit.author?.name ?? "", r.commit.author?.email ?? "");
          if (tool || hasAiSignature(r.commit.message)) ai += lines;
        }
        if (total > 0) {
          const ratio = ai / total;
          file.aiLineRatio = ratio;
          summary.available = true;
          summary.filesAnalyzed++;
          summary.totalLines += total;
          summary.aiLines += ai;
          if (ratio > 0) {
            const percent = Math.round(ratio * 100);
            file.reasons.unshift(
              `Git blame: ${percent}% delle righe proviene da commit attribuiti a strumenti AI.`
            );
            // L'attribuzione diretta è l'evidenza più forte: lo score non può
            // essere inferiore alla quota di righe attribuite ad AI.
            if (percent > file.score) {
              file.score = percent;
              file.risk = percent >= 61 ? "alto" : percent >= 31 ? "medio" : "basso";
            }
          }
        }
      }
    } catch {
      // best effort: un errore su un file non blocca gli altri
    }
    done++;
    onProgress(done, targets.length);
  }

  if (!summary.available && !summary.note) {
    summary.note = "Blame non disponibile per i file selezionati (repository vuoto o percorso non trovato).";
  }
}
