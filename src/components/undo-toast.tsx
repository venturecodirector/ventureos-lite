"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { undoAction } from "@/modules/undo/actions";

/**
 * The undo toast (playbook-v2 P7/2).
 *
 * Six seconds, one action, no confirmation. It is deliberately the LEAST
 * ceremonious control in the product: an undo you have to think about is one
 * you have already stopped trusting.
 *
 * What it does NOT do is reverse anything itself. The button calls the server,
 * which checks that the rows still look the way the action left them and
 * declines if they do not. That refusal is shown in the toast rather than
 * swallowed — "someone else changed this" is exactly the thing a person needs
 * to hear before they go looking for their edit.
 */

export interface UndoOffer {
  id: string;
  label: string;
}

interface UndoApi {
  /** Show the toast for a freshly recorded action. Null is a no-op. */
  offerUndo: (offer: UndoOffer | null | undefined) => void;
}

const Ctx = createContext<UndoApi | null>(null);

/** Seconds the offer stays up. The playbook asks for six. */
const WINDOW_SECONDS = 6;

export function UndoProvider({ children }: { children: ReactNode }) {
  const [offer, setOffer] = useState<UndoOffer | null>(null);
  const [remaining, setRemaining] = useState(WINDOW_SECONDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const offerUndo = useCallback((next: UndoOffer | null | undefined) => {
    if (!next) return;
    setError(null);
    setOffer(next);
    setRemaining(WINDOW_SECONDS);
  }, []);

  useEffect(() => {
    if (!offer) return;
    timer.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          setOffer(null);
          return WINDOW_SECONDS;
        }
        return r - 1;
      });
    }, 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [offer]);

  const value = useMemo(() => ({ offerUndo }), [offerUndo]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {offer && (
        <div
          role="status"
          data-testid="undo-toast"
          className="fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 nav:bottom-6"
        >
          <div className="flex items-center gap-3 rounded-card border border-line bg-[rgba(6,11,38,0.97)] px-4 py-2.5 shadow-glow-lg backdrop-blur">
            <span className="text-[12.5px] text-ink">
              {error ? <span className="text-[#FFB3C2]">{error}</span> : offer.label}
            </span>
            {!error && (
              <>
                <button
                  type="button"
                  data-testid="undo-button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const res = await undoAction(offer.id);
                    setBusy(false);
                    if (!res.ok) {
                      setError(res.error);
                      // Hold the refusal on screen long enough to read.
                      window.setTimeout(() => setOffer(null), 5000);
                      return;
                    }
                    setOffer(null);
                    router.refresh();
                  }}
                  className="rounded-[8px] border border-accent bg-accent-soft px-2.5 py-1 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60"
                >
                  {busy ? "Undoing…" : "Undo"}
                </button>
                <span className="w-4 text-right text-[11px] tabular-nums text-muted">
                  {remaining}
                </span>
              </>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setOffer(null)}
              className="text-muted hover:text-ink"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

/**
 * Offer an undo from anywhere inside the shell.
 *
 * Returns a no-op outside the provider rather than throwing: a component may
 * render in a context that has no toast host (a public page, a test harness),
 * and losing the offer is a far better failure than a crash.
 */
export function useUndo(): UndoApi {
  return useContext(Ctx) ?? { offerUndo: () => {} };
}
