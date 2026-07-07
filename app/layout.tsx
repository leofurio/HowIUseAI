import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Code Usage Analyzer",
  description:
    "Stima probabilistica di quanta parte del codice di un repository è stata generata o assistita da AI",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
