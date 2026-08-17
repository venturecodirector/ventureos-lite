"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Shell-level actions that any screen can trigger.
 *
 * The top bar's "Import CSV" and "+ New lead" buttons live in a server
 * component, while the dialogs they open are client-side and were previously
 * mounted only inside the Leads screen — which is why both buttons did nothing
 * anywhere else in the app. This context is the seam: the shell opens, a single
 * mounted host renders.
 */
export type AppDialog = "csv-import" | "new-lead" | "new-task" | null;

interface AppActions {
  dialog: AppDialog;
  openDialog: (d: Exclude<AppDialog, null>) => void;
  closeDialog: () => void;
}

const Ctx = createContext<AppActions | null>(null);

export function AppActionsProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<AppDialog>(null);
  const openDialog = useCallback((d: Exclude<AppDialog, null>) => setDialog(d), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const value = useMemo(() => ({ dialog, openDialog, closeDialog }), [dialog, openDialog, closeDialog]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppActions(): AppActions {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppActions must be used inside AppActionsProvider");
  return ctx;
}
