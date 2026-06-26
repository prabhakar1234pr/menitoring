import Link from "next/link";
import { login } from "../auth/actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Track your hours, get AI notes.
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}

      <form className="flex flex-col gap-3">
        <input
          name="email"
          type="email"
          required
          placeholder="you@example.com"
          className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
        />
        <input
          name="password"
          type="password"
          required
          placeholder="Password"
          className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
        />
        <button
          formAction={login}
          className="rounded-md bg-white px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-200"
        >
          Sign in
        </button>
      </form>

      <p className="text-sm text-neutral-400">
        No account?{" "}
        <Link href="/signup" className="text-white underline">
          Sign up
        </Link>
      </p>
    </main>
  );
}
