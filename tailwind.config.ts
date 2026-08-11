import type { Config } from "tailwindcss";

/**
 * Design tokens lifted verbatim from docs/prototype.html (:root).
 * Keep this the single source of truth for the Venture design system so the
 * app "matches the prototype exactly" (CLAUDE.md).
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#00051D",
        panel: "rgba(239,241,248,0.04)",
        "panel-2": "rgba(239,241,248,0.07)",
        line: "rgba(239,241,248,0.09)",
        ink: "#EFF1F8",
        muted: "#858CAE",
        accent: "#7427C6",
        "accent-soft": "rgba(116,39,198,0.25)",
        "accent-ink": "#C79BFF", // the purple used for text/icons on dark
        "accent-2": "#A76BF0",
        deep: "#310B59",
        pos: "#3DDC97",
        warn: "#F5B841",
        neg: "#FF5C7A",
      },
      fontFamily: {
        // wired to next/font CSS variables in src/app/layout.tsx
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      borderRadius: {
        card: "14px",
      },
      backgroundImage: {
        grad: "linear-gradient(135deg,#310B59,#7427C6)",
      },
      boxShadow: {
        glow: "0 0 18px rgba(116,39,198,0.35)",
        "glow-lg": "0 0 32px rgba(116,39,198,0.22)",
      },
      letterSpacing: {
        display: "-0.02em",
      },
    },
  },
  plugins: [],
};

export default config;
