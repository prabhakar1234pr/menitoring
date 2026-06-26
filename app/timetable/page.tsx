import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Nav } from "@/components/Nav";
import { saveTemplate } from "./actions";
import { WEEKDAY_NAMES, currentLocalDate, weekdayOfDate } from "@/lib/time";

export default async function TimetablePage({
  searchParams,
}: {
  searchParams: Promise<{ weekday?: string; saved?: string }>;
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
  const weekday =
    sp.weekday !== undefined && /^[0-6]$/.test(sp.weekday)
      ? Number(sp.weekday)
      : weekdayOfDate(currentLocalDate(tz));

  const { data: rows } = await supabase
    .from("targets_template")
    .select("hour, goal")
    .eq("user_id", user.id)
    .eq("weekday", weekday);
  const goalByHour = new Map<number, string>(
    (rows ?? []).map((r) => [r.hour as number, (r.goal as string) ?? ""]),
  );

  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <>
      <Nav email={profile?.email ?? user.email!} tz={tz} />
      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Weekly timetable</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Set a recurring target per hour. Override a specific day from the{" "}
          <Link href="/dashboard" className="underline">
            Today
          </Link>{" "}
          view.
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          {WEEKDAY_NAMES.map((name, i) => (
            <Link
              key={i}
              href={`/timetable?weekday=${i}`}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                i === weekday
                  ? "border-white bg-white text-neutral-900"
                  : "border-neutral-800 text-neutral-300 hover:bg-neutral-900"
              }`}
            >
              {name.slice(0, 3)}
            </Link>
          ))}
        </div>

        {sp.saved && (
          <p className="mt-4 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
            Saved {WEEKDAY_NAMES[weekday]}.
          </p>
        )}

        <form action={saveTemplate} className="mt-6">
          <input type="hidden" name="weekday" value={weekday} />
          <div className="overflow-hidden rounded-lg border border-neutral-800">
            <table className="w-full text-sm">
              <tbody>
                {hours.map((h) => (
                  <tr key={h} className="border-t border-neutral-900 first:border-t-0">
                    <td className="w-20 px-4 py-1.5 text-neutral-400">
                      {String(h).padStart(2, "0")}:00
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        name={`hour_${h}`}
                        defaultValue={goalByHour.get(h) ?? ""}
                        placeholder="—"
                        className="w-full rounded border border-transparent bg-transparent px-2 py-1 outline-none hover:border-neutral-800 focus:border-neutral-600"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="mt-4 rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-200">
            Save {WEEKDAY_NAMES[weekday]}
          </button>
        </form>
      </main>
    </>
  );
}
