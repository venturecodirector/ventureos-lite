import type { ReactNode } from "react";
import Link from "next/link";

/**
 * The empty state, once, everywhere (playbook-v2 P7/4).
 *
 * "No campaigns yet." is not an empty state — it is a status line. What an
 * empty screen has to do is say what the module IS FOR and hand over the one
 * action that makes it non-empty, because the person looking at it is usually
 * seeing that screen for the first time and has no other source for either.
 *
 * The headline is lowercase Bricolage, matching the prototype's voice
 * throughout; the sentence is one sentence, because two is a manual.
 */
export function EmptyState({
  title,
  children,
  action,
  secondary,
  testId,
}: {
  /** Lowercase, a few words. "no leads yet", not "No Leads Found". */
  title: string;
  /** One sentence on what this module does. */
  children: ReactNode;
  action?: { label: string; href?: string; onClick?: never } | null;
  /** A quieter second option, when there genuinely is one. */
  secondary?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId ?? "empty-state"}
      className="rounded-card border border-dashed border-line bg-[rgba(239,241,248,0.02)] px-6 py-10 text-center"
    >
      <h2 className="font-display text-[22px] lowercase tracking-display">{title}</h2>
      <p className="mx-auto mt-2 max-w-[440px] text-[13px] leading-relaxed text-muted">
        {children}
      </p>
      {(action || secondary) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action?.href && (
            <Link
              href={action.href}
              data-testid="empty-state-action"
              className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box]"
            >
              {action.label}
            </Link>
          )}
          {secondary}
        </div>
      )}
    </div>
  );
}
