import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client (runs under the signed-in user's session; RLS applies).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
