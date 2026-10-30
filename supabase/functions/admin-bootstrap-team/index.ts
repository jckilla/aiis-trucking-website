// NEUTRALIZED after one-time use (Sam + Eduardo provisioned 2026-07-06).
// Kept only because the MCP has no delete; safe to delete from the dashboard.
Deno.serve(() => new Response(JSON.stringify({ error: 'gone: one-off provisioner has been retired' }), { status: 410, headers: { 'Content-Type': 'application/json' } }));
