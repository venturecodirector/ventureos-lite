"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createTask } from "@/modules/tasks/actions";
import { Modal } from "./modal";

/**
 * "New task", from anywhere (playbook-v2 P7/3).
 *
 * The dashboard already has an inline add-a-task field, and it stays — this is
 * the one the `t` key and the palette open, because the point of a shortcut is
 * that it works on whichever screen you are on. It deliberately does NOT
 * navigate to the dashboard first: being thrown off the lead you were reading
 * in order to write a note about it is the behaviour this replaces.
 */
const TYPES = [
  ["todo", "To-do"],
  ["call", "Call"],
  ["email", "Email"],
  ["follow_up", "Follow-up"],
] as const;

const DUE = [
  [0, "today"],
  [1, "tomorrow"],
  [3, "in 3 days"],
  [7, "in a week"],
] as const;

const FIELD =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent";

export function NewTaskDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("todo");
  const [days, setDays] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const due = new Date();
      due.setDate(due.getDate() + days);
      due.setHours(17, 0, 0, 0);
      await createTask({ title: title.trim(), type, note, dueAt: due.toISOString() });
      router.refresh();
      onDone();
    } catch {
      setError("That did not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal>
      <div className="mb-3 flex items-center">
        <h3 className="font-display text-lg font-bold lowercase">new task</h3>
        <button onClick={onClose} className="ml-auto text-muted hover:text-ink" aria-label="Close">
          ✕
        </button>
      </div>

      {error && <p className="mb-2 text-[12.5px] text-[#FFB3C2]">{error}</p>}

      <div className="grid gap-2">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="What needs doing?"
          data-testid="task-title"
          className={FIELD}
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="Type"
            className={FIELD}
          >
            {TYPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label="Due"
            className={FIELD}
          >
            {DUE.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Note (optional)"
          className={FIELD}
        />
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={busy || !title.trim()}
          data-testid="task-save"
          className="min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45"
        >
          {busy ? "Saving…" : "Add task"}
        </button>
      </div>
    </Modal>
  );
}
