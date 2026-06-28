import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Fredoka, Nunito_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./artifact-viewer.css";

export const metadata: Metadata = {
  title: "Oak",
  description: "Natural-language Pokémon question answering agent",
};

// Display / body / mono — exposed as CSS variables consumed by globals.css.
const fredoka = Fredoka({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-display",
  display: "swap",
});
const nunitoSans = Nunito_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});
const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-mono",
  display: "swap",
});

// Set the manual theme (if the user picked one) before first paint to avoid a
// flash of the wrong theme. No stored choice → CSS falls back to the system
// `prefers-color-scheme`. Keep in sync with ThemeToggle's storage key.
const NO_FLASH_THEME = `(function(){try{var t=localStorage.getItem('oak-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fredoka.variable} ${nunitoSans.variable} ${jetBrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
