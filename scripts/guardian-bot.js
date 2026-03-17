#!/usr/bin/env node
/**
 * GuardianBot — Automated approval/review system for AdvancedIns.ai
 *
 * Scans pending changes (git diff) and classifies each as:
 *   SAFE     → auto-approved, no human review needed
 *   CAUTION  → auto-approved but flagged for awareness
 *   DANGER   → BLOCKED, requires Veronica's manual approval
 *
 * Usage:
 *   node scripts/guardian-bot.js              # Review staged changes
 *   node scripts/guardian-bot.js --all        # Review all uncommitted changes
 *   node scripts/guardian-bot.js --commit     # Review last commit
 *   node scripts/guardian-bot.js --watch      # Continuous monitoring mode
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ===================== DANGER PATTERNS =====================
// These ALWAYS require human approval — never auto-approve
const DANGER_PATTERNS = [
  // Credentials & secrets
  { pattern: /(?:password|secret|token|auth_token|api_key|apikey)\s*[:=]\s*['"][^'"]{8,}/gi, label: 'Hardcoded credential detected' },
  { pattern: /(?:AKIA|AIza|sk-|sk_live|pk_live|rk_live|whsec_)[A-Za-z0-9+/=]{20,}/g, label: 'API key/secret pattern detected' },
  { pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, label: 'JWT token in code' },

  // Destructive operations
  { pattern: /DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM\s+(?!.*WHERE)/gi, label: 'Destructive SQL without WHERE clause' },
  { pattern: /\.delete\(\)\s*(?!.*\.eq|.*\.match|.*\.in)/g, label: 'Supabase delete without filter' },
  { pattern: /rm\s+-rf\s+[/~]/g, label: 'Dangerous file deletion command' },

  // Financial risk
  { pattern: /purchasePhoneNumber|buy.*number|provision.*number/gi, label: 'Phone number purchase — costs $1.15+/mo each' },
  { pattern: /IncomingPhoneNumbers.*create/g, label: 'Twilio number provisioning' },

  // Security downgrades
  { pattern: /Access-Control-Allow-Origin['":\s]*['"]\*/g, label: 'Wildcard CORS — security vulnerability' },
  { pattern: /verifyRequest.*=.*false|skipAuth.*=.*true|noAuth/gi, label: 'Authentication bypass' },
  { pattern: /eval\s*\(/g, label: 'eval() usage — code injection risk' },

  // Payment / billing
  { pattern: /stripe|paypal|billing|charge|invoice.*create/gi, label: 'Payment/billing code change' },

  // Environment / deployment
  { pattern: /process\.env\.\w+\s*=\s*/g, label: 'Environment variable modification in code' },
  { pattern: /force.*push|push.*--force|-f.*origin/gi, label: 'Force push to remote' },
];

