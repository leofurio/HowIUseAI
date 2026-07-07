// Modulo analisi statica: calcola per ogni file una serie di indicatori
// stilistici e strutturali che, combinati, producono uno score 0..100 di
// probabilità che il codice sia stato generato o assistito da AI.
//
// Ogni indicatore restituisce un valore normalizzato 0..1 e una spiegazione,
// così lo score finale resta spiegabile all'utente.

import { FileAnalysis, IndicatorResult, riskFromScore } from "./types";

interface LineStats {
  lines: string[];
  nonEmpty: string[];
  codeLines: string[];
  commentLines: string[];
}

const COMMENT_PREFIXES = ["//", "#", "--", ";", "*", "/*", "'''", '"""', "<!--"];

function splitLines(content: string): LineStats {
  const lines = content.split("\n");
  const nonEmpty: string[] = [];
  const codeLines: string[] = [];
  const commentLines: string[] = [];
  let inBlockComment = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    nonEmpty.push(line);

    if (inBlockComment) {
      commentLines.push(line);
      if (line.includes("*/") || line.includes("'''") || line.includes('"""') || line.includes("-->")) {
        inBlockComment = false;
      }
      continue;
    }
    const startsBlock =
      (line.startsWith("/*") && !line.includes("*/")) ||
      ((line.startsWith("'''") || line.startsWith('"""')) && line.length <= 3) ||
      (line.startsWith("<!--") && !line.includes("-->"));
    if (startsBlock) {
      inBlockComment = true;
      commentLines.push(line);
      continue;
    }
    if (COMMENT_PREFIXES.some((p) => line.startsWith(p))) {
      commentLines.push(line);
    } else {
      codeLines.push(line);
    }
  }
  return { lines, nonEmpty, codeLines, commentLines };
}

// Frasi ricorrenti nei commenti/docstring generati dai modelli AI.
const AI_COMMENT_PHRASES: RegExp[] = [
  /this (function|method|class|component|module) (is responsible for|handles|takes|returns|provides)/i,
  /^(initialize|initializes|create|creates|define|defines|set up|sets up) (the|a|an) /i,
  /helper (function|method) (to|for|that)/i,
  /note that /i,
  /ensure[s]? that /i,
  /it'?s important to (note|remember)/i,
  /as (mentioned|shown|described) (above|below|earlier)/i,
  /step \d+[:.]/i,
  /^(first|then|next|finally),? we /i,
  /placeholder for /i,
  /in a (real|production) (app|application|environment|scenario)/i,
  /you (can|may|might|should) (also |now |then )?(customize|adjust|modify|extend|replace)/i,
  /feel free to /i,
  /questa (funzione|classe|componente) (gestisce|si occupa|restituisce|crea)/i,
  /nota che /i,
  /assicurarsi che /i,
];

// Marcatori espliciti di generazione AI.
const AI_EXPLICIT_MARKERS: RegExp[] = [
  /generated (by|with) (ai|chatgpt|gpt|claude|copilot|gemini|cursor|codeium)/i,
  /co-authored-by:\s*(claude|copilot|chatgpt|cursor|aider|devin)/i,
  /as an ai (language )?model/i,
  /🤖/,
];

