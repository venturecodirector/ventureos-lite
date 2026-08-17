"use client";

import { useEffect, useState } from "react";
import {
  getCaptureDiagnostics,
  type CaptureDiagnostics,
} from "@/modules/capture/diagnostics";

/**
 * "Capture diagnostics" — collapsed by default, on the lead card.
 *
 * This is here because the last two rounds of the extraction bug each started
 * with "can you reproduce it and tell me what the popup said". The popup had
 * closed; the evidence was gone. Now the lead carries it: open the card, expand,
 * copy, paste.
 *
 * Collapsed by default and muted on purpose. It is repair equipment, not part of
 * the working surface, and it must not compete with the lead's actual content —
 * the design system reserves emphasis for one thing per screen.
 */
export function CaptureDiagnosticsPanel({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CaptureDiagnostics | null | "loading">("loading");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    getCaptureDiagnostics(leadId)
      .then((d) => live && setData(d))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [leadId]);

  // Nothing to show for a lead that was never captured by the extension. A
  // permanently-empty panel would be worse than no panel.
  if (data === "loading" || data === null) return null;

  const skipped = Object.entries(data.contactReasons);
  const summary = [
    data.kind === "created" ? "captured" : "re-captured",
    data.city ? `city ${data.city}` : data.locationReason ? "no city" : null,
    skipped.length > 0 ? `${skipped.length} field(s) skipped` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const full = JSON.stringify(data, null, 2);

  return (
    <div className="mt-3 rounded-[9px] border border-line bg-[rgba(239,241,248,0.02)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="capture-diagnostics-toggle"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[11.5px] text-muted hover:text-ink"
      >
        <span>
          <span className="font-semibold uppercase tracking-[0.12em]">Capture diagnostics</span>
          {summary && <span className="ml-2 normal-case tracking-normal">— {summary}</span>}
        </span>
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="border-t border-line px-3 py-2.5 text-[11.5px] text-[#C9CEE3]">
          {/* Why a field is empty, in words, before the raw trace. A reason code
              is for me; a sentence is for the person looking at the card. */}
          {skipped.length > 0 && (
            <ul className="mb-2 space-y-1" data-testid="capture-diagnostics-skipped">
              {skipped.map(([field, reason]) => (
                <li key={field}>
                  <span className="text-muted">{field}:</span> {reason.replace(/_/g, " ")}
                </li>
              ))}
            </ul>
          )}
          {data.locationReason && (
            <p className="mb-2">
              <span className="text-muted">city:</span> {data.locationReason.replace(/_/g, " ")}
            </p>
          )}

          <pre className="max-h-64 overflow-auto rounded-[7px] bg-[rgba(0,5,29,0.5)] p-2 text-[10.5px] leading-relaxed">
            {full}
          </pre>

          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(full).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => setCopied(false),
              );
            }}
            className="mt-2 rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink hover:border-accent"
          >
            {copied ? "Copied" : "Copy diagnostics"}
          </button>
        </div>
      )}
    </div>
  );
}