// ===================== CAUTION PATTERNS =====================
// Auto-approved but flagged for awareness
const CAUTION_PATTERNS = [
  { pattern: /twilio|Twilio/g, label: 'Twilio integration change' },
  { pattern: /supabase.*(?:insert|update|delete|upsert)/gi, label: 'Database write operation' },
  { pattern: /fetch\s*\(\s*['"]\/api\//g, label: 'API endpoint call' },
  { pattern: /\.env|environment/gi, label: 'Environment-related change' },
  { pattern: /auth|login|session|cookie/gi, label: 'Authentication-related change' },
  { pattern: /price|cost|premium|rate/gi, label: 'Pricing/financial display change' },
  { pattern: /FMCSA|DOT|compliance/gi, label: 'Regulatory compliance reference' },
  { pattern: /crm_leads.*update|update.*crm_leads/gi, label: 'Lead data modification' },
  { pattern: /navigator\.mediaDevices|getUserMedia/g, label: 'Microphone/camera access' },
  { pattern: /window\.location|redirect|href\s*=/gi, label: 'Navigation/redirect change' },
];

// ===================== SAFE PATTERNS =====================
// Files/changes that are always safe
const SAFE_FILES = [
  /\.md$/,           // Documentation
  /\.txt$/,          // Text files
  /content\//,       // Content directory
  /\.gitignore$/,    // Git ignore
  /README/i,         // Readme files
  /CHANGELOG/i,      // Changelogs
  /\.css$/,          // Pure CSS (no logic)
  /scripts\/generate/,// Lead generation scripts (read-only data)
  /scripts\/guardian-bot/,// GuardianBot itself (contains pattern definitions that trigger false positives)
  /scripts\/load-email/,// Email campaign loader (read-only data import)
];

// ===================== CORE LOGIC =====================

function getDiff(mode) {
  try {
    if (mode === '--commit') {
      return execSync('git diff HEAD~1 HEAD', { cwd: '/tmp/aiis-trucking-website', encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    } else if (mode === '--all') {
      return execSync('git diff HEAD', { cwd: '/tmp/aiis-trucking-website', encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    } else {
      // Default: staged changes
      return execSync('git diff --cached', { cwd: '/tmp/aiis-trucking-website', encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    }
  } catch (e) {
    return '';
  }
}

function getChangedFiles(mode) {
  try {
    if (mode === '--commit') {
      return execSync('git diff --name-only HEAD~1 HEAD', { cwd: '/tmp/aiis-trucking-website', encoding: 'utf-8' }).trim().split('\n');
    } else if (mode === '--all') {
      return execSync('git diff --name-only HEAD', { cwd: '/tmp/aiis-trucking-website', encoding: 'utf-8' }).trim().split('\n');
    } else {
      return execSync('git diff --cached --name-only', { cwd: '/tmp/aiis-trucking-website', encoding: 'utf-8' }).trim().split('\n');
    }
  } catch (e) {
    return [];
  }
}

function parseDiffByFile(diff) {
  const files = {};
  const chunks = diff.split(/^diff --git /m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const fileMatch = chunk.match(/a\/(.+?) b\//);
    if (fileMatch) {
      files[fileMatch[1]] = chunk;
    }
  }
  return files;
}

function scanContent(content, patterns) {
  const findings = [];
  for (const { pattern, label } of patterns) {
    // Reset regex
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    if (matches) {
      findings.push({ label, count: matches.length, sample: matches[0].substring(0, 80) });
    }
  }
  return findings;
}

function isFileAlwaysSafe(filename) {
  return SAFE_FILES.some(re => re.test(filename));
}

function reviewChanges(mode) {
  const diff = getDiff(mode);
  const files = getChangedFiles(mode).filter(f => f.trim());

  if (!diff && files.length === 0) {
    console.log('\n  ✅ No changes to review.\n');
    return { approved: true, dangers: [], cautions: [], safeFiles: [] };
  }

  const filesDiff = parseDiffByFile(diff);
  const dangers = [];
  const cautions = [];
  const safeFiles = [];

  for (const file of files) {
    if (!file.trim()) continue;

    if (isFileAlwaysSafe(file)) {
      safeFiles.push(file);
      continue;
    }

    const fileDiff = filesDiff[file] || '';
    // Only scan added lines (lines starting with +)
    const addedLines = fileDiff.split('\n')
      .filter(l => l.startsWith('+') && !l.startsWith('+++'))
      .join('\n');

    if (!addedLines) {
      safeFiles.push(file);
      continue;
    }

    const dangerFindings = scanContent(addedLines, DANGER_PATTERNS);
    const cautionFindings = scanContent(addedLines, CAUTION_PATTERNS);

    if (dangerFindings.length > 0) {
      dangers.push({ file, findings: dangerFindings });
    } else if (cautionFindings.length > 0) {
      cautions.push({ file, findings: cautionFindings });
    } else {
      safeFiles.push(file);
    }
  }

  // ===================== REPORT =====================
  const timestamp = new Date().toISOString();
  console.log('\n' + '═'.repeat(60));
  console.log('  🤖 GUARDIAN BOT — Change Review Report');
  console.log('  ' + timestamp);
  console.log('═'.repeat(60));

  // Safe files
  if (safeFiles.length > 0) {
    console.log('\n  ✅ SAFE — Auto-approved (' + safeFiles.length + ' files):');
    safeFiles.forEach(f => console.log('     ✓ ' + f));
  }

  // Caution files
  if (cautions.length > 0) {
    console.log('\n  ⚠️  CAUTION — Auto-approved with flags (' + cautions.length + ' files):');
    cautions.forEach(({ file, findings }) => {
      console.log('     ⚠ ' + file);
      findings.forEach(f => console.log('       → ' + f.label + ' (' + f.count + 'x)'));
    });
  }

  // Danger files
  if (dangers.length > 0) {
    console.log('\n  🚫 DANGER — REQUIRES VERONICA\'S APPROVAL (' + dangers.length + ' files):');
    dangers.forEach(({ file, findings }) => {
      console.log('     🔴 ' + file);
      findings.forEach(f => {
        console.log('       → ' + f.label + ' (' + f.count + 'x)');
        console.log('         Sample: ' + f.sample);
      });
    });
  }

  // Verdict
  console.log('\n' + '─'.repeat(60));
  const approved = dangers.length === 0;
  if (approved) {
    console.log('  ✅ VERDICT: APPROVED — All changes are safe to deploy.');
    if (cautions.length > 0) {
      console.log('     (' + cautions.length + ' files flagged for awareness but auto-approved)');
    }
  } else {
    console.log('  🚫 VERDICT: BLOCKED — ' + dangers.length + ' file(s) need manual approval.');
    console.log('     Veronica must review and approve before deploying.');
    console.log('     Run: node scripts/guardian-bot.js --approve to force approve');
  }
  console.log('─'.repeat(60) + '\n');

  // Save report to file
  const report = {
    timestamp,
    mode,
    verdict: approved ? 'APPROVED' : 'BLOCKED',
    files: { safe: safeFiles, caution: cautions, danger: dangers },
    totalFiles: files.length,
  };

  const reportDir = '/tmp/aiis-trucking-website/logs';
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, 'guardian-' + Date.now() + '.json'),
    JSON.stringify(report, null, 2)
  );

  return { approved, dangers, cautions, safeFiles };
}

// ===================== WATCH MODE =====================
function watchMode() {
  console.log('\n  🤖 GuardianBot WATCH MODE — monitoring for changes...');
  console.log('  Press Ctrl+C to stop.\n');

  let lastHash = '';
  setInterval(() => {
    try {
      const hash = execSync('git diff --cached --stat', { cwd: '/tmp/aiis-trucking-website', encoding: 'utf-8' });
      if (hash !== lastHash && hash.trim()) {
        lastHash = hash;
        reviewChanges('--staged');
      }
    } catch (e) {}
  }, 5000);
}

// ===================== MAIN =====================
const mode = process.argv[2] || '--all';

if (mode === '--watch') {
  watchMode();
} else if (mode === '--approve') {
  console.log('\n  ⚡ FORCE APPROVED by Veronica — deploying...\n');
  // Could trigger git push here
} else {
  const result = reviewChanges(mode);
  process.exit(result.approved ? 0 : 1);
}
