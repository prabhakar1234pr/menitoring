"use client";

import { useState, useTransition } from "react";
import { createDevice } from "./actions";

export function PairDevice() {
  const [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onCreate() {
    setError(null);
    setToken(null);
    start(async () => {
      const res = await createDevice(name);
      if (res.error) setError(res.error);
      else if (res.token) {
        setToken(res.token);
        setName("");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Device name (e.g. Home PC)"
          className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
        />
        <button
          onClick={onCreate}
          disabled={pending}
          className="rounded-md bg-white px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-200 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Pair new device"}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {token && (
        <div className="rounded-md border border-amber-700/50 bg-amber-500/10 p-3">
          <p className="text-sm font-medium text-amber-300">
            Copy this token now — it won&apos;t be shown again:
          </p>
          <code className="mt-2 block break-all rounded bg-neutral-950 p-2 text-sm text-amber-200">
            {token}
          </code>
          <p className="mt-2 text-xs text-neutral-400">
            Paste it into the desktop agent config. It authenticates that device
            as your account.
          </p>
        </div>
      )}
    </div>
  );
}
