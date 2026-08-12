"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Shared dialog shell. Lives here rather than inside a single screen so any
 * component — including ones the top bar opens — can use the same chrome.
 *
 * Escape closes, background scroll is locked while open.
 */
export function Modal({
  children,
  onClose,
  labelledBy,
  wide = false,
}: {
  children: ReactNode;
  onClose?: () => void;
  labelledBy?: string;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!onClose) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose!();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-black/50 p-4"
      onMouseDown={(e) => {
        // Only a click on the backdrop itself closes — not one that started
        // inside the dialog and drifted out (text selection).
        if (onClose && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`w-full ${wide ? "max-w-[860px]" : "max-w-[560px]"} rounded-card border border-line bg-[rgba(6,11,38,0.98)] p-5 backdrop-blur`}
      >
        {children}
      </div>
    </div>
  );
}
