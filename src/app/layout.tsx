import type { Metadata, Viewport } from "next";
import { Inter, Bricolage_Grotesque } from "next/font/google";
import "./globals.css";

// Inter — UI text. Bricolage Grotesque — display/numerals (used lowercase).
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Venture OS Lite",
  description: "AI-assisted sales & delivery workspace — Venture CO Group",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Venture OS", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#00051D",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${bricolage.variable}`}>
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
