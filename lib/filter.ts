// Modulo filtro: decide quali file del repository sono rilevanti per l'analisi
// e rileva il linguaggio di programmazione dall'estensione.

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  ".git",
  ".svn",
  ".hg",
  ".next",
  ".nuxt",
  ".output",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".idea",
  ".vscode",
  "coverage",
  "target",
  "bin",
  "obj",
  "Pods",
  "bower_components",
  ".terraform",
  ".gradle",
  "DerivedData",
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  py: "Python",
  rb: "Ruby",
  php: "PHP",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  go: "Go",
  rs: "Rust",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  hpp: "C++",
  hh: "C++",
  cs: "C#",
  swift: "Swift",
  m: "Objective-C",
  mm: "Objective-C",
  dart: "Dart",
  lua: "Lua",
  r: "R",
  pl: "Perl",
  pm: "Perl",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ps1: "PowerShell",
  sql: "SQL",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  sass: "SCSS",
  less: "Less",
  vue: "Vue",
  svelte: "Svelte",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  hs: "Haskell",
  clj: "Clojure",
  groovy: "Groovy",
  tf: "Terraform",
  yaml: "YAML",
  yml: "YAML",
  json: "JSON",
  toml: "TOML",
  xml: "XML",
  md: "Markdown",
};

// Linguaggi analizzati con tutte le euristiche; per i formati "dati/markup"
// l'analisi ha meno senso e vengono esclusi dallo scoring.
const DATA_FORMATS = new Set(["YAML", "JSON", "TOML", "XML", "Markdown", "HTML", "CSS", "SCSS", "Less"]);

const GENERATED_FILE_PATTERNS: RegExp[] = [
  /\.min\.(js|css)$/i,
  /\.bundle\.(js|css)$/i,
  /\.map$/i,
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /composer\.lock$/i,
  /Cargo\.lock$/i,
  /Gemfile\.lock$/i,
  /poetry\.lock$/i,
  /go\.sum$/i,
  /\.pb\.(go|py|js|ts)$/i,
  /_pb2(_grpc)?\.py$/i,
  /\.generated\.[a-z]+$/i,
  /\.g\.(dart|cs)$/i,
  /\.designer\.cs$/i,
  /next-env\.d\.ts$/i,
];

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "svg", "webp", "avif",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "jar", "war",
  "exe", "dll", "so", "dylib", "a", "o", "class", "pyc", "pyo",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "avi", "mov", "wav", "ogg", "webm", "flac",
  "db", "sqlite", "sqlite3", "bin", "dat", "pak", "wasm",
  "lock", "keystore", "p12", "pfx", "der", "crt", "pem",
]);

export const MAX_FILE_BYTES = 400 * 1024; // file più grandi: quasi certamente generati o dati
export const MAX_FILES = 2000;

export interface FilterDecision {
  include: boolean;
  reason?: string;
  language?: string;
}

export function detectLanguage(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  if (name === "Dockerfile") return "Dockerfile";
  if (name === "Makefile") return "Makefile";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return LANGUAGE_BY_EXT[ext] ?? null;
}

export function isDataFormat(language: string): boolean {
  return DATA_FORMATS.has(language);
}

/** Decide se un file (dal solo percorso) va analizzato. */
export function shouldAnalyzePath(path: string, sizeBytes: number): FilterDecision {
  const parts = path.split("/");
  for (const part of parts.slice(0, -1)) {
    if (EXCLUDED_DIRS.has(part)) {
      return { include: false, reason: `cartella esclusa (${part})` };
    }
  }
  const name = parts[parts.length - 1];
  if (name.startsWith(".") && name !== ".env.example") {
    return { include: false, reason: "file nascosto/configurazione" };
  }
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (BINARY_EXTENSIONS.has(ext)) {
    return { include: false, reason: "file binario o asset" };
  }
  for (const pattern of GENERATED_FILE_PATTERNS) {
    if (pattern.test(path)) {
      return { include: false, reason: "file generato automaticamente o minificato" };
    }
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    return { include: false, reason: "file troppo grande (probabilmente generato)" };
  }
  const language = detectLanguage(path);
  if (!language) {
    return { include: false, reason: "estensione non riconosciuta come codice" };
  }
  if (isDataFormat(language)) {
    return { include: false, reason: `formato dati/markup (${language})` };
  }
  return { include: true, language };
}

/** Euristica anti-binario sul contenuto (byte NUL, righe chilometriche). */
export function looksBinaryOrMinified(content: string): string | null {
  if (content.includes("\u0000")) return "contenuto binario";
  const lines = content.split("\n");
  const veryLong = lines.filter((l) => l.length > 1000).length;
  if (lines.length > 0 && veryLong / lines.length > 0.1) return "contenuto minificato";
  return null;
}