// Marcatori di "imperfezione umana": la loro presenza abbassa lo score.
const HUMAN_MARKERS: RegExp[] = [
  /\b(TODO|FIXME|HACK|XXX|WTF|kludge|workaround)\b/i,
  /\b(temp|tmp|foo|bar|baz|asdf|qwerty)\b/,
  /console\.log\(|print\(["']debug|dd\(|var_dump\(|System\.out\.println\(["']DEBUG/i,
  /\bwhy (does|is|do)\b.*\?/i,
  /\b(ugly|dirty|gross|sorry|lazy|don'?t ask)\b/i,
];

const STANDARD_AI_NAMES = new Set([
  "result", "results", "data", "response", "item", "items", "value", "values",
  "options", "config", "params", "payload", "input", "output", "handler",
  "fetchdata", "getdata", "processdata", "handleclick", "handlesubmit",
  "handlechange", "isvalid", "isloading", "haserror", "errormessage",
  "formatdate", "parseresponse", "validateinput", "helper", "utils", "temp",
]);

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

type Indicator = (content: string, stats: LineStats, language: string) => Omit<IndicatorResult, "weight">;

/** 1. Uniformità dello stile: varianza bassa della lunghezza riga e indentazione perfetta. */
const styleUniformity: Indicator = (_content, stats) => {
  const lengths = stats.codeLines.map((l) => l.length).filter((n) => n > 3);
  if (lengths.length < 15) {
    return { id: "style_uniformity", label: "Uniformità dello stile", value: 0.3, detail: "campione troppo piccolo per valutare la varianza dello stile" };
  }
  const cv = stddev(lengths) / Math.max(1, mean(lengths)); // coefficiente di variazione
  // Codice umano tipico: cv ~0.6-0.9. Codice molto uniforme: cv < 0.45.
  const value = clamp01((0.7 - cv) / 0.45);
  return {
    id: "style_uniformity",
    label: "Uniformità dello stile",
    value,
    detail: `variabilità della lunghezza delle righe ${cv < 0.45 ? "molto bassa" : cv < 0.6 ? "bassa" : "nella norma"} (CV=${cv.toFixed(2)})`,
  };
};

/** 2. Commenti eccessivamente descrittivi o generici. */
const commentStyle: Indicator = (_content, stats) => {
  const total = stats.nonEmpty.length;
  const comments = stats.commentLines;
  if (total < 10) {
    return { id: "comment_style", label: "Commenti descrittivi/generici", value: 0.2, detail: "file troppo piccolo per valutare i commenti" };
  }
  const density = comments.length / total;
  let genericHits = 0;
  for (const c of comments) {
    if (AI_COMMENT_PHRASES.some((p) => p.test(c))) genericHits++;
  }
  const genericRatio = comments.length ? genericHits / comments.length : 0;
  // Densità di commenti sopra il 25% + frasi generiche => forte segnale.
  const value = clamp01(clamp01((density - 0.12) / 0.25) * 0.5 + clamp01(genericRatio / 0.25) * 0.5);
  const parts: string[] = [`densità commenti ${(density * 100).toFixed(0)}%`];
  if (genericHits > 0) parts.push(`${genericHits} commenti con formulazioni tipiche dei modelli AI`);
  return { id: "comment_style", label: "Commenti descrittivi/generici", value, detail: parts.join("; ") };
};

/** 3. Nomi molto standardizzati. */
const namingPatterns: Indicator = (content, stats) => {
  const identifiers = new Set<string>();
  const idRegex = /\b(?:function|def|const|let|var|class|fn|func)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = idRegex.exec(content)) !== null) identifiers.add(m[1]);
  if (identifiers.size < 4) {
    return { id: "naming", label: "Nomi standardizzati", value: 0.25, detail: "pochi identificatori dichiarati nel file" };
  }
  let standard = 0;
  let descriptiveLong = 0;
  for (const id of identifiers) {
    const lower = id.toLowerCase();
    if (STANDARD_AI_NAMES.has(lower)) standard++;
    // Nomi lunghi perfettamente descrittivi (getUserProfileData, calculateTotalPrice…)
    const words = id.split(/(?=[A-Z])|_/).filter(Boolean);
    if (words.length >= 3 && id.length >= 16) descriptiveLong++;
  }
  const ratio = (standard + descriptiveLong * 0.7) / identifiers.size;
  const value = clamp01(ratio / 0.5);
  return {
    id: "naming",
    label: "Nomi standardizzati",
    value,
    detail: `${standard} nomi generici e ${descriptiveLong} nomi lunghi perfettamente descrittivi su ${identifiers.size} identificatori`,
  };
};

/** 4. Pattern espliciti tipici dei modelli AI. */
const aiPatterns: Indicator = (content) => {
  let hits = 0;
  const found: string[] = [];
  for (const p of AI_EXPLICIT_MARKERS) {
    const match = content.match(p);
    if (match) {
      hits += 3;
      found.push(`marcatore esplicito "${match[0].slice(0, 40)}"`);
    }
  }
  // Commenti-divisore perfetti (// ────, # =====, /* --- Section --- */)
  const dividers = (content.match(/^[\t ]*(\/\/|#|--)\s*[-=─—*]{5,}/gm) ?? []).length;
  if (dividers >= 3) {
    hits += 1;
    found.push(`${dividers} commenti-divisore di sezione`);
  }
  // Commenti numerati a passi (// 1. ... // 2. ...)
  const steps = (content.match(/^[\t ]*(\/\/|#)\s*\d+[.)]\s/gm) ?? []).length;
  if (steps >= 3) {
    hits += 1;
    found.push(`${steps} commenti a passi numerati`);
  }
  const value = clamp01(hits / 4);
  return {
    id: "ai_patterns",
    label: "Pattern tipici dei modelli AI",
    value,
    detail: found.length ? found.join("; ") : "nessun pattern esplicito rilevato",
  };
};

/** 5. Ripetitività: righe duplicate e blocchi simili. */
const repetitiveness: Indicator = (_content, stats) => {
  const code = stats.codeLines;
  if (code.length < 20) {
    return { id: "repetition", label: "Ripetitività del codice", value: 0.2, detail: "file troppo piccolo per valutare la ripetitività" };
  }
  const normalized = code.map((l) => l.replace(/["'`][^"'`]*["'`]/g, "S").replace(/\b\d+\b/g, "N"));
  const seen = new Map<string, number>();
  for (const l of normalized) {
    if (l.length < 8) continue;
    seen.set(l, (seen.get(l) ?? 0) + 1);
  }
  let dup = 0;
  let considered = 0;
  for (const [, count] of seen) {
    considered += count;
    if (count > 1) dup += count - 1;
  }
  const dupRatio = considered ? dup / considered : 0;

  // Similarità tra blocchi: finestre di 4 righe normalizzate ripetute.
  const windows = new Map<string, number>();
  for (let i = 0; i + 4 <= normalized.length; i++) {
    const key = normalized.slice(i, i + 4).join("|");
    windows.set(key, (windows.get(key) ?? 0) + 1);
  }
  let dupWindows = 0;
  for (const [, count] of windows) if (count > 1) dupWindows += count - 1;
  const blockRatio = windows.size ? dupWindows / windows.size : 0;

  const value = clamp01(dupRatio / 0.25) * 0.6 + clamp01(blockRatio / 0.12) * 0.4;
  return {
    id: "repetition",
    label: "Ripetitività e blocchi simili",
    value: clamp01(value),
    detail: `${(dupRatio * 100).toFixed(0)}% di righe duplicate, ${dupWindows} blocchi di 4 righe ripetuti`,
  };
};

/** 6. Assenza di imperfezioni umane (TODO, debug, codice commentato…). */
const humanImperfections: Indicator = (content, stats) => {
  if (stats.nonEmpty.length < 25) {
    return { id: "no_human_marks", label: "Assenza di imperfezioni umane", value: 0.25, detail: "file troppo piccolo per una valutazione affidabile" };
  }
  let humanHits = 0;
  for (const p of HUMAN_MARKERS) if (p.test(content)) humanHits++;
  // Codice commentato-out (righe di codice dentro commenti)
  const commentedOutCode = stats.commentLines.filter((c) =>
    /[;{}()=]\s*$/.test(c) || /^(\/\/|#)\s*(if|for|while|return|const|let|var|def|import)\b/.test(c)
  ).length;
  if (commentedOutCode >= 2) humanHits += 2;
  // Spazi finali / indentazione mista: imperfezioni tipicamente umane
  if (/[ \t]+$/m.test(content)) humanHits++;
  const value = clamp01(1 - humanHits / 4);
  return {
    id: "no_human_marks",
    label: "Assenza di imperfezioni umane",
    value,
    detail:
      humanHits === 0
        ? "nessun TODO/FIXME, nessun codice commentato, nessuna traccia di debug: pulizia insolita"
        : `${humanHits} tracce di lavorazione umana (TODO, debug, codice commentato…)`,
  };
};

/** 7. Struttura scolastica / didascalica. */
const scholasticStructure: Indicator = (content, stats) => {
  const funcRegex = /^[\t ]*(?:export\s+)?(?:async\s+)?(?:function|def|fn|func|public|private|protected)\b/;
  const lines = content.split("\n");
  let funcs = 0;
  let funcsWithCommentAbove = 0;
  for (let i = 0; i < lines.length; i++) {
    if (funcRegex.test(lines[i])) {
      funcs++;
      const prev = (lines[i - 1] ?? "").trim();
      const prev2 = (lines[i - 2] ?? "").trim();
      if (
        COMMENT_PREFIXES.some((p) => prev.startsWith(p)) ||
        prev.endsWith("*/") ||
        prev2.startsWith("/**") ||
        prev.startsWith('"""')
      ) {
        funcsWithCommentAbove++;
      }
    }
  }
  if (funcs < 3) {
    return { id: "scholastic", label: "Struttura scolastica", value: 0.25, detail: "poche funzioni dichiarate per valutare la struttura" };
  }
  const ratio = funcsWithCommentAbove / funcs;
  const value = clamp01((ratio - 0.5) / 0.5);
  return {
    id: "scholastic",
    label: "Struttura scolastica/didascalica",
    value,
    detail: `${funcsWithCommentAbove} funzioni su ${funcs} precedute da un commento descrittivo`,
  };
};

/** 8. Docstring molto formali (JSDoc/@param/@returns, Args:/Returns:). */
const formalDocstrings: Indicator = (content) => {
  const jsdocBlocks = (content.match(/\/\*\*[\s\S]*?\*\//g) ?? []);
  const pyDocstrings = (content.match(/(?:"""|''')[\s\S]*?(?:"""|''')/g) ?? []);
  let formal = 0;
  for (const block of [...jsdocBlocks, ...pyDocstrings]) {
    const hasTags = /@param|@returns?|@throws|@example|Args:|Returns:|Raises:|Parameters\s*[-:]{1,}/.test(block);
    const hasProse = block.replace(/[/*'"\s]/g, "").length > 40;
    if (hasTags && hasProse) formal++;
  }
  const total = jsdocBlocks.length + pyDocstrings.length;
  if (total === 0) {
    return { id: "docstrings", label: "Docstring formali", value: 0.15, detail: "nessuna docstring nel file" };
  }
  const value = clamp01((formal / total) * clamp01(total / 3));
  return {
    id: "docstrings",
    label: "Docstring molto formali",
    value,
    detail: `${formal} docstring complete e formali su ${total} presenti`,
  };
};

const INDICATOR_WEIGHTS: Record<string, number> = {
  style_uniformity: 1.0,
  comment_style: 1.4,
  naming: 1.0,
  ai_patterns: 1.8,
  repetition: 1.0,
  no_human_marks: 1.1,
  scholastic: 1.0,
  docstrings: 1.0,
};

const INDICATORS: Indicator[] = [
  styleUniformity,
  commentStyle,
  namingPatterns,
  aiPatterns,
  repetitiveness,
  humanImperfections,
  scholasticStructure,
  formalDocstrings,
];

const SUGGESTION_BY_INDICATOR: Record<string, string> = {
  comment_style: "Verificare se i commenti descrivono scelte reali del progetto o sono spiegazioni generiche del linguaggio.",
  ai_patterns: "Controllare i marcatori espliciti di generazione AI e chiedere conferma all'autore del file.",
  repetition: "Valutare un refactoring dei blocchi duplicati e verificare se sono stati generati in blocco.",
  no_human_marks: "Confrontare con la cronologia Git: file 'perfetti' apparsi in un unico commit meritano revisione.",
  style_uniformity: "Confrontare lo stile con altri file dello stesso autore per verificare la coerenza.",
  scholastic: "Verificare con l'autore la provenienza della struttura molto didascalica.",
  docstrings: "Controllare se le docstring corrispondono al comportamento reale del codice.",
  naming: "Verificare che i nomi rispecchino il dominio applicativo e non convenzioni generiche.",
};

/** Analizza un singolo file e produce score statico + spiegazioni. */
export function analyzeFile(path: string, content: string, language: string): FileAnalysis {
  const stats = splitLines(content);
  const indicators: IndicatorResult[] = INDICATORS.map((fn) => {
    const r = fn(content, stats, language);
    return { ...r, weight: INDICATOR_WEIGHTS[r.id] ?? 1 };
  });

  const totalWeight = indicators.reduce((a, i) => a + i.weight, 0);
  const weighted = indicators.reduce((a, i) => a + i.value * i.weight, 0);
  const staticScore = Math.round((weighted / totalWeight) * 100);

  const sorted = [...indicators].sort((a, b) => b.value * b.weight - a.value * a.weight);
  const reasons = sorted
    .filter((i) => i.value >= 0.45)
    .slice(0, 4)
    .map((i) => `${i.label}: ${i.detail}`);
  if (reasons.length === 0) {
    reasons.push("Nessun indicatore forte: il file presenta caratteristiche compatibili con scrittura manuale.");
  }
  const suggestions = sorted
    .filter((i) => i.value >= 0.55)
    .slice(0, 3)
    .map((i) => SUGGESTION_BY_INDICATOR[i.id])
    .filter(Boolean);

  return {
    path,
    language,
    lines: stats.lines.length,
    codeLines: stats.codeLines.length,
    commentLines: stats.commentLines.length,
    staticScore,
    aiScore: null,
    score: staticScore,
    risk: riskFromScore(staticScore),
    indicators,
    reasons,
    aiReason: null,
    suggestions,
  };
}
