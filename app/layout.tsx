import type { ReactNode } from "react";
import { DM_Sans, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Magic & Co brand families, self-served by next/font and exposed as CSS variables
// that globals.css wires into --font-sans / --font-serif / --font-mono. DM Sans and
// JetBrains Mono are variable fonts (all weights); Instrument Serif is static 400.
const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata = {
  title: "Magic Content",
  description: "Content-intelligence dashboard for Instagram Reels.",
};

// Apply the persisted theme before first paint so dark mode never flashes light.
// Mirrors the toggle in AppShell (localStorage key "mc_theme"); defaults to light.
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("mc_theme");document.documentElement.setAttribute("data-theme",t==="dark"?"dark":"light");}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  const fontVars = `${dmSans.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`;
  return (
    <html lang="en" className={fontVars} data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
