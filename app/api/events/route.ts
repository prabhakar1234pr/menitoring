import { NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth/resolveUser";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type IncomingEvent = {
  source?: string;
  app?: string;
  repo?: string;
  file?: string;
  url?: string;
  title?: string;
  video_id?: string;
  problem?: string;
  meta?: unknown;
  is_idle?: boolean;
  started_at?: string;
  duration_seconds?: number;
};

// Stateless ingest. Authenticates the request (JWT or device token), then
// appends the batch to events with the resolved user_id (service-role write).
export async function POST(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { events?: IncomingEvent[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const events = Array.isArray(body?.events) ? body.events : null;
  if (!events) {
    return NextResponse.json(
      { error: "expected { events: [...] }" },
      { status: 400 },
    );
  }
  if (events.length === 0) return NextResponse.json({ inserted: 0 });
  if (events.length > 500) {
    return NextResponse.json({ error: "too many events (max 500)" }, { status: 400 });
  }

  const rows = [];
  for (const e of events) {
    if (!e.started_at || Number.isNaN(Date.parse(e.started_at))) {
      return NextResponse.json(
        { error: "each event needs a valid ISO started_at" },
        { status: 400 },
      );
    }
    rows.push({
      user_id: resolved.userId,
      source: e.source === "extension" ? "extension" : "agent",
      app: e.app ?? null,
      repo: e.repo ?? null,
      file: e.file ?? null,
      url: e.url ?? null,
      title: e.title ?? null,
      video_id: e.video_id ?? null,
      problem: e.problem ?? null,
      meta: e.meta ?? null,
      is_idle: Boolean(e.is_idle),
      started_at: new Date(e.started_at).toISOString(),
      duration_seconds: Math.max(0, Math.floor(Number(e.duration_seconds) || 0)),
    });
  }

  const svc = createServiceClient();
  const { error } = await svc.from("events").insert(rows);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ inserted: rows.length, via: resolved.via });
}
