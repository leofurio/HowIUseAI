// API route serverless (compatibile Vercel) che esegue l'analisi e trasmette
// eventi di avanzamento in streaming NDJSON:
//   {"type":"progress","stage":"...","percent":42}
//   {"type":"result","report":{...}}
//   {"type":"error","message":"..."}

import { NextRequest } from "next/server";
import { analyzeZip } from "@/lib/analyze";
import { downloadRepoZip, parseRepoUrl } from "@/lib/acquisition";
import { analyzeCommits } from "@/lib/commits";
import { StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300; // secondi (su Vercel Hobby il limite effettivo è più basso)
export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // limite body Vercel: 4.5 MB

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        const contentType = req.headers.get("content-type") ?? "";
        let zipData: ArrayBuffer;
        let sourceType: "url" | "zip";
        let sourceLabel: string;
        let useAi = false;
        let aiModel: string | undefined;
        let commitAnalysis;

        if (contentType.includes("multipart/form-data")) {
          // Modalità upload ZIP
          send({ type: "progress", stage: "Lettura archivio caricato", percent: 4 });
          const form = await req.formData();
          const file = form.get("file");
          if (!(file instanceof File)) throw new Error("Nessun file ZIP ricevuto.");
          if (file.size > MAX_UPLOAD_BYTES) {
            throw new Error("File troppo grande: il limite di upload su Vercel è ~4 MB. Rimuovere binari e dipendenze dallo ZIP.");
          }
          useAi = form.get("useAi") === "true";
          aiModel = (form.get("aiModel") as string) || undefined;
          zipData = await file.arrayBuffer();
          sourceType = "zip";
          sourceLabel = file.name;
        } else {
          // Modalità URL repository
          const body = await req.json();
          const repoUrl: string = body.repoUrl ?? "";
          useAi = Boolean(body.useAi);
          aiModel = body.aiModel || undefined;
          const ref = parseRepoUrl(repoUrl);
          send({ type: "progress", stage: `Download di ${ref.label}`, percent: 5 });
          const { zip, branch } = await downloadRepoZip(ref);
          zipData = zip;
          sourceType = "url";
          sourceLabel = `${ref.label} (${branch})`;
          send({ type: "progress", stage: "Analisi cronologia Git", percent: 10 });
          commitAnalysis = await analyzeCommits(ref, branch);
        }

        const report = await analyzeZip(zipData, {
          sourceType,
          sourceLabel,
          useAi,
          aiModel,
          commitAnalysis,
          onProgress: (stage, percent) => send({ type: "progress", stage, percent }),
        });

        send({ type: "progress", stage: "Completato", percent: 100 });
        send({ type: "result", report });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Errore imprevisto durante l'analisi.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
