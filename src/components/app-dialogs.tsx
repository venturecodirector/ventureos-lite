"use client";

import { useRouter } from "next/navigation";
import { useAppActions } from "./app-actions";
import { CsvImport } from "./csv-import";
import { ManualLeadForm } from "./manual-lead-form";
import { NewTaskDialog } from "./new-task-dialog";

/**
 * Single mount point for the dialogs the top bar can open from any screen.
 * Rendered once by AppShell; opened through `useAppActions()`.
 */
export function AppDialogs() {
  const router = useRouter();
  const { dialog, closeDialog } = useAppActions();

  if (dialog === "csv-import") {
    return (
      <CsvImport
        onClose={closeDialog}
        onDone={() => {
          closeDialog();
          router.refresh();
        }}
      />
    );
  }
  if (dialog === "new-lead") {
    return (
      <ManualLeadForm
        navigateOnCreate
        onClose={closeDialog}
        onDone={() => {
          closeDialog();
          router.refresh();
        }}
      />
    );
  }
  if (dialog === "new-task") {
    return (
      <NewTaskDialog
        onClose={closeDialog}
        onDone={() => {
          closeDialog();
          router.refresh();
        }}
      />
    );
  }
  return null;
}
