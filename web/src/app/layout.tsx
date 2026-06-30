import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Fredoka, Nunito_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./artifact-viewer.css";

export const metadata: Metadata = {
  title: "Oak",
  description: "Natural-language Pokémon question answering agent",
};

// Mobile foundation: map the layout to the real device width and let the page
// bleed into the notch / home-indicator area so `env(safe-area-inset-*)` becomes
// non-zero (the header/composer pad themselves with it). `viewportFit: "cover"`
// is the prerequisite for any safe-area handling. We deliberately do NOT cap
// zoom (no maximumScale/userScalable) — that would break WCAG 1.4.4. themeColor
// tints the browser chrome to match each theme's app background.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Light is the app default, so the browser chrome tint is the light brand
  // color regardless of OS preference (matches the unconditional light theme).
  themeColor: "#ee5a5a",
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
// flash of the wrong theme. No stored choice → CSS falls back to the light
// default. Keep in sync with ThemeToggle's storage key.
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
