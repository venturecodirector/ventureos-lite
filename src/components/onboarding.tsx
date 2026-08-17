"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { completeTour, hideChecklist, type OnboardingView } from "@/modules/onboarding/actions";
import { CHECKLIST, TOUR_STEPS } from "@/modules/onboarding/tour";

/**
 * The first-login tour and the getting-started checklist (playbook-v2 P7/4).
 *
 * The tour is DISMISSIBLE FROM THE FIRST STEP and the dismiss counts as
 * finished. Someone who has used this product before, or who simply wants to
 * get on with it, should not have to click through six panels to make it stop —
 * and a tour that reappears is the single most irritating thing an app does.
 */

export function Onboarding({ view }: { view: OnboardingView }) {
  return (
    <>
      {view.showTour && <Tour />}
      {view.showChecklist && <Checklist view={view} />}
    </>
  );
}

function Tour() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [pending, startTransition] = useTransition();
  const [closed, setClosed] = useState(false);
  const current = TOUR_STEPS[step];
  const last = step === TOUR_STEPS.length - 1;

  function finish() {
    setClosed(true);
    startTransition(async () => {
      await completeTour();
      router.refresh();
    });
  }

  if (closed) return null;

  return (
    <div className="fixed inset-0 z-[65] grid place-items-center bg-black/55 p-4">
      <div
        data-testid="onboarding-tour"
        className="w-full max-w-[520px] rounded-card border-[1.5px] border-transparent bg-[linear-gradient(rgba(4,8,34,0.97),rgba(4,8,34,0.97))_padding-box,linear-gradient(135deg,#310B59,#7427C6)_border-box] p-6 shadow-[0_0_28px_rgba(116,39,198,0.22)]"
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            {step + 1} of {TOUR_STEPS.length}
          </span>
          <button
            onClick={finish}
            data-testid="tour-skip"
            className="ml-auto text-[12px] text-muted hover:text-ink"
          >
            Skip
          </button>
        </div>

        <h2 className="font-display text-[24px] lowercase tracking-display">{current.title}</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[#C9CEE3]">{current.body}</p>

        <div className="mt-5 flex items-center gap-2">
          <span className="flex gap-1.5">
            {TOUR_STEPS.map((s, i) => (
              <i
                key={s.id}
                className={`h-1.5 w-1.5 rounded-full ${i === step ? "bg-grad" : "bg-line"}`}
              />
            ))}
          </span>
          {step > 0 && (
            <button
              onClick={() => setStep((i) => i - 1)}
              className="ml-auto rounded-[10px] border border-line bg-panel px-3.5 py-2 text-[12.5px] hover:bg-panel-2"
            >
              Back
            </button>
          )}
          <button
            data-testid="tour-next"
            disabled={pending}
            onClick={() => (last ? finish() : setStep((i) => i + 1))}
            className={`${step > 0 ? "" : "ml-auto"} min-h-[40px] rounded-[9px] bg-grad px-4 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45`}
          >
            {last ? "Start working" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Checklist({ view }: { view: OnboardingView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  return (
    <div
      data-testid="getting-started"
      className="mb-4 rounded-card border border-line bg-panel p-[18px]"
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="font-display text-[15px] font-bold lowercase tracking-display">
          getting started
        </h2>
        <span className="text-[11px] text-muted tabular-nums">
          {view.progress.done} of {view.progress.total}
        </span>
        <button
          data-testid="checklist-hide"
          disabled={pending}
          onClick={() => {
            setHidden(true);
            startTransition(async () => {
              await hideChecklist();
              router.refresh();
            });
          }}
          className="ml-auto text-[11.5px] text-muted hover:text-ink"
        >
          Hide
        </button>
      </div>

      <div className="mb-3 h-[3px] overflow-hidden rounded-[3px] bg-line">
        <i
          className="block h-full rounded-[3px] bg-grad"
          style={{ width: `${(view.progress.done / view.progress.total) * 100}%` }}
        />
      </div>

      <ul className="grid gap-1">
        {CHECKLIST.map((item) => {
          const done = view.checklist[item.id];
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                className={`flex items-start gap-2.5 rounded-[9px] px-2 py-1.5 text-[12.5px] ${
                  done ? "text-muted" : "hover:bg-panel-2"
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-[3px] grid h-[15px] w-[15px] flex-none place-items-center rounded-full border text-[9px] ${
                    done ? "border-pos bg-[rgba(61,220,151,0.15)] text-pos" : "border-line"
                  }`}
                >
                  {done ? "✓" : ""}
                </span>
                <span className="min-w-0">
                  <span className={done ? "line-through" : "text-ink"}>{item.label}</span>
                  {!done && <span className="block text-[11.5px] text-muted">{item.hint}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
