"use client";

import { useEffect, useState } from "react";
import {
  myTasks,
  tasksForEntity,
  createTask,
  completeTask,
  reopenTask,
  snoozeTask,
  type TaskView,
} from "@/modules/tasks/actions";
import { TYPE_LABEL, groupTasks, type TaskType } from "@/modules/tasks/logic";

/**
 * Tasks (playbook-v2 P3/3).
 *
 * Two shapes from one component: the dashboard list grouped by urgency, and the
 * per-entity list on a lead. They share the row rendering because a task should
 * look and behave the same wherever it is seen.
 */
function dueLabel(dueAt: Date | null): string {
  if (!dueAt) return "no date";
  const now = new Date();
  const days = Math.round((dueAt.getTime() - now.setHours(0, 0, 0, 0)) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return dueAt.toLocaleDateString("hu-HU");
}

function TaskRow({
  task,
  onChanged,
}: {
  task: TaskView;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const done = task.doneAt !== null;

  return (
    <div className="flex items-start gap-2.5 border-b border-[rgba(239,241,248,0.05)] py-2">
      <input
        type="checkbox"
        checked={done}
        disabled={busy}
        onChange={async () => {
          setBusy(true);
          await (done ? reopenTask(task.id) : completeTask(task.id));
          await onChanged();
          setBusy(false);
        }}
        className="mt-[3px]"
        style={{ accentColor: "#7427C6" }}
        aria-label={done ? "Reopen task" : "Complete task"}
      />
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] ${done ? "text-muted line-through" : "text-[#C9CEE3]"}`}>
          {task.title}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
          <span className="rounded-full border border-line px-1.5">
            {TYPE_LABEL[task.type as TaskType] ?? task.type}
          </span>
          <span>{dueLabel(task.dueAt)}</span>
          {task.entityLabel && task.entityHref && (
            <a href={task.entityHref} className="truncate hover:text-ink">
              {task.entityLabel}
            </a>
          )}
          {/* Where a task came from, so a person's own list is legible: "why is
              this here" should never need asking. */}
          {task.source && <span className="opacity-70">· auto</span>}
        </div>
        {task.note && <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{task.note}</p>}
      </div>
      {!done && (
        <button
          onClick={async () => {
            setBusy(true);
            await snoozeTask(task.id, 1);
            await onChanged();
            setBusy(false);
          }}
          disabled={busy}
          title="Push to tomorrow"
          className="flex-none text-[11px] text-muted hover:text-ink disabled:opacity-50"
        >
          +1d
        </button>
      )}
    </div>
  );
}

function NewTask({
  entity,
  onCreated,
}: {
  entity?: { entityType: "lead" | "company" | "document"; entityId: string };
  onCreated: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<TaskType>("todo");
  const [days, setDays] = useState(1);
  const [busy, setBusy] = useState(false);

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key !== "Enter" || !title.trim() || busy) return;
          setBusy(true);
          const due = new Date();
          due.setDate(due.getDate() + days);
          due.setHours(17, 0, 0, 0);
          await createTask({ title, type, dueAt: due.toISOString(), ...entity });
          setTitle("");
          await onCreated();
          setBusy(false);
        }}
        placeholder="Add a task — Enter to save"
        className="min-w-[160px] flex-1 rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
      />
      <select
        value={type}
        onChange={(e) => setType(e.target.value as TaskType)}
        className="rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
      >
        {(["todo", "call", "email", "follow_up"] as TaskType[]).map((t) => (
          <option key={t} value={t}>
            {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <select
        value={days}
        onChange={(e) => setDays(Number(e.target.value))}
        className="rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
      >
        <option value={0}>today</option>
        <option value={1}>tomorrow</option>
        <option value={3}>+3d</option>
        <option value={7}>+1w</option>
      </select>
    </div>
  );
}

/**
 * The dashboard list: overdue first, then today, then what is coming.
 *
 * The first render comes from the SERVER as a prop, not from a fetch on mount.
 * The dashboard is the first thing loaded every morning, and a client round trip
 * there costs a visible flash plus real latency on a phone — which is how this
 * component briefly broke the mobile navigation tests.
 */
export function TasksPanel({ initial }: { initial: TaskView[] }) {
  const [tasks, setTasks] = useState<TaskView[]>(initial);

  async function refresh() {
    const grouped = await myTasks();
    setTasks([...grouped.overdue, ...grouped.today, ...grouped.upcoming, ...grouped.someday]);
  }

  const grouped = groupTasks(tasks);

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="font-display text-[15px] font-bold lowercase tracking-display">tasks</h2>
        {grouped.counts.overdue > 0 && (
          <span className="rounded-full bg-[rgba(255,92,122,0.15)] px-2 py-0.5 text-[11px] font-semibold text-[#FF5C7A]">
            {grouped.counts.overdue} overdue
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted">
          {grouped.counts.today} today · {grouped.counts.open} open
        </span>
      </div>

      {grouped.counts.open === 0 ? (
        <p className="text-[12.5px] text-muted">Nothing due. Add one below, or enjoy it.</p>
      ) : (
        <>
          {(
            [
              ["overdue", grouped.overdue],
              ["today", grouped.today],
              ["upcoming", grouped.upcoming],
              ["someday", grouped.someday],
            ] as const
          ).map(([label, list]) =>
            list.length === 0 ? null : (
              <div key={label} className="mt-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                  {label}
                </div>
                {list.map((t) => (
                  <TaskRow key={t.id} task={t} onChanged={refresh} />
                ))}
              </div>
            ),
          )}
        </>
      )}

      <NewTask onCreated={refresh} />
    </div>
  );
}

/** The per-entity list, for a lead or a company. */
export function EntityTasks({
  entityType,
  entityId,
}: {
  entityType: "lead" | "company" | "document";
  entityId: string;
}) {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);

  async function refresh() {
    setTasks(await tasksForEntity(entityType, entityId));
  }

  useEffect(() => {
    let active = true;
    tasksForEntity(entityType, entityId).then((t) => {
      if (active) setTasks(t);
    });
    return () => {
      active = false;
    };
  }, [entityType, entityId]);

  if (!tasks) return null;
  const open = tasks.filter((t) => !t.doneAt);

  return (
    <div className="mt-3.5 rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Tasks
        </span>
        {open.length > 0 && <span className="text-[11px] text-muted">{open.length} open</span>}
      </div>
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} onChanged={refresh} />
      ))}
      <NewTask entity={{ entityType, entityId }} onCreated={refresh} />
    </div>
  );
}
