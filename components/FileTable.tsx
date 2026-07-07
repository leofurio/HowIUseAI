"use client";

// Tabella dei file analizzati con riga di dettaglio espandibile
// (indicatori, motivazioni, suggerimenti di revisione).

import { useMemo, useState } from "react";
import { FileAnalysis } from "@/lib/types";

const PAGE_SIZE = 25;

function RiskChip({ risk }: { risk: FileAnalysis["risk"] }) {
  const icon = risk === "alto" ? "▲" : risk === "medio" ? "◆" : "●";
  return (
    <span className={`risk-chip risk-${risk}`}>
      <span aria-hidden>{icon}</span> {risk}
    </span>
  );
}

function FileDetail({ file }: { file: FileAnalysis }) {
  return (
    <div className="detail-box">
      <p style={{ marginBottom: 8 }}>
        <strong>Score statico {file.staticScore}/100</strong>
        {file.aiScore !== null && (
          <>
            {" · "}
            <strong>Score AI {file.aiScore}/100</strong> (analisi semantica via OpenRouter)
          </>
        )}
        {" · "}
        {file.codeLines} righe di codice, {file.commentLines} di commento
      </p>

      <p style={{ fontWeight: 600, marginBottom: 4 }}>Motivazioni dello score (analisi statica)</p>
      <ul style={{ marginBottom: 10 }}>
        {file.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>

      {file.aiReason && (
        <>
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Valutazione del modello AI</p>
          <p style={{ marginBottom: 10 }}>{file.aiReason}</p>
        </>
      )}

      <p style={{ fontWeight: 600, marginBottom: 4 }}>Indicatori</p>
      <div className="scroll-x" style={{ marginBottom: 10 }}>
        <table style={{ maxWidth: 720 }}>
          <thead>
            <tr>
              <th>Indicatore</th>
              <th className="num">Intensità</th>
              <th>Dettaglio</th>
            </tr>
          </thead>
          <tbody>
            {[...file.indicators]
              .sort((a, b) => b.value - a.value)
              .map((ind) => (
                <tr key={ind.id}>
                  <td>{ind.label}</td>
                  <td className="num">{Math.round(ind.value * 100)}%</td>
                  <td className="muted">{ind.detail}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {file.suggestions.length > 0 && (
        <>
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Suggerimenti di revisione manuale</p>
          <ul>
            {file.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function FileTable({ files }: { files: FileAnalysis[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [riskFilter, setRiskFilter] = useState<string>("tutti");
  const [page, setPage] = useState(0);

  const filtered = useMemo(
    () => (riskFilter === "tutti" ? files : files.filter((f) => f.risk === riskFilter)),
    [files, riskFilter]
  );
  const pages = Math.ceil(filtered.length / PAGE_SIZE);
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <label className="small" htmlFor="risk-filter">
          Filtra per rischio:
        </label>
        <select
          id="risk-filter"
          style={{ width: "auto" }}
          value={riskFilter}
          onChange={(e) => {
            setRiskFilter(e.target.value);
            setPage(0);
          }}
        >
          <option value="tutti">tutti ({files.length})</option>
          <option value="alto">alto ({files.filter((f) => f.risk === "alto").length})</option>
          <option value="medio">medio ({files.filter((f) => f.risk === "medio").length})</option>
          <option value="basso">basso ({files.filter((f) => f.risk === "basso").length})</option>
        </select>
        <span className="small">Clic su una riga per vedere motivazioni e indicatori.</span>
      </div>

      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Percorso</th>
              <th>Linguaggio</th>
              <th className="num">Righe</th>
              <th className="num">Score AI (0-100)</th>
              <th>Rischio</th>
              <th>Motivazione principale</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                expanded={expanded === f.path}
                onToggle={() => setExpanded(expanded === f.path ? null : f.path)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <button className="btn-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
            ← Precedente
          </button>
          <span className="small">
            pagina {page + 1} di {pages}
          </span>
          <button className="btn-secondary" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
            Successiva →
          </button>
        </div>
      )}
    </div>
  );
}

function FileRow({
  file,
  expanded,
  onToggle,
}: {
  file: FileAnalysis;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="file-row" onClick={onToggle} aria-expanded={expanded}>
        <td style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.82rem", wordBreak: "break-all" }}>
          {file.path}
        </td>
        <td>{file.language}</td>
        <td className="num">{file.lines.toLocaleString("it-IT")}</td>
        <td className="num" style={{ fontWeight: 600 }}>
          {file.score}
        </td>
        <td>
          <RiskChip risk={file.risk} />
        </td>
        <td className="muted" style={{ maxWidth: 340 }}>
          {file.reasons[0]?.slice(0, 110)}
          {(file.reasons[0]?.length ?? 0) > 110 ? "…" : ""}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} style={{ padding: "4px 10px" }}>
            <FileDetail file={file} />
          </td>
        </tr>
      )}
    </>
  );
}
