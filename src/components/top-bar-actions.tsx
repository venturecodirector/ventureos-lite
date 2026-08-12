"use client";

import { useAppActions } from "./app-actions";

/**
 * The top bar's action buttons. Client-side because the shell is a server
 * component and these need an onClick — previously they were plain buttons
 * with no handler, so both did nothing from anywhere in the app.
 */
export function TopBarActions() {
  const { openDialog } = useAppActions();
  return (
    <>
      <button
        type="button"
        data-testid="topbar-import-csv"
        onClick={() => openDialog("csv-import")}
        className="min-h-[44px] whitespace-nowrap rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel-2"
      >
        Import CSV
      </button>
      <button
        type="button"
        data-testid="topbar-new-lead"
        onClick={() => openDialog("new-lead")}
        className="min-h-[44px] whitespace-nowrap rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background:linear-gradient(var(--tw-gradient-stops))] [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box]"
      >
        + New lead
      </button>
    </>
  );
}
