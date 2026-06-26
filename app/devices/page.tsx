import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Nav } from "@/components/Nav";
import { PairDevice } from "./PairDevice";
import { revokeDevice } from "./actions";

export default async function DevicesPage() {
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

  const { data: devices } = await supabase
    .from("devices")
    .select("id, name, created_at, last_seen_at, revoked_at")
    .order("created_at", { ascending: false });

  return (
    <>
      <Nav email={profile?.email ?? user.email!} tz={profile?.timezone} />
      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Devices</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Pair the desktop agent once with a token; it then reports activity as
          your account.
        </p>

        <div className="mt-6">
          <PairDevice />
        </div>

        <div className="mt-8 overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Last seen</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="w-24 px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {(devices ?? []).length === 0 && (
                <tr className="border-t border-neutral-900">
                  <td
                    colSpan={4}
                    className="px-4 py-6 text-center text-neutral-600"
                  >
                    No devices yet.
                  </td>
                </tr>
              )}
              {(devices ?? []).map((d) => {
                const revoked = Boolean(d.revoked_at);
                return (
                  <tr key={d.id} className="border-t border-neutral-900">
                    <td className="px-4 py-2">{d.name}</td>
                    <td className="px-4 py-2 text-neutral-400">
                      {d.last_seen_at
                        ? new Date(d.last_seen_at).toLocaleString()
                        : "never"}
                    </td>
                    <td className="px-4 py-2">
                      {revoked ? (
                        <span className="text-neutral-500">revoked</span>
                      ) : (
                        <span className="text-emerald-400">active</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {!revoked && (
                        <form action={revokeDevice}>
                          <input type="hidden" name="id" value={d.id} />
                          <button className="rounded border border-neutral-800 px-2 py-1 text-xs hover:bg-neutral-900">
                            Revoke
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
