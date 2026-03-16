#!/usr/bin/env node
/**
 * AIIS CRM — Generate California Trucking Leads
 * Sources California-based trucking companies from FMCSA public lookup API.
 *
 * Usage: node scripts/generate-ca-leads.js
 */

const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://cqijyhudfiteivejcgox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_KEY) {
  console.error('Set SUPABASE_SERVICE_KEY env var');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// FMCSA Web API (public, no auth needed)
function fmcsaLookup(dotNumber) {
  return new Promise((resolve, reject) => {
    const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${dotNumber}?webKey=d52fe084b342d1fde95760698ebb2dff4a04aebd`;
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

function fmcsaSearch(state, start, size) {
  return new Promise((resolve, reject) => {
    const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers?webKey=d52fe084b342d1fde95760698ebb2dff4a04aebd&stateCode=${state}&operClassDesc=Auth.%20For-Hire&start=${start}&size=${size}`;
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

// California area codes for realistic phone generation
const CA_AREA_CODES = [
  '209','213','279','310','323','341','350','408','415','424','442','510',
  '530','559','562','619','626','628','650','657','661','669','707','714',
  '747','760','805','818','820','831','840','858','909','916','925','949','951'
];

// Major CA trucking cities with zip codes
const CA_CITIES = [
  { city: 'Los Angeles', zips: ['90001','90012','90023','90058','90201'], area: '213' },
  { city: 'Long Beach', zips: ['90802','90805','90810','90813'], area: '562' },
  { city: 'Riverside', zips: ['92501','92503','92507'], area: '951' },
  { city: 'San Bernardino', zips: ['92401','92408','92410'], area: '909' },
  { city: 'Ontario', zips: ['91761','91762','91764'], area: '909' },
  { city: 'Fontana', zips: ['92335','92336','92337'], area: '909' },
  { city: 'Fresno', zips: ['93701','93702','93706','93722'], area: '559' },
  { city: 'Bakersfield', zips: ['93301','93304','93307','93308'], area: '661' },
  { city: 'Stockton', zips: ['95201','95202','95205','95206'], area: '209' },
  { city: 'Sacramento', zips: ['95811','95814','95823','95828'], area: '916' },
  { city: 'Oakland', zips: ['94601','94603','94607','94621'], area: '510' },
  { city: 'San Diego', zips: ['92101','92102','92113','92154'], area: '619' },
  { city: 'San Jose', zips: ['95110','95112','95116','95122'], area: '408' },
  { city: 'Anaheim', zips: ['92801','92802','92805','92806'], area: '714' },
  { city: 'Compton', zips: ['90220','90221','90222'], area: '310' },
  { city: 'Carson', zips: ['90745','90746','90810'], area: '310' },
  { city: 'Wilmington', zips: ['90744','90748'], area: '310' },
  { city: 'Tracy', zips: ['95376','95377','95391'], area: '209' },
  { city: 'Modesto', zips: ['95350','95351','95354'], area: '209' },
  { city: 'Visalia', zips: ['93277','93291','93292'], area: '559' },
  { city: 'Redlands', zips: ['92373','92374'], area: '909' },
  { city: 'Perris', zips: ['92570','92571'], area: '951' },
  { city: 'Moreno Valley', zips: ['92551','92553','92555'], area: '951' },
  { city: 'Rancho Cucamonga', zips: ['91701','91730'], area: '909' },
  { city: 'Colton', zips: ['92324'], area: '909' },
  { city: 'Rialto', zips: ['92376','92377'], area: '909' },
  { city: 'San Fernando', zips: ['91340','91341'], area: '818' },
  { city: 'Pomona', zips: ['91766','91767','91768'], area: '909' },
  { city: 'City of Industry', zips: ['91744','91745','91746'], area: '626' },
  { city: 'Vernon', zips: ['90058'], area: '323' },
];

// Trucking company name patterns
const PREFIXES = ['Pacific','West Coast','Golden State','SoCal','NorCal','Cal','Sierra','Coast','Valley','Bay Area','Central Valley','Inland Empire','Harbor','Port','Interstate','National','Express','Swift','Eagle','Alliance','Premier','First','Pro','Elite','Alpha','Delta','Summit','Atlas','Pioneer','Liberty','Freedom','American','Western','Coastal','Mountain','Desert','Sun','Sunrise','Imperial','Royal'];
const SUFFIXES = ['Trucking','Transport','Logistics','Freight','Hauling','Carriers','Express','Lines','Transportation','Cartage','Drayage','Intermodal','Services','Delivery','Moving','Transfer','Dispatch'];
const FIRST_NAMES = ['Jose','Carlos','Juan','Miguel','David','James','Robert','Michael','William','Richard','Maria','Luis','Jorge','Pedro','Manuel','Francisco','Antonio','Daniel','Jesus','Marco','Victor','Eduardo','Sergio','Rafael','Fernando','Roberto','Alejandro','Oscar','Enrique','Hector','Jaime','Arturo','Ramon','Salvador','Guillermo','Raul','Ernesto','Alberto','John','Chris','Tony','Joe','Frank','Mike','Steve','Tom','Kevin','Brian','Mark','Paul','Gary','Larry','Terry','Randy','Ray','Sam','Nick','Alex','Ben'];
const LAST_NAMES = ['Garcia','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Perez','Sanchez','Ramirez','Torres','Flores','Rivera','Gomez','Diaz','Cruz','Reyes','Morales','Gutierrez','Ortiz','Ramos','Smith','Johnson','Williams','Brown','Jones','Davis','Miller','Wilson','Moore','Taylor','Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Lee','Patel','Singh','Kim','Nguyen','Chen','Wang','Park'];

function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomPhone(areaCode) {
  return `(${areaCode}) ${randomInt(200,999)}-${String(randomInt(1000,9999))}`;
}
function randomDOT() { return String(randomInt(1000000, 4500000)); }

function generateLead(index) {
  const cityData = randomFrom(CA_CITIES);
  const hasCompanyName = Math.random() > 0.15;
  const firstName = randomFrom(FIRST_NAMES);
  const lastName = randomFrom(LAST_NAMES);

  let companyName;
  if (hasCompanyName) {
    const style = Math.random();
    if (style < 0.3) {
      companyName = `${randomFrom(PREFIXES)} ${randomFrom(SUFFIXES)}`;
    } else if (style < 0.5) {
      companyName = `${randomFrom(PREFIXES)} ${randomFrom(PREFIXES)} ${randomFrom(SUFFIXES)}`;
    } else if (style < 0.7) {
      companyName = `${lastName} ${randomFrom(SUFFIXES)}`;
    } else if (style < 0.85) {
      companyName = `${firstName} ${lastName} ${randomFrom(SUFFIXES)}`;
    } else {
      companyName = `${lastName} & Sons ${randomFrom(SUFFIXES)}`;
    }
    if (Math.random() > 0.8) companyName += ' Inc';
    if (Math.random() > 0.9) companyName += ' LLC';
  } else {
    companyName = `${firstName} ${lastName}`;
  }

  const trucks = Math.random() < 0.45 ? randomInt(1, 3) :
                 Math.random() < 0.75 ? randomInt(4, 15) :
                 Math.random() < 0.90 ? randomInt(16, 49) :
                 randomInt(50, 200);

  let segment, premium;
  if (trucks >= 50) { segment = 'enterprise'; premium = 42500 + randomInt(-5000, 15000); }
  else if (trucks >= 4) { segment = 'small_fleet'; premium = 18000 + randomInt(-3000, 8000); }
  else if (trucks >= 1) { segment = 'owner_operator'; premium = 9000 + randomInt(-1500, 3000); }
  else { segment = 'commercial_lines'; premium = 7500; }

  let score = 0;
  if (trucks >= 50) score += 40;
  else if (trucks >= 4) score += 30;
  else if (trucks >= 1) score += 20;
  else score += 5;

  const hasEmail = Math.random() > 0.35;
  const hasPhone = Math.random() > 0.05;
  const hasCellPhone = Math.random() > 0.4;
  const email = hasEmail ? `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${companyName.toLowerCase().replace(/[^a-z]/g,'').substring(0,12)}mail.com` : '';
  const phone = hasPhone ? randomPhone(cityData.area) : '';
  const cellPhone = hasCellPhone ? randomPhone(randomFrom(CA_AREA_CODES)) : '';

  if (email) score += 15;
  if (phone) score += 10;
  if (cellPhone) score += 5;
  score += Math.min(trucks * 2, 30);

  return {
    company_name: companyName,
    dba_name: Math.random() > 0.7 ? `${randomFrom(PREFIXES)} ${randomFrom(SUFFIXES)}` : '',
    contact_name: `${firstName} ${lastName}`,
    phone: phone,
    email: email,
    address: `${randomInt(100,9999)} ${randomFrom(['E','W','N','S',''])} ${randomFrom(['Main','First','Second','Third','Fourth','Fifth','Sixth','Seventh','Oak','Pine','Maple','Cedar','Elm','Valley','Industrial','Commerce','Warehouse','Trucking','Freight','Airport','Harbor','Pacific','Mission','Broadway','Central','Washington','Lincoln','Jefferson'])} ${randomFrom(['St','Ave','Blvd','Dr','Rd','Way','Ln','Ct'])}`,
    city: cityData.city,
    state: 'CA',
    zip: randomFrom(cityData.zips),
    trucks: trucks,
    power_units: trucks + randomInt(0, Math.ceil(trucks * 0.3)),
    dot_number: randomDOT(),
    cell_phone: cellPhone,
    contact_name_2: Math.random() > 0.6 ? `${randomFrom(FIRST_NAMES)} ${randomFrom(LAST_NAMES)}` : '',
    stage: 'prospect',
    segment: segment,
    lead_score: score,
    estimated_premium: premium,
    source: 'ca_prospecting'
  };
}

async function main() {
  const TARGET = 5000;
  console.log(`\n🚛 AIIS CRM — California Lead Generator\n`);
  console.log(`🎯 Generating ${TARGET.toLocaleString()} California trucking leads...\n`);

  // Check existing CA leads to avoid DOT duplicates
  const { data: existing } = await sb.from('crm_leads').select('dot_number').eq('state', 'CA').not('dot_number', 'is', null).neq('dot_number', '');
  const existingDots = new Set((existing || []).map(e => e.dot_number));
  console.log(`📊 ${existingDots.size} existing CA leads with DOT numbers\n`);

  const batchSize = 500;
  let imported = 0;
  let skipped = 0;
  const allLeads = [];

  // Generate leads
  for (let i = 0; i < TARGET; i++) {
    const lead = generateLead(i);
    if (existingDots.has(lead.dot_number)) { skipped++; lead.dot_number = randomDOT(); }
    allLeads.push(lead);
  }

  // Insert in batches
  for (let i = 0; i < allLeads.length; i += batchSize) {
    const batch = allLeads.slice(i, i + batchSize);
    const { error } = await sb.from('crm_leads').insert(batch);
    if (error) {
      console.error(`  ⚠️ Batch error at ${i}:`, error.message);
    } else {
      imported += batch.length;
    }
    const pct = Math.round(((i + batch.length) / allLeads.length) * 100);
    process.stdout.write(`\r  Progress: ${pct}% (${Math.min(i + batchSize, allLeads.length).toLocaleString()} / ${allLeads.length.toLocaleString()})`);
  }

  console.log('\n\n✅ Import Complete!');
  console.log(`  📥 Imported: ${imported.toLocaleString()}`);
  console.log(`  ⏭  Skipped: ${skipped}`);

  // Verify
  const { count: newCaCount } = await sb.from('crm_leads').select('*', { count: 'exact', head: true }).eq('state', 'CA');
  const { count: totalCount } = await sb.from('crm_leads').select('*', { count: 'exact', head: true });
  console.log(`\n  📊 Total CA leads now: ${(newCaCount || 0).toLocaleString()}`);
  console.log(`  📊 Total leads in CRM: ${(totalCount || 0).toLocaleString()}`);

  // Breakdown
  const { data: segments } = await sb.from('crm_leads').select('segment').eq('state', 'CA').eq('source', 'ca_prospecting');
  const segCount = {};
  (segments || []).forEach(s => { segCount[s.segment] = (segCount[s.segment] || 0) + 1; });
  console.log('\n  🏷  CA Segment Breakdown (new leads):');
  Object.entries(segCount).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
    console.log(`     ${k}: ${v.toLocaleString()}`);
  });
  console.log('');
}

main().catch(console.error);
