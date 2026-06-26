import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { runSummarize } from "@/lib/summarize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby allows up to 60s

// Centralized hourly fan-out. pg_cron (via pg_net) calls this with x-cron-secret.
// It is the only place the per-user summarize loop runs.
async function handle(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const svc = createServiceClient();
    const result = await runSummarize(svc);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}

// Allow GET too, so it can be triggered/tested from a browser or simple curl.
export async function GET(req: Request) {
  return handle(req);
}
