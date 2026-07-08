"use client";

// Modulo export report: CSV (Excel-compatibile) e PDF generati lato client.

import { AnalysisReport } from "@/lib/types";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value: string | number): string {
  const s = String(value);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCsv(report: AnalysisReport) {
  const rows: (string | number)[][] = [
    ["AI Code Usage Analyzer - Report"],
    ["Sorgente", report.source.label],
    ["Data analisi", new Date(report.createdAt).toLocaleString("it-IT")],
    ["Stima codice AI (%)", report.aiPercent],
    ["Stima codice manuale (%)", report.manualPercent],
    ["Confidenza", report.confidence],
    ["File analizzati", report.totalFiles],
    ["Righe analizzate", report.totalLines],
    ["Analisi AI (OpenRouter)", report.aiAnalysisUsed ? `sì (${report.aiModel})` : "no (solo analisi statica)"],
    [
      "Branch con nomi da strumenti AI (inclusi chiusi)",
      report.commitAnalysis.aiBranches
        .map((b) => `${b.name} (${b.tool}${b.state === "chiuso" ? ", chiuso" : ""})`)
        .join(" | ") || "nessuno rilevato",
    ],
    [
      "Autori di commit riconducibili ad AI",
      report.commitAnalysis.aiAuthors.map((a) => `${a.name} (${a.tool}, ${a.commits} commit)`).join(" | ") ||
        "nessuno rilevato",
    ],
    ["Commit da autori AI o con firma AI (%)", Math.round(report.commitAnalysis.aiCommitRatio * 100)],
    [],
    ["Percorso", "Linguaggio", "Righe", "Score statico", "Score AI", "Righe da AI (blame) %", "Score finale", "Rischio", "Motivazioni"],
    ...report.files.map((f) => [
      f.path,
      f.language,
      f.lines,
      f.staticScore,
      f.aiScore ?? "",
      f.aiLineRatio !== null ? Math.round(f.aiLineRatio * 100) : "",
      f.score,
      f.risk,
      f.reasons.join(" | "),
    ]),
  ];
  // BOM + separatore ';' per apertura diretta in Excel (locale IT)
  const csv = "\uFEFF" + rows.map((r) => r.map(csvEscape).join(";")).join("\r\n");
  download(new Blob([csv], { type: "text/csv;charset=utf-8" }), "ai-code-usage-report.csv");
}

export async function exportPdf(report: AnalysisReport) {
  const { default: jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("AI Code Usage Analyzer — Report", 14, 18);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(
    "Stima probabilistica basata su indicatori tecnici e stilistici. Non costituisce una prova definitiva.",
    14,
    24
  );
  doc.setTextColor(0);
  doc.setFontSize(11);

  const summary: [string, string][] = [
    ["Sorgente", report.source.label],
    ["Data analisi", new Date(report.createdAt).toLocaleString("it-IT")],
    ["Stima codice probabilmente AI", `${report.aiPercent}%`],
    ["Stima codice probabilmente manuale", `${report.manualPercent}%`],
    ["Livello di confidenza", report.confidence],
    ["File analizzati", String(report.totalFiles)],
    ["Righe di codice analizzate", report.totalLines.toLocaleString("it-IT")],
    ["Linguaggi", report.languages.map((l) => l.language).join(", ")],
    [
      "Modalità di analisi",
      report.aiAnalysisUsed
        ? `statica + AI via OpenRouter (${report.aiModel})`
        : "solo analisi statica",
    ],
  ];
  autoTable(doc, {
    startY: 30,
    head: [["Riepilogo", ""]],
    body: summary,
    theme: "grid",
    styles: { fontSize: 9 },
    headStyles: { fillColor: [42, 120, 214] },
  });

  autoTable(doc, {
    head: [["File", "Linguaggio", "Righe", "Statico", "AI", "Finale", "Rischio"]],
    body: report.files
      .slice(0, 60)
      .map((f) => [f.path, f.language, f.lines, f.staticScore, f.aiScore ?? "—", f.score, f.risk]),
    styles: { fontSize: 7.5, cellPadding: 1.5 },
    headStyles: { fillColor: [42, 120, 214] },
    columnStyles: { 0: { cellWidth: 70 } },
  });

  const topFiles = report.files.filter((f) => f.score >= 45).slice(0, 12);
  if (topFiles.length > 0) {
    autoTable(doc, {
      head: [["File più sospetti", "Motivazioni principali"]],
      body: topFiles.map((f) => [`${f.path} (${f.score}/100)`, f.reasons.join("\n")]),
      styles: { fontSize: 7.5, cellPadding: 1.5 },
      headStyles: { fillColor: [42, 120, 214] },
      columnStyles: { 0: { cellWidth: 60 } },
    });
  }

  if (report.commitAnalysis.available) {
    autoTable(doc, {
      head: [["Analisi cronologia Git", ""]],
      body: [
        ["Commit analizzati", String(report.commitAnalysis.totalCommits) + (report.commitAnalysis.truncated ? " (troncato)" : "")],
        ["Autori principali", report.commitAnalysis.authors.slice(0, 5).map((a) => `${a.name} (${a.commits})`).join(", ")],
        ["Messaggi generici", `${Math.round(report.commitAnalysis.genericMessageRatio * 100)}%`],
        ["Commit con firma AI", String(report.commitAnalysis.aiSignedCommits)],
        [
          "Branch con nomi da strumenti AI (inclusi chiusi)",
          report.commitAnalysis.aiBranches.length > 0
            ? report.commitAnalysis.aiBranches
                .map((b) => `${b.name} (${b.tool}${b.state === "chiuso" ? ", chiuso" : ""})`)
                .join("\n")
            : `0${report.commitAnalysis.totalBranches !== null ? ` su ${report.commitAnalysis.totalBranches}` : ""}`,
        ],
        [
          "Autori di commit riconducibili ad AI",
          report.commitAnalysis.aiAuthors.length > 0
            ? report.commitAnalysis.aiAuthors.map((a) => `${a.name} (${a.tool}, ${a.commits} commit)`).join("\n")
            : "nessuno rilevato",
        ],
        ["Commit da autori AI o con firma AI", `${Math.round(report.commitAnalysis.aiCommitRatio * 100)}%`],
        [
          "Autori delle righe (git blame)",
          report.commitAnalysis.blame?.available
            ? `${report.commitAnalysis.blame.aiLines} righe su ${report.commitAnalysis.blame.totalLines} attribuite ad AI (${report.commitAnalysis.blame.filesAnalyzed} file analizzati)`
            : report.commitAnalysis.blame?.note ?? "non eseguito",
        ],
        ["Anomalie", report.commitAnalysis.anomalies.join("\n") || "nessuna rilevata"],
      ],
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [42, 120, 214] },
    });
  }

  doc.save("ai-code-usage-report.pdf");
}
