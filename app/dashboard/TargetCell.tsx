"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOverride } from "./actions";

export function TargetCell({
  date,
  hour,
  target,
  overridden,
}: {
  date: string;
  hour: number;
  target: string | null;
  overridden: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(target ?? "");
  const [pending, start] = useTransition();
  const router = useRouter();

  function save() {
    start(async () => {
      await setOverride(date, hour, value);
      setEditing(false);
      router.refresh();
    });
  }

  if (!editing) {
    return (
      <button
        onClick={() => {
          setValue(target ?? "");
          setEditing(true);
        }}
        className="group flex w-full items-center gap-2 text-left"
      >
        <span className={target ? "" : "text-neutral-600"}>
          {target ?? "—"}
        </span>
        {overridden && (
          <span className="rounded bg-blue-500/15 px-1 text-[10px] text-blue-300">
            override
          </span>
        )}
        <span className="ml-auto text-[10px] text-neutral-600 opacity-0 group-hover:opacity-100">
          edit
        </span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder="target for this hour"
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none"
      />
      <button
        onClick={save}
        disabled={pending}
        className="text-xs text-blue-300 disabled:opacity-50"
      >
        {pending ? "…" : "save"}
      </button>
    </div>
  );
}
