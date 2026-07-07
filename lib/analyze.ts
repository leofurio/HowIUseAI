// Orchestratore dell'analisi: estrazione ZIP → filtro → analisi statica →
// aggregazione → (opzionale) analisi commit e analisi AI → report finale.

import JSZip from "jszip";
import { analyzeFile } from "./staticAnalysis";
import { looksBinaryOrMinified, MAX_FILES, shouldAnalyzePath } from "./filter";
import { runAiAnalysis, DEFAULT_MODEL } from "./openrouter";
import {
  AnalysisReport,
  CommitAnalysis,
  Confidence,
  FileAnalysis,
  FolderStat,
  LanguageStat,
} from "./types";
import { emptyCommitAnalysis } from "./commits";

export interface AnalyzeOptions {
  sourceType: "url" | "zip";
  sourceLabel: string;
  useAi: boolean;
  aiModel?: string;
  commitAnalysis?: CommitAnalysis;
  onProgress: (stage: string, percent: number) => void;
}

function topFolder(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts[0] : "(radice)";
}

function aggregate<T extends string>(
  files: FileAnalysis[],
  keyFn: (f: FileAnalysis) => T
): { key: T; files: number; lines: number; avgScore: number }[] {
  const map = new Map<T, { files: number; lines: number; scoreWeighted: number }>();
  for (const f of files) {
    const key = keyFn(f);
    const entry = map.get(key) ?? { files: 0, lines: 0, scoreWeighted: 0 };
    entry.files++;
    entry.lines += f.lines;
    entry.scoreWeighted += f.score * f.lines;
    map.set(key, entry);
  }
  return [...map.entries()]
    .map(([key, e]) => ({
      key,
      files: e.files,
      lines: e.lines,
      avgScore: e.lines ? Math.round(e.scoreWeighted / e.lines) : 0,
    }))
    .sort((a, b) => b.lines - a.lines);
}

function computeConfidence(
  files: FileAnalysis[],
  totalLines: number,
  commitAnalysis: CommitAnalysis,
  aiUsed: boolean
): { confidence: Confidence; reasons: string[] } {
  let points = 0;
  const reasons: string[] = [];
  if (files.length >= 20) points++;
  else reasons.push("Campione di file ridotto: la stima è meno affidabile.");
  if (totalLines >= 3000) points++;
  else reasons.push("Poche righe di codice analizzate.");
  if (commitAnalysis.available) {
    points++;
    reasons.push("Cronologia Git disponibile: la stima incrocia segnali di codice e di processo.");
  } else {
    reasons.push("Cronologia Git non disponibile (analisi da ZIP o API non raggiungibile).");
  }
  if (aiUsed) {
    points++;
    reasons.push("Analisi AI eseguita sui file più sospetti: doppia validazione dello score.");
  }
  const confidence: Confidence = points >= 3 ? "alto" : points >= 2 ? "medio" : "basso";
  return { confidence, reasons };
}

/** Applica i segnali della cronologia commit come correttivo dello score complessivo. */
function commitAdjustment(commitAnalysis: CommitAnalysis): number {
  let adj = 0;
  // I branch con nomi da AI tool sono un segnale forte anche quando la
  // cronologia commit non è disponibile.
  if (commitAnalysis.aiBranches.length > 0) {
    adj += Math.min(10, commitAnalysis.aiBranches.length * 3);
  }
  if (!commitAnalysis.available) return Math.min(20, adj);
  if (commitAnalysis.aiSignedCommits > 0) {
    adj += Math.min(15, commitAnalysis.aiSignedCommits * 3);
  }
  if (commitAnalysis.genericMessageRatio > 0.5) adj += 4;
  if (commitAnalysis.anomalies.some((a) => a.includes("massiva"))) adj += 4;
  return Math.min(20, adj);
}

