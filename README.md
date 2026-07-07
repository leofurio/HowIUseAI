# AI Code Usage Analyzer

Web application che stima **quanta parte del codice di un repository è stata probabilmente generata o assistita da AI**, sulla base di indicatori tecnici e stilistici.

> ⚠️ Il risultato è una **stima probabilistica**, non una certezza. Non esiste un metodo infallibile per riconoscere codice generato da AI: l'output va usato come supporto alla governance (IT Quality Assurance, Software Engineering Governance, DevOps Governance), mai come prova definitiva.

## Funzionalità

- **Acquisizione repository** da URL (GitHub, GitLab, Bitbucket — repo pubblici, o privati con token) oppure tramite **upload ZIP**.
- **Filtro automatico** dei file non rilevanti: binari, immagini, `node_modules`, `vendor`, `dist`, `build`, `.git`, file minificati, lockfile e file generati automaticamente.
- **Analisi statica locale** (nessuna chiamata esterna) basata su indicatori spiegabili:
  - uniformità dello stile di scrittura;
  - commenti eccessivamente descrittivi o generici;
  - nomi di variabili/funzioni molto standardizzati;
  - pattern tipici dei modelli AI (marcatori espliciti, divisori di sezione, passi numerati);
  - ripetitività e somiglianza tra blocchi di codice;
  - assenza di imperfezioni umane (TODO, debug, codice commentato);
  - struttura scolastica/didascalica;
  - docstring molto formali.
- **Analisi AI opzionale via OpenRouter**: i file con score statico più alto vengono sottoposti a un LLM per una seconda valutazione semantica, con motivazione. Lo score finale combina 60% analisi statica e 40% analisi AI; nel report è sempre indicato quali risultati derivano dall'una e dall'altra.
- **Analisi cronologia Git** (per analisi da URL): numero di commit, autori, distribuzione temporale, messaggi generici, firme AI esplicite (`Co-Authored-By: Claude` ecc.), burst anomali di commit compatibili con generazione massiva.
- **Dashboard** con KPI, donut quota AI/manuale, grafici per linguaggio e per cartella, tabella file con dettaglio espandibile (score, rischio, motivazioni, suggerimenti di revisione).
- **Export report** in PDF e CSV (apribile in Excel).

### Scala dello score (per file, 0-100)

| Fascia | Interpretazione |
| --- | --- |
| 0–30 | bassa probabilità di codice AI |
| 31–60 | probabilità media |
| 61–80 | probabilità alta |
| 81–100 | probabilità molto alta |

Ogni score è **spiegabile**: la dashboard mostra gli indicatori che lo hanno determinato e la loro intensità.

## Architettura (moduli)

| Modulo | File | Ruolo |
| --- | --- | --- |
| Acquisizione repository | `lib/acquisition.ts` | download archivio ZIP da GitHub/GitLab/Bitbucket via HTTPS (nessun binario `git`, serverless-friendly) |
| Estrazione file | `lib/analyze.ts` | unzip in memoria con JSZip |
| Filtro file non rilevanti | `lib/filter.ts` | esclusioni per cartella, estensione, dimensione, contenuto |
| Analisi codice + AI score | `lib/staticAnalysis.ts` | 8 indicatori pesati → score 0-100 spiegabile |
| Analisi commit | `lib/commits.ts` | cronologia via API del provider, anomalie |
| Analisi AI (opzionale) | `lib/openrouter.ts` | chiamate OpenRouter con gestione errori/rate limit |
| API | `app/api/analyze/route.ts` | route serverless con progresso in streaming NDJSON |
| Dashboard | `app/page.tsx`, `components/` | UI, grafici SVG, tabella file |
| Export report | `components/exports.ts` | PDF (jsPDF) e CSV lato client |

Stack: **Next.js 15 (App Router) + TypeScript**, API Routes serverless, nessun database richiesto per l'MVP (l'analisi è stateless; una persistenza su Postgres/SQLite è un'estensione naturale).

## Avvio in locale

```bash
npm install
cp .env.example .env.local   # opzionale, per l'analisi AI
npm run dev
```

Apri http://localhost:3000.

## Variabili d'ambiente

| Variabile | Obbligatoria | Descrizione |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | no | chiave API OpenRouter; se assente l'app funziona in modalità solo analisi statica |
| `OPENROUTER_MODEL` | no | modello di default per l'analisi AI (default: `anthropic/claude-3.5-haiku`); il modello è comunque selezionabile dalla UI |
| `GITHUB_TOKEN` | no | token in sola lettura per alzare i rate limit GitHub e analizzare repo privati |
| `GITLAB_TOKEN` | no | come sopra, per GitLab |

## Deploy su Vercel

1. **Collegare il repository GitHub a Vercel**
   - Fare push di questo repository su GitHub.
   - Su [vercel.com](https://vercel.com) → *Add New… → Project* → importare il repository.
   - Vercel riconosce automaticamente Next.js: non serve alcuna configurazione di build (`next build` è il default).
2. **Configurare le variabili d'ambiente**
   - In *Project → Settings → Environment Variables* aggiungere le variabili della tabella sopra (tutte opzionali).
3. **Inserire `OPENROUTER_API_KEY` (se si usa l'analisi AI)**
   - Creare una chiave su https://openrouter.ai/keys e aggiungerla come variabile `OPENROUTER_API_KEY` (ambienti *Production* e *Preview*).
   - Senza chiave l'app resta pienamente funzionante in modalità solo analisi statica.
4. **Avviare il deploy**
   - Cliccare *Deploy*. Ogni push successivo su GitHub attiva il deploy automatico.
5. **Testare l'applicazione online**
   - Aprire l'URL fornito da Vercel, inserire un repository pubblico (es. `https://github.com/owner/repo`) e premere **Avvia analisi**.
   - Verificare KPI, grafici, tabella file ed export PDF/CSV.

## Limiti noti

- **Repository molto grandi**: l'analisi avviene in memoria in una funzione serverless. Limiti applicati: archivio ≤ 80 MB, max 2000 file di codice, file ≤ 400 KB. Su piano Vercel Hobby il timeout della funzione (≈ 60 s in streaming) può interrompere analisi di repo enormi: in quel caso caricare uno ZIP ridotto o analizzare un sottoinsieme.
- **Upload ZIP**: il limite di body su Vercel è ~4.5 MB; lo ZIP deve contenere solo sorgenti (senza `node_modules`, binari ecc.).
- **Cronologia Git**: disponibile solo per analisi da URL (via API del provider, max 300 commit); non disponibile per gli ZIP.
- **Rate limit**: senza `GITHUB_TOKEN` le API GitHub consentono ~60 richieste/ora per IP.
- **Analisi AI**: per costi e tempi viene applicata solo ai file più sospetti (max 8 file, ~9000 caratteri ciascuno).
- **Affidabilità**: vedi la sezione "Limiti dell'analisi" nella dashboard — sviluppatori molto ordinati possono produrre falsi positivi, codice AI rielaborato a mano produce falsi negativi.

## Licenza

Vedi [LICENSE](LICENSE).
