// Load pre-built email campaigns into Supabase crm_email_campaigns table
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://cqijyhudfiteivejcgox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxaWp5aHVkZml0ZWl2ZWpjZ294Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NzI5OTUsImV4cCI6MjA4OTI0ODk5NX0.08wZTXZSQvB98VEKCMLVc0EcuxleNVSOF5Fg0eKENHI';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const campaigns = [
  {
    name: 'Owner-Operator Cold Outreach — Initial',
    target_segment: 'owner_operator',
    target_stage: 'prospect',
    target_state: 'CA',
    subject: '{{first_name}}, your truck insurance is probably costing you too much',
    body_html: `<p>Hi {{first_name}},</p>
<p>I know you didn't wake up today hoping to hear from an insurance agent — so I'll keep this short.</p>
<p>I work with owner-operators across California, and right now I'm seeing drivers overpay by $2,000–$5,000/year on their primary liability, physical damage, and cargo coverage — usually because their current carrier hasn't re-shopped their policy in years.</p>
<p>At <strong>AdvancedIns.ai</strong>, we specialize exclusively in commercial trucking insurance. We're not a generalist agency that also "does trucks." This is all we do — primary auto liability, general liability, cargo, physical damage, bobtail, non-trucking liability, occupational accident. The full stack for owner-operators.</p>
<p>I'd like to run a <strong>no-obligation comparison</strong> against your current policy. Takes about 10 minutes on the phone. If we can't beat your rate or improve your coverage, I'll tell you straight up.</p>
<p>Worth a quick call this week?</p>
<p>Veronica Contreras<br>AdvancedIns.ai | <a href="https://fleet.ins2day.com">fleet.ins2day.com</a><br>California Commercial Trucking Insurance</p>`,
    status: 'draft'
  },
  {
    name: 'Owner-Operator — Follow-up (Day 3)',
    target_segment: 'owner_operator',
    target_stage: 'prospect',
    target_state: 'CA',
    subject: 'Re: {{first_name}}, your truck insurance is probably costing you too much',
    body_html: `<p>Hi {{first_name}},</p>
<p>Just bumping this up in your inbox — I know the road doesn't leave much time for emails.</p>
<p>Quick recap: I can run a side-by-side comparison of your current trucking insurance in about 10 minutes. I work with markets that specialize in California owner-operators, including drivers with newer authority and mixed driving records.</p>
<p>A few things I typically find when I review an O/O policy:</p>
<ul>
<li>Physical damage deductibles set too high (saving on premium but creating massive out-of-pocket risk)</li>
<li>Cargo coverage limits that don't match the freight being hauled</li>
<li>No occupational accident coverage (if you're an independent contractor, workers' comp doesn't cover you)</li>
<li>Bobtail or non-trucking liability gaps that leave you exposed when you're off-dispatch</li>
</ul>
<p>Even if you're happy with your current setup, a second set of eyes never hurts. No pressure, no games.</p>
<p>Talk soon,<br>Veronica</p>`,
    status: 'draft'
  },
  {
    name: 'Small Fleet (2-10 Trucks) — Initial Outreach',
    target_segment: 'small_fleet',
    target_stage: 'prospect',
    target_state: 'CA',
    subject: '{{company}} — are you leaving money on the table with your fleet insurance?',
    body_html: `<p>Hi {{first_name}},</p>
<p>Managing a fleet of trucks in California means insurance is one of your biggest fixed costs — and in this market, premiums are climbing even for clean fleets. I wanted to reach out because we specialize in helping small fleets like {{company}} reduce that cost without sacrificing coverage.</p>
<p>Here's what I typically see when I review a small fleet's policy:</p>
<ul>
<li><strong>No fleet safety discount</strong> applied, even with clean CSA scores</li>
<li><strong>One-size-fits-all coverage</strong> that doesn't account for mixed equipment</li>
<li><strong>Physical damage coverage</strong> that hasn't been adjusted as trucks depreciate</li>
<li><strong>Cargo limits</strong> that don't reflect the actual commodities being hauled</li>
<li><strong>No hired & non-owned auto</strong> coverage for personal vehicles on company business</li>
</ul>
<p>At <strong>AdvancedIns.ai</strong>, trucking insurance is our only business. We build policies specifically for fleets of your size — primary auto liability, general liability, cargo, physical damage, bobtail, non-trucking liability, workers' comp, and occupational accident.</p>
<p>I'd love to pull your SAFER data and run a no-obligation comparison. Takes about 15 minutes on a call.</p>
<p>Veronica Contreras<br>AdvancedIns.ai | <a href="https://fleet.ins2day.com">fleet.ins2day.com</a></p>`,
    status: 'draft'
  },
  {
    name: 'Small Fleet — Follow-up (Day 3)',
    target_segment: 'small_fleet',
    target_stage: 'prospect',
    target_state: 'CA',
    subject: 'Re: {{company}} fleet insurance — one quick thing',
    body_html: `<p>Hi {{first_name}},</p>
<p>Following up on my earlier email. I wanted to share something specific: I pulled your company's SAFER snapshot and noticed your fleet is based in California — which means you're subject to some of the highest insurance premiums in the country.</p>
<p>The good news? Fleets with clean CSA BASICs and a solid inspection history qualify for significantly better rates — but most agents don't shop the trucking-specific markets that actually reward that.</p>
<p>That's exactly what we do at AdvancedIns.ai. We work exclusively with commercial trucking markets that price based on <strong>your actual safety data</strong>, not just zip code and truck count.</p>
<p>Can I run a 15-minute comparison this week? No cost, no obligation. If I can't save you money, I'll tell you.</p>
<p>— Veronica</p>`,
    status: 'draft'
  },
  {
    name: 'Large Fleet (10+ Trucks) — Enterprise Outreach',
    target_segment: 'large_fleet',
    target_stage: 'prospect',
    target_state: 'CA',
    subject: 'Insurance review for {{company}} — protecting your fleet and your margins',
    body_html: `<p>Hi {{first_name}},</p>
<p>I'll get right to it — at your fleet size, insurance isn't just a line item, it's one of the top 3 expenses on your P&L. And with nuclear verdicts pushing $10M+ in California, carriers are tightening underwriting and raising rates across the board.</p>
<p>At <strong>AdvancedIns.ai</strong>, we work exclusively with commercial trucking fleets to build insurance programs that actually reflect your operation — not a generic policy copied from a smaller account.</p>
<p>For fleets of your size, we typically structure:</p>
<ul>
<li><strong>Primary auto liability</strong> with limits that match your contract requirements ($1M–$5M)</li>
<li><strong>Excess/umbrella coverage</strong> to protect against nuclear verdicts</li>
<li><strong>Fleet-wide physical damage</strong> with scheduled values per unit</li>
<li><strong>Cargo coverage</strong> tailored to the commodities you actually haul</li>
<li><strong>Workers' comp + occupational accident</strong> for W-2 drivers and 1099 operators</li>
<li><strong>General liability + hired/non-owned auto</strong></li>
</ul>
<p>I'd like to schedule a 20-minute insurance review with you or your safety director. I'll pull your SAFER data, review your CSA BASICs, and show you where you're exposed and where you're overpaying.</p>
<p>Would any day this week work?</p>
<p>Veronica Contreras<br>AdvancedIns.ai | <a href="https://fleet.ins2day.com">fleet.ins2day.com</a></p>`,
    status: 'draft'
  },
  {
    name: 'New Authority — Welcome to Trucking',
    target_segment: 'all',
    target_stage: 'prospect',
    target_state: 'CA',
    subject: 'Congrats on your MC authority, {{first_name}} — here\'s what you need for insurance',
    body_html: `<p>Hi {{first_name}},</p>
<p>Congratulations on getting your MC authority! That's a huge step, and I know there's a million things on your plate right now — insurance being one of the big ones.</p>
<p>I'm Veronica with AdvancedIns.ai. I specialize in getting new-authority trucking companies their insurance so they can get on the road. Here's what you'll need:</p>
<ul>
<li>✅ <strong>Primary Auto Liability</strong> — minimum $750K for general freight, $1M for HazMat, $5M for certain passenger/HazMat combinations (FMCSA requirement)</li>
<li>✅ <strong>BMC-91 or BMC-91X filing</strong> — your proof of insurance filed with FMCSA</li>
<li>✅ <strong>BOC-3 filing</strong> — designates your process agents</li>
<li>✅ <strong>Cargo insurance</strong> — typically $100K minimum, but many brokers/shippers require more</li>
<li>✅ <strong>Physical damage</strong> — if you're financing or leasing your truck, your lender requires this</li>
<li>✅ <strong>Occupational accident</strong> — critical if you're an owner-operator</li>
</ul>
<p>I work with markets that specialize in new-authority trucking companies. Yes, your rates will be higher in the first 1-2 years (that's normal), but I'll make sure you're not overpaying and that your coverage is set up correctly from day one.</p>
<p>Want me to put together a quote? I just need your DOT number and some basic info about your equipment.</p>
<p>— Veronica<br>AdvancedIns.ai | <a href="https://fleet.ins2day.com">fleet.ins2day.com</a></p>`,
    status: 'draft'
  },
  {
    name: 'Re-engagement — Lost Lead Revival',
    target_segment: 'all',
    target_stage: 'all',
    target_state: 'CA',
    subject: '{{first_name}}, things have changed since we last talked',
    body_html: `<p>Hi {{first_name}},</p>
<p>We connected a while back about your trucking insurance, but the timing wasn't right. Totally get it — insurance isn't exactly what keeps you up at night (until it is).</p>
<p>I'm reaching back out because the market has shifted since we last spoke. Several carriers have adjusted their rates for California trucking operations, and I've been able to find significantly better deals for drivers in your area.</p>
<p>If any of these apply to you right now, it might be worth a fresh look:</p>
<ul>
<li>Your renewal is coming up in the next 60 days</li>
<li>Your premium went up at your last renewal</li>
<li>You've added or changed equipment</li>
<li>You've had a clean year (no accidents, no violations)</li>
<li>You're thinking about expanding your fleet</li>
</ul>
<p>I can run an updated comparison in about 10 minutes. Same offer as before — no obligation, no pressure. If the numbers don't work, I'll tell you.</p>
<p>Worth another look?</p>
<p>— Veronica<br>AdvancedIns.ai</p>`,
    status: 'draft'
  },
  {
    name: 'Referral Program — Ask Happy Customers',
    target_segment: 'all',
    target_stage: 'all',
    target_state: 'all',
    subject: 'Know another trucker who\'s overpaying on insurance?',
    body_html: `<p>Hi {{first_name}},</p>
<p>Thanks for being a customer of AdvancedIns.ai — it means a lot that you trust us with your trucking insurance.</p>
<p>I have a quick ask: <strong>do you know another owner-operator or fleet owner in California who might be overpaying on their insurance?</strong></p>
<p>If you send them my way and they end up getting a policy through us, I'll send you a <strong>$100 gift card</strong> as a thank you. No limit on referrals.</p>
<p>All they need to do is mention your name when they call or email me, or you can just reply to this email with their name and phone number and I'll reach out personally.</p>
<p>Thanks again for trusting us with your coverage. I appreciate you.</p>
<p>— Veronica<br>AdvancedIns.ai | <a href="https://fleet.ins2day.com">fleet.ins2day.com</a></p>`,
    status: 'draft'
  },
  {
    name: 'Quote Follow-Up — Decision Pending',
    target_segment: 'all',
    target_stage: 'quoted',
    target_state: 'all',
    subject: '{{first_name}}, your trucking insurance quote is ready — quick question',
    body_html: `<p>Hi {{first_name}},</p>
<p>I sent over your quote a few days ago and wanted to check in. I know you're busy on the road, so I'll keep it short.</p>
<p>A few things worth knowing before your current policy renews:</p>
<ul>
<li>The rate I quoted is <strong>locked for 30 days</strong> — after that, I may need to re-quote depending on market changes</li>
<li>We can <strong>bind coverage the same day</strong> you decide — no waiting period</li>
<li>If you need to adjust coverage limits or deductibles, I can re-run numbers in minutes</li>
</ul>
<p>Is there anything holding you back? Sometimes it's a coverage question, sometimes it's just timing. Either way, I'd rather know so I can help.</p>
<p>Just reply to this email or call me at any time.</p>
<p>— Veronica<br>AdvancedIns.ai</p>`,
    status: 'draft'
  }
];

async function loadCampaigns() {
  console.log('Loading ' + campaigns.length + ' email campaigns into Supabase...\n');

  for (const campaign of campaigns) {
    const { data, error } = await sb.from('crm_email_campaigns').insert(campaign).select();
    if (error) {
      console.error('❌ ' + campaign.name + ' — ' + error.message);
    } else {
      console.log('✅ ' + campaign.name);
    }
  }

  const { count } = await sb.from('crm_email_campaigns').select('*', { count: 'exact', head: true });
  console.log('\n📊 Total campaigns in CRM: ' + count);
}

loadCampaigns().catch(console.error);