export async function analyzeZip(zipData: ArrayBuffer, options: AnalyzeOptions): Promise<AnalysisReport> {
  const { onProgress } = options;
  onProgress("Estrazione archivio", 12);

  const zip = await JSZip.loadAsync(zipData);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length === 0) {
    throw new Error("L'archivio non contiene file.");
  }

  // Gli archivi dei provider hanno una cartella radice "repo-branch/": la rimuoviamo.
  const names = entries.map((e) => e.name);
  const firstSegment = names[0].split("/")[0];
  const hasCommonRoot = firstSegment && names.every((n) => n.startsWith(firstSegment + "/"));
  const normalizePath = (name: string) => (hasCommonRoot ? name.slice(firstSegment.length + 1) : name);

  onProgress("Filtro dei file rilevanti", 18);
  const skippedByReason = new Map<string, number>();
  const toAnalyze: { path: string; entry: JSZip.JSZipObject; language: string }[] = [];
  let skippedTotal = 0;

  for (const entry of entries) {
    const path = normalizePath(entry.name);
    if (!path) continue;
    // JSZip non espone la dimensione non compressa in modo tipizzato ovunque:
    // usiamo l'informazione interna se presente, altrimenti 0 (controllo dopo la lettura).
    const size = (entry as any)._data?.uncompressedSize ?? 0;
    const decision = shouldAnalyzePath(path, size);
    if (!decision.include) {
      skippedTotal++;
      skippedByReason.set(decision.reason!, (skippedByReason.get(decision.reason!) ?? 0) + 1);
      continue;
    }
    toAnalyze.push({ path, entry, language: decision.language! });
    if (toAnalyze.length >= MAX_FILES) break;
  }

  if (toAnalyze.length === 0) {
    throw new Error("Nessun file di codice analizzabile trovato nel repository (dopo l'esclusione di binari, librerie e file generati).");
  }

  onProgress("Analisi statica del codice", 25);
  const files: FileAnalysis[] = [];
  const contents = new Map<string, string>();
  let processed = 0;

  for (const { path, entry, language } of toAnalyze) {
    const content = await entry.async("string");
    const skipReason = looksBinaryOrMinified(content);
    if (skipReason) {
      skippedTotal++;
      skippedByReason.set(skipReason, (skippedByReason.get(skipReason) ?? 0) + 1);
    } else {
      files.push(analyzeFile(path, content, language));
      contents.set(path, content);
    }
    processed++;
    if (processed % 25 === 0) {
      onProgress("Analisi statica del codice", 25 + Math.round((processed / toAnalyze.length) * 35));
    }
  }

  onProgress("Aggregazione dei risultati", 62);
  const commitAnalysis = options.commitAnalysis ?? emptyCommitAnalysis();

  // Analisi AI opzionale sui file più sospetti.
  let aiUsed = false;
  let aiError: string | null = null;
  if (options.useAi) {
    onProgress("Analisi AI via OpenRouter", 68);
    const result = await runAiAnalysis(
      files,
      contents,
      options.aiModel || DEFAULT_MODEL,
      (done, total) => onProgress("Analisi AI via OpenRouter", 68 + Math.round((done / total) * 22))
    );
    aiUsed = result.analyzedFiles > 0;
    aiError = result.error;
  }

  onProgress("Generazione del report", 92);
  const totalLines = files.reduce((a, f) => a + f.lines, 0);

  // Percentuale complessiva: media degli score pesata sulle righe + correttivo commit.
  const weightedScore = totalLines
    ? files.reduce((a, f) => a + f.score * f.lines, 0) / totalLines
    : 0;
  const aiPercent = Math.min(100, Math.round(weightedScore + commitAdjustment(commitAnalysis)));

  const languages: LanguageStat[] = aggregate(files, (f) => f.language as string).map((e) => ({
    language: e.key,
    files: e.files,
    lines: e.lines,
    avgScore: e.avgScore,
  }));
  const folders: FolderStat[] = aggregate(files, (f) => topFolder(f.path) as string)
    .slice(0, 12)
    .map((e) => ({ folder: e.key, files: e.files, lines: e.lines, avgScore: e.avgScore }));

  const { confidence, reasons: confidenceReasons } = computeConfidence(files, totalLines, commitAnalysis, aiUsed);

  files.sort((a, b) => b.score - a.score);

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    source: { type: options.sourceType, label: options.sourceLabel },
    aiPercent,
    manualPercent: 100 - aiPercent,
    confidence,
    confidenceReasons,
    totalFiles: files.length,
    totalLines,
    languages,
    folders,
    files,
    commitAnalysis,
    skipped: {
      total: skippedTotal,
      byReason: [...skippedByReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    },
    aiAnalysisUsed: aiUsed,
    aiModel: aiUsed || options.useAi ? options.aiModel || DEFAULT_MODEL : null,
    aiAnalysisError: aiError,
  };
}
