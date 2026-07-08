"use client";

// Dashboard principale: input repository/ZIP, avanzamento, KPI, grafici,
// tabella file, analisi commit, export e sezione "Limiti dell'analisi".

import { useRef, useState } from "react";
import { AnalysisReport, StreamEvent } from "@/lib/types";
import { AiShareDonut, ScoreBarChart, TimelineChart } from "@/components/charts";
import { FileTable } from "@/components/FileTable";
import { exportCsv, exportPdf } from "@/components/exports";

type Mode = "url" | "zip";

const AI_MODELS = [
  { id: "anthropic/claude-3.5-haiku", label: "Claude 3.5 Haiku (veloce, economico)" },
  { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5 (più accurato)" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o mini" },
  { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash" },
];

export default function Home() {
  const [mode, setMode] = useState<Mode>("url");
  const [repoUrl, setRepoUrl] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [useAi, setUseAi] = useState(false);
  const [aiModel, setAiModel] = useState(AI_MODELS[0].id);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState("");
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function startAnalysis() {
    setError(null);
    setReport(null);
    setRunning(true);
    setStage("Avvio dell'analisi");
    setPercent(2);

    try {
      let res: Response;
      if (mode === "url") {
        res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl, useAi, aiModel }),
        });
      } else {
        if (!zipFile) throw new Error("Selezionare un file ZIP.");
        const form = new FormData();
        form.set("file", zipFile);
        form.set("useAi", String(useAi));
        form.set("aiModel", aiModel);
        res = await fetch("/api/analyze", { method: "POST", body: form });
      }
      if (!res.ok || !res.body) {
        throw new Error(`Errore del server (HTTP ${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as StreamEvent;
          if (event.type === "progress") {
            setStage(event.stage);
            setPercent(event.percent);
          } else if (event.type === "result") {
            setReport(event.report);
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore imprevisto.");
    } finally {
      setRunning(false);
    }
  }

  const canStart = !running && (mode === "url" ? repoUrl.trim().length > 0 : zipFile !== null);

  return (
    <main className="container">
      <header style={{ marginBottom: 20 }}>
        <h1>AI Code Usage Analyzer</h1>
        <p className="muted" style={{ marginTop: 4 }}>
          Stima probabilistica di quanta parte del codice di un repository è stata generata o
          assistita da AI, sulla base di indicatori tecnici e stilistici.{" "}
          <strong>Non è una certezza: è una stima a supporto della governance.</strong>
        </p>
      </header>

      {/* ── Input ─────────────────────────────────────────────── */}
      <section className="card" aria-label="Sorgente da analizzare">
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={mode === "url"}
            className={`tab ${mode === "url" ? "active" : ""}`}
            onClick={() => setMode("url")}
          >
            URL repository
          </button>
          <button
            role="tab"
            aria-selected={mode === "zip"}
            className={`tab ${mode === "zip" ? "active" : ""}`}
            onClick={() => setMode("zip")}
          >
            Upload ZIP
          </button>
        </div>

        {mode === "url" ? (
          <div>
            <label className="small" htmlFor="repo-url">
              URL del repository (GitHub, GitLab o Bitbucket, pubblico)
            </label>
            <input
              id="repo-url"
              type="url"
              placeholder="https://github.com/owner/repository"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              style={{ marginTop: 4 }}
            />
          </div>
        ) : (
          <div>
            <label className="small" htmlFor="zip-file">
              Archivio ZIP con il codice sorgente (max ~4 MB — escludere binari e dipendenze)
            </label>
            <div style={{ marginTop: 6 }}>
              <input
                ref={fileInputRef}
                id="zip-file"
                type="file"
                accept=".zip"
                onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
              />
            </div>
            {zipFile && (
              <p className="small" style={{ marginTop: 4 }}>
                Selezionato: {zipFile.name} ({(zipFile.size / 1024 / 1024).toFixed(2)} MB)
              </p>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.9rem" }}>
            <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
            Aggiungi analisi AI via OpenRouter (opzionale)
          </label>
          {useAi && (
            <select value={aiModel} onChange={(e) => setAiModel(e.target.value)} style={{ width: "auto" }}>
              {AI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </div>
        {useAi && (
          <p className="small" style={{ marginTop: 6 }}>
            Richiede la variabile d&apos;ambiente <code>OPENROUTER_API_KEY</code> sul server. Senza
            chiave, l&apos;analisi prosegue in modalità solo statica.
          </p>
        )}

        <div style={{ marginTop: 18 }}>
          <button className="btn-primary" onClick={startAnalysis} disabled={!canStart}>
            {running ? "Analisi in corso…" : "Avvia analisi"}
          </button>
        </div>

        {running && (
          <div style={{ marginTop: 16 }} aria-live="polite">
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span className="small">{stage}</span>
              <span className="small">{percent}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
        )}

        {error && (
          <div className="error-box" style={{ marginTop: 16 }} role="alert">
            {error}
          </div>
        )}
      </section>

      {report && <ReportView report={report} />}

      <LimitsSection />
    </main>
  );
}

function ReportView({ report }: { report: AnalysisReport }) {
  const confidenceLabel = { basso: "bassa", medio: "media", alto: "alta" }[report.confidence];

  return (
    <>
      {/* ── KPI ───────────────────────────────────────────────── */}
      <section className="card" aria-label="Riepilogo">
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h2>
            Riepilogo — <span className="muted">{report.source.label}</span>
          </h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-secondary" onClick={() => exportPdf(report)}>
              Esporta PDF
            </button>
            <button className="btn-secondary" onClick={() => exportCsv(report)}>
              Esporta CSV/Excel
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
          <AiShareDonut aiPercent={report.aiPercent} />
          <div className="kpi-grid" style={{ flex: 1, minWidth: 280 }}>
            <div className="kpi">
              <div className="value">{report.totalFiles.toLocaleString("it-IT")}</div>
              <div className="label">file analizzati</div>
            </div>
            <div className="kpi">
              <div className="value">{report.totalLines.toLocaleString("it-IT")}</div>
              <div className="label">righe di codice</div>
            </div>
            <div className="kpi">
              <div className="value">{report.languages.length}</div>
              <div className="label">linguaggi rilevati</div>
            </div>
            <div className="kpi">
              <div className="value" style={{ textTransform: "capitalize" }}>{confidenceLabel}</div>
              <div className="label">confidenza della stima</div>
            </div>
          </div>
        </div>

        <div className="notice" style={{ marginTop: 16 }}>
          <strong>Stima probabilistica.</strong> Non è possibile stabilire con certezza se un codice
          è stato scritto da un&apos;AI: il valore indica solo la probabilità sulla base di indicatori
          tecnici e stilistici.{" "}
          {report.aiAnalysisUsed
            ? `Modalità: analisi statica + analisi AI (${report.aiModel}) sui file più sospetti.`
            : "Modalità: solo analisi statica (nessuna chiamata a modelli AI)."}
        </div>

        {report.aiAnalysisError && (
          <div className="notice" style={{ marginTop: 8 }}>
            Analisi AI parziale: {report.aiAnalysisError}
          </div>
        )}

        <details style={{ marginTop: 12 }}>
          <summary className="small" style={{ cursor: "pointer" }}>
            Come è stata calcolata la confidenza · file esclusi ({report.skipped.total})
          </summary>
          <ul className="small" style={{ paddingLeft: 20, marginTop: 8 }}>
            {report.confidenceReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {report.skipped.byReason.length > 0 && (
            <>
              <p className="small" style={{ marginTop: 8, fontWeight: 600 }}>
                File esclusi dall&apos;analisi:
              </p>
              <ul className="small" style={{ paddingLeft: 20 }}>
                {report.skipped.byReason.map((s) => (
                  <li key={s.reason}>
                    {s.reason}: {s.count}
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      </section>

      {/* ── Grafici ───────────────────────────────────────────── */}
      <section className="card" aria-label="Grafici">
        <div className="charts-grid">
          <div>
            <h2>Score medio per linguaggio</h2>
            <ScoreBarChart
              title="Score medio per linguaggio"
              data={report.languages.slice(0, 10).map((l) => ({
                label: l.language,
                score: l.avgScore,
                meta: `${l.files} file, ${l.lines.toLocaleString("it-IT")} righe`,
              }))}
            />
          </div>
          <div>
            <h2>Score medio per cartella</h2>
            <ScoreBarChart
              title="Score medio per cartella"
              data={report.folders.map((f) => ({
                label: f.folder,
                score: f.avgScore,
                meta: `${f.files} file, ${f.lines.toLocaleString("it-IT")} righe`,
              }))}
            />
          </div>
        </div>
        <p className="small" style={{ marginTop: 10 }}>
          Score 0-30: probabilità bassa · 31-60: media · 61-80: alta · 81-100: molto alta.
        </p>
      </section>

      {/* ── Tabella file ──────────────────────────────────────── */}
      <section className="card" aria-label="File analizzati">
        <h2>File analizzati (ordinati per score)</h2>
        <FileTable files={report.files} />
      </section>

      {/* ── Cronologia Git ────────────────────────────────────── */}
      <section className="card" aria-label="Analisi cronologia Git">
        <h2>Analisi cronologia Git</h2>
        {report.commitAnalysis.available ? (
          <CommitSection report={report} />
        ) : (
          <>
            {report.commitAnalysis.aiBranches.length > 0 && (
              <div className="notice" style={{ marginBottom: 12 }}>
                <strong>
                  {report.commitAnalysis.aiBranches.length} branch con nomi da strumenti AI:
                </strong>{" "}
                {report.commitAnalysis.aiBranches.slice(0, 6).map((b) => b.name).join(", ")}
              </div>
            )}
            <p className="muted">
              Cronologia non disponibile per questa analisi (upload ZIP oppure API del provider non
              raggiungibile). Analizzando un URL GitHub/GitLab/Bitbucket la cronologia viene inclusa
              automaticamente.
            </p>
          </>
        )}
      </section>
    </>
  );
}

function CommitSection({ report }: { report: AnalysisReport }) {
  const ca = report.commitAnalysis;
  return (
    <div>
      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="value">
            {ca.totalCommits}
            {ca.truncated ? "+" : ""}
          </div>
          <div className="label">commit analizzati ({ca.source})</div>
        </div>
        <div className="kpi">
          <div className="value">{ca.authors.length}</div>
          <div className="label">autori</div>
        </div>
        <div className="kpi">
          <div className="value">{Math.round(ca.genericMessageRatio * 100)}%</div>
          <div className="label">messaggi di commit generici</div>
        </div>
        <div className="kpi">
          <div className="value">{ca.aiSignedCommits}</div>
          <div className="label">commit con firma AI esplicita</div>
        </div>
        <div className="kpi">
          <div className="value">
            {ca.aiBranches.length}
            {ca.totalBranches !== null ? ` / ${ca.totalBranches + ca.aiBranches.filter((b) => b.state === "chiuso").length}` : ""}
          </div>
          <div className="label">branch con nomi da strumenti AI (inclusi chiusi)</div>
        </div>
        <div className="kpi">
          <div className="value">{Math.round(ca.aiCommitRatio * 100)}%</div>
          <div className="label">commit da autori AI o con firma AI</div>
        </div>
      </div>

      {ca.aiAuthors.length > 0 && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>Autori di commit riconducibili a strumenti AI:</strong>
          <ul style={{ paddingLeft: 18, marginTop: 4 }}>
            {ca.aiAuthors.slice(0, 8).map((a) => (
              <li key={a.name}>
                {a.name} — {a.tool} ({a.commits} commit)
              </li>
            ))}
          </ul>
        </div>
      )}

      {ca.blame && (ca.blame.available || ca.blame.note) && (
        <div className={ca.blame.available ? "notice" : "detail-box"} style={{ marginBottom: 16 }}>
          {ca.blame.available ? (
            <>
              <strong>Autori delle righe (git blame)</strong> — sui {ca.blame.filesAnalyzed} file più
              sospetti: {ca.blame.aiLines.toLocaleString("it-IT")} righe su{" "}
              {ca.blame.totalLines.toLocaleString("it-IT")} (
              {Math.round((ca.blame.aiLines / Math.max(1, ca.blame.totalLines)) * 100)}%) provengono da
              commit attribuiti a strumenti AI.
            </>
          ) : (
            <span className="small">{ca.blame.note}</span>
          )}
        </div>
      )}

      {ca.aiBranches.length > 0 && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>Branch riconducibili a strumenti AI:</strong>
          <ul style={{ paddingLeft: 18, marginTop: 4 }}>
            {ca.aiBranches.slice(0, 10).map((b) => (
              <li key={b.name}>
                <code>{b.name}</code> — {b.tool}
                {b.state === "chiuso" ? " (branch chiuso/cancellato)" : ""}
              </li>
            ))}
            {ca.aiBranches.length > 10 && <li>… e altri {ca.aiBranches.length - 10}</li>}
          </ul>
        </div>
      )}

      {ca.anomalies.length > 0 && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>Anomalie rilevate:</strong>
          <ul style={{ paddingLeft: 18, marginTop: 4 }}>
            {ca.anomalies.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      <h2 style={{ fontSize: "0.95rem" }}>Distribuzione temporale dei commit</h2>
      <TimelineChart data={ca.timeline} />

      <details style={{ marginTop: 12 }}>
        <summary className="small" style={{ cursor: "pointer" }}>
          Autori principali e ultimi commit
        </summary>
        <div className="scroll-x" style={{ marginTop: 8 }}>
          <table style={{ maxWidth: 700 }}>
            <thead>
              <tr>
                <th>Autore</th>
                <th className="num">Commit</th>
              </tr>
            </thead>
            <tbody>
              {ca.authors.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td className="num">{a.commits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="scroll-x" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>SHA</th>
                <th>Data</th>
                <th>Autore</th>
                <th>Messaggio</th>
              </tr>
            </thead>
            <tbody>
              {ca.recentCommits.map((c) => (
                <tr key={c.sha}>
                  <td style={{ fontFamily: "ui-monospace, monospace" }}>{c.sha}</td>
                  <td>{c.date ? new Date(c.date).toLocaleDateString("it-IT") : "—"}</td>
                  <td>{c.author}</td>
                  <td className="muted">{c.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function LimitsSection() {
  return (
    <section className="card" aria-label="Limiti dell'analisi">
      <h2>Limiti dell&apos;analisi</h2>
      <ul style={{ paddingLeft: 20, display: "grid", gap: 6 }}>
        <li>
          Il risultato è <strong>solo una stima probabilistica</strong>: non esiste un metodo
          infallibile per riconoscere il codice generato da AI.
        </li>
        <li>
          Codice scritto da sviluppatori molto ordinati e disciplinati può presentare gli stessi
          indicatori del codice generato da AI (falsi positivi).
        </li>
        <li>
          Codice generato da AI e poi modificato manualmente può risultare difficile da rilevare
          (falsi negativi).
        </li>
        <li>
          Gli indicatori stilistici dipendono dal linguaggio e dalle convenzioni del team: la stessa
          soglia non vale per tutti i progetti.
        </li>
        <li>
          Il risultato va usato come <strong>supporto alla governance</strong> (IT Quality
          Assurance, Software Engineering Governance, DevOps Governance) — mai come prova
          definitiva nei confronti di una persona o di un fornitore.
        </li>
      </ul>
    </section>
  );
}
