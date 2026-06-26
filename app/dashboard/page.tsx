import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Nav } from "@/components/Nav";
import { TargetCell } from "./TargetCell";
import {
  currentLocalDate,
  weekdayOfDate,
  WEEKDAY_NAMES,
} from "@/lib/time";

function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

const MATCH_STYLES: Record<string, string> = {
  matched: "bg-emerald-500/15 text-emerald-300",
  partial: "bg-amber-500/15 text-amber-300",
  missed: "bg-red-500/15 text-red-300",
  no_activity: "bg-neutral-700/30 text-neutral-400",
};

function MatchBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-neutral-700">—</span>;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs ${
        MATCH_STYLES[status] ?? "bg-neutral-700/30 text-neutral-400"
      }`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("email, timezone")
    .eq("id", user.id)
    .single();
  const tz = profile?.timezone ?? "UTC";

  const sp = await searchParams;
  const today = currentLocalDate(tz);
  const date =
    sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const weekday = weekdayOfDate(date);

  // Resolve targets: weekly template for this weekday + per-date overrides.
  const [{ data: tpl }, { data: ovr }, { data: notes }] = await Promise.all([
    supabase
      .from("targets_template")
      .select("hour, goal")
      .eq("user_id", user.id)
      .eq("weekday", weekday),
    supabase
      .from("targets_override")
      .select("hour, goal")
      .eq("user_id", user.id)
      .eq("date", date),
    supabase
      .from("hourly_notes")
      .select("slot_hour, note, match_status, reason, goal")
      .eq("user_id", user.id)
      .eq("slot_date", date),
  ]);

  const tplByHour = new Map<number, string>(
    (tpl ?? []).map((r) => [r.hour as number, r.goal as string]),
  );
  const ovrByHour = new Map<number, string>(
    (ovr ?? []).map((r) => [r.hour as number, r.goal as string]),
  );
  const noteByHour = new Map<
    number,
    { note: string | null; match_status: string | null; reason: string | null }
  >((notes ?? []).map((r) => [r.slot_hour as number, r]));

  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <>
      <Nav email={profile?.email ?? user.email!} tz={tz} />
      <main className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">
              {date === today ? "Today" : WEEKDAY_NAMES[weekday]}
            </h1>
            <p className="mt-1 text-sm text-neutral-400">{date}</p>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href={`/dashboard?date=${addDays(date, -1)}`}
              className="rounded-md border border-neutral-800 px-2 py-1.5 text-sm hover:bg-neutral-900"
            >
              ←
            </Link>
            <form action="/dashboard" className="flex gap-2">
              <input
                type="date"
                name="date"
                defaultValue={date}
                className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm outline-none"
              />
              <button className="rounded-md border border-neutral-800 px-2 py-1.5 text-sm hover:bg-neutral-900">
                Go
              </button>
            </form>
            <Link
              href={`/dashboard?date=${addDays(date, 1)}`}
              className="rounded-md border border-neutral-800 px-2 py-1.5 text-sm hover:bg-neutral-900"
            >
              →
            </Link>
          </div>
        </div>

        <div className="mt-8 overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="w-20 px-4 py-2 text-left font-medium">Hour</th>
                <th className="w-1/3 px-4 py-2 text-left font-medium">Target</th>
                <th className="px-4 py-2 text-left font-medium">AI note</th>
                <th className="w-24 px-4 py-2 text-left font-medium">Match</th>
              </tr>
            </thead>
            <tbody>
              {hours.map((h) => {
                const overridden = ovrByHour.has(h);
                const target = overridden
                  ? ovrByHour.get(h)!
                  : (tplByHour.get(h) ?? null);
                const note = noteByHour.get(h);
                return (
                  <tr
                    key={h}
                    className="border-t border-neutral-900 align-top"
                  >
                    <td className="px-4 py-2 text-neutral-400">
                      {String(h).padStart(2, "0")}:00
                    </td>
                    <td className="px-4 py-2">
                      <TargetCell
                        date={date}
                        hour={h}
                        target={target}
                        overridden={overridden}
                      />
                    </td>
                    <td className="px-4 py-2 text-neutral-300">
                      {note?.note ?? (
                        <span className="text-neutral-600">—</span>
                      )}
                      {note?.reason && (
                        <span className="mt-0.5 block text-xs text-neutral-500">
                          {note.reason}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <MatchBadge status={note?.match_status ?? null} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-neutral-600">
          Click a target to set a one-off override for this date. AI notes fill
          in hourly once the agent reports activity.
        </p>
      </main>
    </>
  );
}
