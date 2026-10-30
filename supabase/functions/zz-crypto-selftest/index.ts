// RETIRED. This was a one-off self-test proving that Stripe signature
// verification works in Supabase's Deno runtime. It has served its purpose and
// does nothing now. Safe to delete from the dashboard.
Deno.serve(() =>
  new Response(JSON.stringify({ error: 'Gone. This self-test function is retired and can be deleted.' }), {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
  })
);
