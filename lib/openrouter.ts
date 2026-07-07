// Modulo analisi AI via OpenRouter (opzionale): invia un campione dei file
// più sospetti a un LLM per una seconda valutazione semantica, con score e
// motivazione. Gestisce errori e rate limit senza bloccare l'analisi statica.

import { FileAnalysis } from "./types";

export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-3.5-haiku";

/** Numero massimo di file inviati al modello (controllo costi/tempi). */
const MAX_AI_FILES = 8;
/** Caratteri massimi di codice per file inviati al modello. */
const MAX_AI_CHARS = 9000;

export function isAiConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

interface AiVerdict {
  score: number;
  reason: string;
}

const SYSTEM_PROMPT = `Sei un revisore di codice esperto in software forensics.
Valuta la probabilità (0-100) che il file fornito sia stato generato o fortemente assistito da un modello AI (ChatGPT, Claude, Copilot, ecc.), basandoti su stile, commenti, uniformità, naming, struttura e pattern tipici.
Rispondi SOLO con JSON valido nel formato: {"score": <numero 0-100>, "reason": "<motivazione sintetica in italiano, max 2 frasi>"}.
Non aggiungere altro testo.`;

async function scoreFileWithAi(
  path: string,
  content: string,
  model: string,
  signal: AbortSignal
): Promise<AiVerdict | null> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/leofurio/HowIUseAI",
      "X-Title": "AI Code Usage Analyzer",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `File: ${path}\n\n\`\`\`\n${content.slice(0, MAX_AI_CHARS)}\n\`\`\``,
        },
      ],
    }),
  });

  if (res.status === 401) throw new AiAnalysisError("Chiave OPENROUTER_API_KEY non valida.");
  if (res.status === 402) throw new AiAnalysisError("Credito OpenRouter esaurito.");
  if (res.status === 429) throw new AiAnalysisError("Rate limit OpenRouter raggiunto: analisi AI interrotta, risultati statici comunque disponibili.");
  if (!res.ok) throw new AiAnalysisError(`Errore OpenRouter (HTTP ${res.status}).`);

  const data = (await res.json()) as any;
  const text: string = data.choices?.[0]?.message?.content ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
    if (Number.isNaN(score)) return null;
    return { score, reason: String(parsed.reason ?? "").slice(0, 400) };
  } catch {
    return null;
  }
}

export class AiAnalysisError extends Error {}

export interface AiRunResult {
  analyzedFiles: number;
  error: string | null;
}

/**
 * Esegue l'analisi AI sui file con score statico più alto e aggiorna in place
 * aiScore/aiReason/score. Lo score finale combinato pesa 60% statico e 40% AI.
 */
export async function runAiAnalysis(
  files: FileAnalysis[],
  contents: Map<string, string>,
  model: string,
  onProgress: (done: number, total: number) => void
): Promise<AiRunResult> {
  if (!isAiConfigured()) {
    return { analyzedFiles: 0, error: "OPENROUTER_API_KEY non configurata: analisi AI non disponibile." };
  }
  const targets = [...files]
    .sort((a, b) => b.staticScore - a.staticScore)
    .slice(0, MAX_AI_FILES);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let done = 0;
  let error: string | null = null;

  try {
    for (const file of targets) {
      const content = contents.get(file.path);
      if (!content) continue;
      try {
        const verdict = await scoreFileWithAi(file.path, content, model, controller.signal);
        if (verdict) {
          file.aiScore = verdict.score;
          file.aiReason = verdict.reason;
          file.score = Math.round(file.staticScore * 0.6 + verdict.score * 0.4);
          file.risk = file.score >= 61 ? "alto" : file.score >= 31 ? "medio" : "basso";
        }
      } catch (e) {
        if (e instanceof AiAnalysisError) {
          error = e.message;
          break; // errori di quota/chiave: inutile insistere
        }
        // errori di rete transitori sul singolo file: si prosegue
      }
      done++;
      onProgress(done, targets.length);
    }
  } finally {
    clearTimeout(timeout);
  }
  return { analyzedFiles: done, error };
}
