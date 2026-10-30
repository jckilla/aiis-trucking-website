import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// One-time setup-link generator — DISABLED after use. Safe to delete from the dashboard.
Deno.serve(() => new Response(JSON.stringify({ error: "gone" }), { status: 410, headers: { "Content-Type": "application/json" } }));
