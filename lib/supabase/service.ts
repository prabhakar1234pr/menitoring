import { createClient } from "@supabase/supabase-js";

// Service-role client. Bypasses RLS — use ONLY in trusted server code
// (ingest route + the cron summarize job), and always set user_id explicitly.
// Never import this from a Client Component.
export function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
