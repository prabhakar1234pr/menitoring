import Link from "next/link";
import { signout } from "@/app/auth/actions";

export function Nav({ email, tz }: { email: string; tz?: string }) {
  return (
    <header className="border-b border-neutral-800">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/dashboard" className="font-medium hover:underline">
            Today
          </Link>
          <Link href="/timetable" className="text-neutral-400 hover:text-white">
            Timetable
          </Link>
          <Link href="/devices" className="text-neutral-400 hover:text-white">
            Devices
          </Link>
        </nav>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <span>
            {email}
            {tz ? ` · ${tz}` : ""}
          </span>
          <form action={signout}>
            <button className="rounded border border-neutral-800 px-2 py-1 hover:bg-neutral-900">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
