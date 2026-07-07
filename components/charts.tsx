"use client";

// Grafici SVG leggeri: donut AI/manuale e barre orizzontali per categoria.
// Marks sottili, etichette dirette, tooltip su hover, colori dai token CSS.

import { useState } from "react";

interface TooltipState {
  x: number;
  y: number;
  content: string;
}

function useTooltip() {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const show = (e: React.MouseEvent, content: string) =>
    setTip({ x: e.clientX + 12, y: e.clientY + 12, content });
  const hide = () => setTip(null);
  const node = tip ? (
    <div className="viz-tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.content}
    </div>
  ) : null;
  return { show, hide, node };
}

/** Donut a due segmenti: quota AI stimata vs quota manuale. */
export function AiShareDonut({ aiPercent }: { aiPercent: number }) {
  const { show, hide, node } = useTooltip();
  const size = 180;
  const r = 70;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const aiLen = (aiPercent / 100) * circumference;
  // gap di 2px tra i segmenti (spacer su superficie)
  const gap = 2;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
      <svg width={size} height={size} role="img" aria-label={`Stima: ${aiPercent}% codice AI, ${100 - aiPercent}% manuale`}>
        <g transform={`rotate(-90 ${c} ${c})`}>
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke="var(--neutral-fill)"
            strokeWidth={16}
            strokeDasharray={`${Math.max(0, circumference - aiLen - gap)} ${aiLen + gap}`}
            strokeDashoffset={-aiLen - gap / 2}
            onMouseMove={(e) => show(e, `Codice probabilmente manuale: ${100 - aiPercent}%`)}
            onMouseLeave={hide}
          />
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke="var(--series-1)"
            strokeWidth={16}
            strokeLinecap="round"
            strokeDasharray={`${Math.max(0.1, aiLen - gap)} ${circumference}`}
            onMouseMove={(e) => show(e, `Codice probabilmente generato/assistito da AI: ${aiPercent}%`)}
            onMouseLeave={hide}
          />
        </g>
        <text
          x={c}
          y={c - 4}
          textAnchor="middle"
          style={{ fontSize: 30, fontWeight: 650, fill: "var(--text-primary)" }}
        >
          {aiPercent}%
        </text>
        <text x={c} y={c + 18} textAnchor="middle" style={{ fontSize: 11, fill: "var(--text-muted)" }}>
          stima quota AI
        </text>
      </svg>
      <div style={{ fontSize: "0.85rem", display: "grid", gap: 6 }}>
        <span>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "var(--series-1)", marginRight: 7 }} />
          Probabilmente AI · <strong>{aiPercent}%</strong>
        </span>
        <span>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "var(--neutral-fill)", border: "1px solid var(--baseline)", marginRight: 7 }} />
          Probabilmente manuale · <strong>{100 - aiPercent}%</strong>
        </span>
      </div>
      {node}
    </div>
  );
}

export interface BarDatum {
  label: string;
  /** valore 0..100 (score medio) */
  score: number;
  /** contesto per il tooltip */
  meta: string;
}

/** Barre orizzontali (score medio 0-100 per categoria), etichette dirette. */
export function ScoreBarChart({ data, title }: { data: BarDatum[]; title: string }) {
  const { show, hide, node } = useTooltip();
  const rowH = 30;
  const labelW = 130;
  const valueW = 38;
  const chartW = 480;
  const barMax = chartW - labelW - valueW;
  const height = data.length * rowH + 8;

  return (
    <div className="scroll-x">
      <svg width={chartW} height={height} role="img" aria-label={title}>
        {/* asse di riferimento */}
        <line x1={labelW} y1={0} x2={labelW} y2={height - 4} stroke="var(--baseline)" strokeWidth={1} />
        {data.map((d, i) => {
          const y = i * rowH + 6;
          const w = Math.max(2, (d.score / 100) * barMax);
          return (
            <g
              key={d.label}
              onMouseMove={(e) => show(e, `${d.label} — score medio ${d.score}/100 · ${d.meta}`)}
              onMouseLeave={hide}
            >
              <rect x={0} y={y - 4} width={chartW} height={rowH - 4} fill="transparent" />
              <text
                x={labelW - 8}
                y={y + 12}
                textAnchor="end"
                style={{ fontSize: 12, fill: "var(--text-secondary)" }}
              >
                {d.label.length > 16 ? d.label.slice(0, 15) + "…" : d.label}
              </text>
              <rect x={labelW} y={y} width={w} height={14} rx={0} fill="var(--series-1)" />
              <rect x={labelW + Math.max(0, w - 4)} y={y} width={Math.min(4, w)} height={14} rx={3} fill="var(--series-1)" />
              <text
                x={labelW + w + 6}
                y={y + 11.5}
                style={{ fontSize: 12, fill: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}
              >
                {d.score}
              </text>
            </g>
          );
        })}
      </svg>
      {node}
    </div>
  );
}

/** Colonne verticali per la distribuzione temporale dei commit. */
export function TimelineChart({ data }: { data: { period: string; commits: number }[] }) {
  const { show, hide, node } = useTooltip();
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.commits));
  const barW = Math.max(10, Math.min(34, Math.floor(440 / data.length) - 2));
  const chartH = 120;
  const width = data.length * (barW + 2) + 10;

  return (
    <div className="scroll-x">
      <svg width={width} height={chartH + 34} role="img" aria-label="Distribuzione temporale dei commit">
        <line x1={0} y1={chartH + 0.5} x2={width} y2={chartH + 0.5} stroke="var(--baseline)" strokeWidth={1} />
        {data.map((d, i) => {
          const h = Math.max(2, (d.commits / max) * (chartH - 10));
          const x = i * (barW + 2) + 4;
          return (
            <g key={d.period} onMouseMove={(e) => show(e, `${d.period}: ${d.commits} commit`)} onMouseLeave={hide}>
              <rect x={x} y={chartH - h} width={barW} height={h} fill="var(--series-1)" rx={0} />
              <rect x={x} y={chartH - h} width={barW} height={Math.min(4, h)} rx={2} fill="var(--series-1)" />
              {(data.length <= 14 || i % Math.ceil(data.length / 12) === 0) && (
                <text
                  x={x + barW / 2}
                  y={chartH + 16}
                  textAnchor="middle"
                  style={{ fontSize: 9.5, fill: "var(--text-muted)" }}
                >
                  {d.period.slice(2)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {node}
    </div>
  );
}
