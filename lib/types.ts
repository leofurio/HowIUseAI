// Tipi condivisi tra backend (API route) e frontend (dashboard).

export type RiskLevel = "basso" | "medio" | "alto";
export type Confidence = "basso" | "medio" | "alto";

export interface IndicatorResult {
  /** Identificatore tecnico dell'indicatore */
  id: string;
  /** Etichetta leggibile (italiano) */
  label: string;
  /** Contributo normalizzato 0..1 (quanto l'indicatore "punta" verso AI) */
  value: number;
  /** Peso dell'indicatore nello scoring complessivo */
  weight: number;
  /** Spiegazione sintetica del valore rilevato */
  detail: string;
}

export interface FileAnalysis {
  path: string;
  language: string;
  lines: number;
  codeLines: number;
  commentLines: number;
  /** Score statico 0..100 */
  staticScore: number;
  /** Score AI (OpenRouter) 0..100, se l'analisi AI è stata eseguita sul file */
  aiScore: number | null;
  /** Score finale combinato 0..100 */
  score: number;
  risk: RiskLevel;
  /** Indicatori che hanno contribuito allo score statico */
  indicators: IndicatorResult[];
  /** Motivazioni principali (testo sintetico) */
  reasons: string[];
  /** Motivazione fornita dal modello AI, se disponibile */
  aiReason: string | null;
  /** Suggerimenti di revisione manuale */
  suggestions: string[];
}

export interface LanguageStat {
  language: string;
  files: number;
  lines: number;
  avgScore: number;
}

export interface FolderStat {
  folder: string;
  files: number;
  lines: number;
  avgScore: number;
}

export interface CommitInfo {
  sha: string;
  author: string;
  date: string; // ISO
  message: string;
  filesChanged: number | null;
}

export interface CommitAnalysis {
  available: boolean;
  source: string | null; // es. "GitHub API"
  totalCommits: number;
  truncated: boolean;
  authors: { name: string; commits: number }[];
  /** Distribuzione temporale: chiave = mese "YYYY-MM" */
  timeline: { period: string; commits: number }[];
  /** Percentuale (0..1) di messaggi di commit generici */
  genericMessageRatio: number;
  /** Commit con firme esplicite di strumenti AI (Co-Authored-By: Claude, ecc.) */
  aiSignedCommits: number;
  /** Anomalie rilevate, in linguaggio naturale */
  anomalies: string[];
  recentCommits: CommitInfo[];
}

export interface SkippedSummary {
  total: number;
  byReason: { reason: string; count: number }[];
}

export interface AnalysisReport {
  id: string;
  createdAt: string;
  source: { type: "url" | "zip"; label: string };
  /** Percentuale stimata di codice probabilmente generato/assistito da AI (0..100) */
  aiPercent: number;
  /** Percentuale stimata di codice probabilmente manuale (0..100) */
  manualPercent: number;
  confidence: Confidence;
  confidenceReasons: string[];
  totalFiles: number;
  totalLines: number;
  languages: LanguageStat[];
  folders: FolderStat[];
  files: FileAnalysis[];
  commitAnalysis: CommitAnalysis;
  skipped: SkippedSummary;
  /** true se almeno un file è stato valutato anche dal modello AI via OpenRouter */
  aiAnalysisUsed: boolean;
  aiModel: string | null;
  aiAnalysisError: string | null;
}

export interface ProgressEvent {
  type: "progress";
  stage: string;
  percent: number; // 0..100
}

export interface ResultEvent {
  type: "result";
  report: AnalysisReport;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type StreamEvent = ProgressEvent | ResultEvent | ErrorEvent;

export function riskFromScore(score: number): RiskLevel {
  if (score >= 61) return "alto";
  if (score >= 31) return "medio";
  return "basso";
}
