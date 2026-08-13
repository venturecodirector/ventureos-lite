"use client";

import { useEffect, useState } from "react";
import { greetingFor, msUntilNextBand } from "@/lib/greeting";

/**
 * "good morning" / "good day" / "good evening", by the DEVICE's clock.
 *
 * A client component because that is the only place the user's own time zone
 * exists. The server renders in whatever the container's clock says — UTC —
 * and would greet a Budapest user two hours behind their own morning.
 *
 * Hydration: the first paint uses the server's hour, then the browser corrects
 * it on mount. `suppressHydrationWarning` covers the one render where the two
 * legitimately disagree — this is a case where the mismatch is the POINT, not a
 * bug, and React cannot tell those apart.
 *
 * It also re-renders itself exactly once at the next boundary, so a dashboard
 * left open over lunch stops insisting it is morning without a reload.
 */
export function Greeting({ suffix }: { suffix?: string }) {
  const [hour, setHour] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setHour(new Date().getHours());
    tick();

    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        tick();
        schedule();
      }, msUntilNextBand(new Date()));
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  // Before hydration, the server's hour is the best guess available; after, the
  // device's is authoritative.
  const text = greetingFor(hour ?? new Date().getHours());

  return (
    <span suppressHydrationWarning>
      {text}
      {suffix ? `, ${suffix}` : ""}
    </span>
  );
}
