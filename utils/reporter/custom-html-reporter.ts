/**
 * Custom Playwright HTML reporter — self-contained, deterministic output.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

export interface TestEntry {
  title: string;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  /** True when the run ultimately passed after at least one retry. */
  flaky: boolean;
  duration: number;
  durationMs: number;
  location: string;
  project: string;
  browser: string;
  runMode: string;
  fullPath: string;
  file: string;
  tags: string[];
  likelyCause: string | null;
  errors: string[];
  assertionValues: string[];
  screenshot: string | null;
  video: string | null;
  trace: string | null;
  retry: number;
}

export interface FeatureGroup {
  name: string;
  tests: TestEntry[];
  passed: number;
  failed: number;
  skipped: number;
  timedOut: number;
  interrupted: number;
  flaky: number;
}

interface RunHistoryFile {
  version: number;
  runs: RunHistoryEntry[];
}

interface RunHistoryEntry {
  at: string;
  durationSec: number;
  totals: {
    passed: number;
    failed: number;
    timedOut: number;
    skipped: number;
    interrupted: number;
    flaky: number;
  };
  passRatePct: number;
  totalExecuted: number;
}

const RUN_HISTORY_VERSION = 1;
const RUN_HISTORY_MAX = 50;
const SPARKLINE_RUNS = 7;
const SLOWEST_N = 5;
const SLOW_WARN_SEC = 60;

/** Project module coverage: a test file can match multiple rows; each module pill is marked covered if any test file matched. */
const COVERAGE_MODULES: { label: string; re: RegExp }[] = [
  { label: 'Authentication Setup', re: /fixtures[\\/]auth\.setup\.ts/i },
  { label: 'Login', re: /tests[\\/]login[\\/]/i },
  { label: 'Accounts', re: /tests[\\/]accounts[\\/]/i },
  { label: 'Admin', re: /tests[\\/]admin[\\/]/i },
  { label: 'GL', re: /tests[\\/]gl[\\/]/i },
  { label: 'Lockbox', re: /tests[\\/]lockbox[\\/]/i },
  { label: 'RBAC', re: /tests[\\/]rbac[\\/]/i },
  { label: 'Business Flows', re: /tests[\\/]e2e[\\/]/i },
];

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizeFileName(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function extractAtTags(title: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /@([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(title)) !== null) {
    const t = m[1];
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function inferLikelyCause(status: TestEntry['status'] | TestResult['status'], errors: string[]): string | null {
  if (status !== 'timedOut' && status !== 'failed' && status !== 'interrupted') return null;
  const text = errors.join('\n');
  const lower = text.toLowerCase();

  if (status === 'timedOut') {
    if (
      /loadpanel|load panel|dx-loadpanel|devextreme|dx-data-grid|data-grid|dxgrid/i.test(text) ||
      (/waiting for|locator\.|getbyrole|getbytestid|expect\(.*\)\.tobevisible/i.test(lower) &&
        /attached|visible|hidden|stable/i.test(lower))
    ) {
      return 'Likely cause: DevExtreme load panel or grid still busy — wait for overlay to clear or scope the locator.';
    }
    if (/api|network|fetch|xhr|requestfailed|net::/i.test(text)) {
      return 'Likely cause: network or API latency — check trace HAR / timing vs baseline.';
    }
    if (/locator|selector|timeout \d+ms exceeded|exceeded/i.test(lower)) {
      return 'Likely cause: element not ready or selector flake — confirm load state before assertions.';
    }
    return 'Likely cause: timeout — compare with trace; often load panel, API spike, or slow grid render.';
  }

  if (status === 'failed') {
    if (/loadpanel|dx-loadpanel|load panel/i.test(text)) {
      return 'Hint: DevExtreme load panel may be blocking interaction.';
    }
    if (/strict mode violation|strict mode/i.test(lower)) {
      return 'Hint: locator resolved to multiple elements — narrow the selector.';
    }
  }

  return null;
}

function modulesCoveredFromFiles(files: Iterable<string>): Set<string> {
  const covered = new Set<string>();
  for (const raw of files) {
    const norm = raw.replace(/\\/g, '/');
    for (const { label, re } of COVERAGE_MODULES) {
      if (re.test(norm)) covered.add(label);
    }
  }
  return covered;
}

function tagChipVariant(tag: string): string {
  const t = tag.toLowerCase();
  if (t === 'serial') return 'chip-serial';
  if (t === 'submission' || t === 'home_page') return 'chip-area';
  if (t === 'displayed' || t === 'smoke') return 'chip-meta';
  if (t === 'uw' || t === 'mng') return 'chip-role';
  const h = [...tag].reduce((a, c) => a + c.charCodeAt(0), 0);
  return `chip-h${h % 6}`;
}

function resolveLogoAbsolute(logoPath: string | undefined, config: FullConfig | undefined): string | null {
  if (!logoPath) return null;
  if (path.isAbsolute(logoPath)) return fs.existsSync(logoPath) ? logoPath : null;
  const bases: string[] = [];
  if (config?.configFile) bases.push(path.dirname(config.configFile));
  if (config?.rootDir) bases.push(config.rootDir);
  bases.push(process.cwd());
  for (const base of bases) {
    const abs = path.resolve(base, logoPath);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function embedLogoAsBase64DataUri(logoPath: string | undefined, config: FullConfig | undefined): string | null {
  const abs = resolveLogoAbsolute(logoPath, config);
  if (!abs) return null;
  try {
    const buf = fs.readFileSync(abs);
    const base64 = Buffer.from(buf).toString('base64');
    const ext = path.extname(abs).toLowerCase();
    const mime =
      ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.webp'
            ? 'image/webp'
            : 'image/png';
    return `data:${mime};base64,${base64}`;
  } catch {
    return null;
  }
}

function attachmentImageDataUri(attPath: string, contentType?: string): string | null {
  try {
    const buf = fs.readFileSync(attPath);
    const ext = path.extname(attPath).toLowerCase();
    const mime =
      contentType && contentType.toLowerCase().startsWith('image/')
        ? contentType
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.gif'
            ? 'image/gif'
            : ext === '.webp'
              ? 'image/webp'
              : 'image/png';
    return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
  } catch {
    return null;
  }
}

function getProjectName(test: TestCase): string {
  let suite: Suite | undefined = test.parent;
  while (suite) {
    try {
      const p = typeof suite.project === 'function' ? suite.project() : undefined;
      if (p?.name) return p.name;
    } catch {
      /* ignore */
    }
    suite = suite.parent;
  }
  return 'default';
}

function inferBrowser(projectName: string): string {
  const n = projectName.toLowerCase();
  if (n.includes('chromium')) return 'Chromium';
  if (n.includes('firefox')) return 'Firefox';
  if (n.includes('webkit')) return 'WebKit';
  if (n.includes('msedge')) return 'Edge';
  return projectName;
}

function inferRunMode(projectName: string): string {
  return /serial/i.test(projectName) ? 'serial' : 'parallel';
}

function getFeatureName(test: TestCase): string {
  let s: Suite | undefined = test.parent;
  while (s) {
    const t = (s.title || '').trim();
    if (t) return t;
    s = s.parent;
  }
  return 'Ungrouped Tests';
}

function buildFullPath(test: TestCase, projectName: string): string {
  const parts: string[] = [];
  let s: Suite | undefined = test.parent;
  while (s) {
    if (s.title && s.title.trim()) parts.unshift(s.title.trim());
    s = s.parent;
  }
  const file = test.location?.file ? path.basename(test.location.file) : 'unknown';
  return `FULL PATH > ${projectName} > ${file} > ${parts.join(' > ')} > ${test.title}`;
}

function extractErrors(result: TestResult): string[] {
  return (result.errors || [])
    .map((e) => (e && (e.message || e.stack)) || '')
    .filter(Boolean);
}

function extractAssertionValues(errors: string[]): string[] {
  const out: string[] = [];
  const text = errors.join('\n');
  const expectedRe = /Expected:\s*([^\n]+)/gi;
  const receivedRe = /Received:\s*([^\n]+)/gi;
  const exp = [...text.matchAll(expectedRe)].map((m) => m[1].trim());
  const rec = [...text.matchAll(receivedRe)].map((m) => m[1].trim());
  const n = Math.max(exp.length, rec.length);
  for (let i = 0; i < n; i++) {
    out.push(`Expected: ${exp[i] ?? '(n/a)'}\nReceived: ${rec[i] ?? '(n/a)'}`);
  }
  return out;
}

function collectAttachmentsFromResult(result: TestResult) {
  const list: NonNullable<TestResult['attachments']> = [];
  const add = (att: NonNullable<TestResult['attachments']>[0]) => {
    if (att) list.push(att);
  };
  for (const att of result.attachments || []) add(att);
  const walk = (steps: TestResult['steps']) => {
    if (!steps) return;
    for (const step of steps) {
      for (const att of step.attachments || []) add(att);
      walk(step.steps);
    }
  };
  walk(result.steps);
  return list;
}

function isScreenshot(att: { name?: string; contentType?: string }): boolean {
  const n = (att.name || '').toLowerCase();
  if (n === 'screenshot') return true;
  const ct = (att.contentType || '').toLowerCase();
  return ct.startsWith('image/');
}

function isVideoAtt(att: { name?: string; contentType?: string }): boolean {
  const n = (att.name || '').toLowerCase();
  if (n === 'video') return true;
  return (att.contentType || '').toLowerCase() === 'video/webm';
}

function isTraceAtt(att: { name?: string; contentType?: string; path?: string }): boolean {
  const n = (att.name || '').toLowerCase();
  if (n === 'trace') return true;
  const ct = (att.contentType || '').toLowerCase();
  if (ct === 'application/zip') return true;
  const base = path.basename(att.path || '').toLowerCase();
  return base === 'trace.zip' || base.startsWith('trace.');
}

function readRunHistory(historyPath: string): RunHistoryEntry[] {
  try {
    if (!fs.existsSync(historyPath)) return [];
    const raw = fs.readFileSync(historyPath, 'utf8');
    const parsed = JSON.parse(raw) as RunHistoryFile;
    if (!parsed || parsed.version !== RUN_HISTORY_VERSION || !Array.isArray(parsed.runs)) return [];
    return parsed.runs;
  } catch {
    return [];
  }
}

function writeRunHistory(historyPath: string, runs: RunHistoryEntry[]): void {
  const dir = path.dirname(historyPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data: RunHistoryFile = { version: RUN_HISTORY_VERSION, runs: runs.slice(-RUN_HISTORY_MAX) };
  fs.writeFileSync(historyPath, JSON.stringify(data, null, 2), 'utf8');
}

function passRatePct(
  passed: number,
  failed: number,
  timedOut: number,
  interrupted: number,
  flaky: number,
): number {
  const totalExec = passed + failed + timedOut + interrupted + flaky;
  if (totalExec <= 0) return 0;
  const ok = passed + flaky;
  return Math.round((100 * ok) / totalExec);
}

function governanceEnv() {
  const releaseTag = process.env.RELEASE_TAG || process.env.SPRINT_RELEASE || '';
  const dataClass = process.env.REPORT_DATA_CLASSIFICATION || 'Internal';
  const pii = process.env.REPORT_PII_MASKING || 'Not Declared';
  const bu = process.env.REPORT_BU || 'MNG';
  return { releaseTag, dataClass, pii, bu };
}

function resolveReportBaseURL(config: FullConfig | undefined): string {
  if (config?.projects) {
    for (const p of config.projects) {
      const u = (p as { use?: { baseURL?: string } }).use?.baseURL;
      if (typeof u === 'string' && u) return u;
    }
  }
  return process.env.QA_URL || '';
}

export default class CustomHTMLReporter implements Reporter {
  private features = new Map<string, TestEntry[]>();

  private baseOutputFolder: string;

  private outputDir: string;

  private assetsDir: string;

  private config: FullConfig | undefined;

  private startTime = Date.now();

  private logoPath: string | undefined;

  private reportTitle: string;

  private logoBase64DataUri: string | null = null;

  private testFiles = new Set<string>();

  private projectNames = new Set<string>();

  constructor(options?: { outputFolder?: string; logoPath?: string; reportTitle?: string }) {
    this.baseOutputFolder = options?.outputFolder || 'test-results/custom-html-report';
    this.outputDir = this.baseOutputFolder;
    this.assetsDir = path.join(this.outputDir, 'assets');
    this.logoPath = options?.logoPath;
    this.reportTitle = options?.reportTitle || 'MINING QA AUTOMATION TEST REPORT';
  }

  private getDatedFolderName(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(
      d.getMinutes(),
    )}-${pad(d.getSeconds())}`;
  }

  /** Persists outside outputDir so it survives onBegin wipe. */
  private getHistoryPath(): string {
    return path.join(this.baseOutputFolder, 'custom-html-run-history.json');
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    this.config = config;
    this.startTime = Date.now();
    this.testFiles.clear();
    this.projectNames.clear();

    const dated = this.getDatedFolderName();
    this.outputDir = path.join(this.baseOutputFolder, dated);
    this.assetsDir = path.join(this.outputDir, 'assets');

    fs.mkdirSync(this.baseOutputFolder, { recursive: true });
    fs.mkdirSync(this.assetsDir, { recursive: true });

    // Pointer to latest report folder for quick open, matching extent reporter behavior.
    try {
      fs.writeFileSync(path.join(this.baseOutputFolder, 'latest.txt'), this.outputDir, 'utf8');
    } catch {
      // ignore pointer write errors
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const projectName = getProjectName(test);
    this.projectNames.add(projectName);
    const browser = inferBrowser(projectName);
    const runMode = inferRunMode(projectName);
    const featureName = getFeatureName(test);
    const durationMs = result.duration || 0;
    const durationSec = durationMs / 1000;
    const loc = test.location
      ? `${test.location.file}:${test.location.line}`
      : '';
    const file = test.location?.file || '';
    if (file) this.testFiles.add(path.normalize(file));

    const errors = extractErrors(result);
    const assertionValues = extractAssertionValues(errors);
    const fullPath = buildFullPath(test, projectName);
    const tags = extractAtTags(test.title);
    const flaky = result.status === 'passed' && result.retry > 0;
    let status = result.status;
    if (flaky) {
      status = 'passed';
    }

    const likelyCause = inferLikelyCause(result.status, errors);

    let screenshot: string | null = null;
    let video: string | null = null;
    let trace: string | null = null;

    const attachments = collectAttachmentsFromResult(result);
    const base = `${sanitizeFileName(test.id)}-retry${result.retry}`;

    for (const att of attachments) {
      if (!att.path || !fs.existsSync(att.path)) continue;
      if (isScreenshot(att)) {
        screenshot = attachmentImageDataUri(att.path, att.contentType);
      } else if (isVideoAtt(att)) {
        const ext = path.extname(att.path) || '.webm';
        const attName = (att.name || 'video').replace(/[^a-zA-Z0-9._-]+/g, '_');
        const destName = `${base}-${attName}${ext}`;
        const destPath = path.join(this.assetsDir, destName);
        try {
          fs.copyFileSync(att.path, destPath);
        } catch {
          continue;
        }
        const rel = `assets/${destName}`;
        video = rel;
      } else if (isTraceAtt(att)) {
        const ext = path.extname(att.path) || '.zip';
        const attName = (att.name || 'trace').replace(/[^a-zA-Z0-9._-]+/g, '_');
        const destName = `${base}-${attName}${ext}`;
        const destPath = path.join(this.assetsDir, destName);
        try {
          fs.copyFileSync(att.path, destPath);
        } catch {
          continue;
        }
        const rel = `assets/${destName}`;
        trace = rel;
      }
    }

    const entry: TestEntry = {
      title: test.title,
      status,
      flaky,
      duration: durationSec,
      durationMs,
      location: loc,
      project: projectName,
      browser,
      runMode,
      fullPath,
      file,
      tags,
      likelyCause,
      errors,
      assertionValues,
      screenshot,
      video,
      trace,
      retry: result.retry,
    };

    if (!this.features.has(featureName)) this.features.set(featureName, []);
    this.features.get(featureName)!.push(entry);
  }

  onEnd(result: FullResult): void {
    const featureNames = [...this.features.keys()].sort((a, b) => a.localeCompare(b));
    const groups: FeatureGroup[] = [];
    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalTimedOut = 0;
    let totalInterrupted = 0;
    let totalFlaky = 0;

    for (const name of featureNames) {
      const tests = this.features.get(name)!;
      tests.sort((a, b) => a.title.localeCompare(b.title));
      let passed = 0;
      let failed = 0;
      let skipped = 0;
      let timedOut = 0;
      let interrupted = 0;
      let flaky = 0;
      for (const t of tests) {
        if (t.status === 'passed') {
          if (t.flaky) flaky++;
          else passed++;
        } else if (t.status === 'skipped') skipped++;
        else if (t.status === 'timedOut') timedOut++;
        else if (t.status === 'interrupted') interrupted++;
        else failed++;
      }
      totalPassed += passed;
      totalFailed += failed;
      totalSkipped += skipped;
      totalTimedOut += timedOut;
      totalInterrupted += interrupted;
      totalFlaky += flaky;
      groups.push({ name, tests, passed, failed, skipped, timedOut, interrupted, flaky });
    }

    const totalTests = totalPassed + totalFailed + totalSkipped + totalTimedOut + totalInterrupted + totalFlaky;
    const durationMs = Date.now() - this.startTime;
    this.logoBase64DataUri = embedLogoAsBase64DataUri(this.logoPath, this.config);
    if (this.logoPath && !this.logoBase64DataUri) {
      console.warn(
        `[custom-html-reporter] logo not found for ${JSON.stringify(this.logoPath)}. Place skyward-logo.png under reporters/ or set an absolute logoPath.`,
      );
    }

    const rate = passRatePct(totalPassed, totalFailed, totalTimedOut, totalInterrupted, totalFlaky);
    const totalExecuted = totalPassed + totalFailed + totalTimedOut + totalInterrupted + totalFlaky;

    const historyPath = this.getHistoryPath();
    const prev = readRunHistory(historyPath);
    const entry: RunHistoryEntry = {
      at: new Date().toISOString(),
      durationSec: Math.round((durationMs / 1000) * 10) / 10,
      totals: {
        passed: totalPassed,
        failed: totalFailed,
        timedOut: totalTimedOut,
        skipped: totalSkipped,
        interrupted: totalInterrupted,
        flaky: totalFlaky,
      },
      passRatePct: rate,
      totalExecuted,
    };
    writeRunHistory(historyPath, [...prev, entry]);

    const historyForSpark = [...prev, entry].slice(-SPARKLINE_RUNS);

    const allTestsFlat = groups.flatMap((g) => g.tests);
    const slowest = [...allTestsFlat].sort((a, b) => b.durationMs - a.durationMs).slice(0, SLOWEST_N);
    const maxSlowMs = slowest.length ? Math.max(...slowest.map((t) => t.durationMs), 1) : 1;
    const coveredMods = modulesCoveredFromFiles(this.testFiles);

    const baseURL = resolveReportBaseURL(this.config);

    const projectsLine = Array.from(this.projectNames).sort((a, b) => a.localeCompare(b)).join(', ');

    const html = this.generateHTML(
      groups,
      {
        totalPassed,
        totalFailed,
        totalSkipped,
        totalTimedOut,
        totalInterrupted,
        totalFlaky,
        totalTests,
        totalExecuted,
        passRatePct: rate,
      },
      result.status,
      durationMs / 1000,
      historyForSpark,
      slowest,
      maxSlowMs,
      coveredMods,
      baseURL,
      projectsLine,
    );

    const datedIndexPath = path.join(this.outputDir, 'index.html');
    fs.writeFileSync(datedIndexPath, html, 'utf8');

    // Keep a latest snapshot at the base folder for quick access.
    const latestIndexPath = path.join(this.baseOutputFolder, 'index.html');
    fs.writeFileSync(latestIndexPath, html, 'utf8');

    console.log(`[custom-html-reporter] wrote ${datedIndexPath}`);
    console.log(`[custom-html-reporter] updated latest index ${latestIndexPath}`);
  }

  private generateHTML(
    features: FeatureGroup[],
    agg: {
      totalPassed: number;
      totalFailed: number;
      totalSkipped: number;
      totalTimedOut: number;
      totalInterrupted: number;
      totalFlaky: number;
      totalTests: number;
      totalExecuted: number;
      passRatePct: number;
    },
    status: FullResult['status'],
    durationSec: number,
    history: RunHistoryEntry[],
    slowest: TestEntry[],
    maxSlowMs: number,
    coveredMods: Set<string>,
    baseURL: string,
    projectsLine: string,
  ): string {
    const now = new Date();
    const ts = now.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const {
      totalPassed: passed,
      totalFailed: failed,
      totalSkipped: skipped,
      totalTimedOut: tOut,
      totalInterrupted: intr,
      totalFlaky: flaky,
      totalTests: total,
      passRatePct: passPct,
    } = agg;

    const denom = total || 1;
    const wPass = (passed / denom) * 100;
    const wFail = (failed / denom) * 100;
    const wTime = (tOut / denom) * 100;
    const wIntr = (intr / denom) * 100;
    const wFlaky = (flaky / denom) * 100;
    const wSkipBar = (skipped / denom) * 100;

    const gov = governanceEnv();
    const testedBy = os.userInfo().username || '—';
    const nodeVer = process.version;
    const osName = `${process.platform}`;
    const releaseGateEnv = process.env.RELEASE_GATE;
    const releaseGate =
      releaseGateEnv ||
      (failed + tOut + intr === 0 ? 'GO' : 'NO-GO');
    const gateBad = releaseGate === 'NO-GO';
    const piiGap = /^not\s*declared$/i.test(gov.pii.trim()) || gov.pii === 'Not Declared';

    const sparkW = 140;
    const sparkH = 36;
    const barW = sparkW / Math.max(history.length, 1);
    const sparkBars = history
      .map((r, i) => {
        const h = (r.passRatePct / 100) * (sparkH - 4);
        const x = i * barW + 1;
        const y = sparkH - h - 2;
        const fill =
          r.passRatePct >= 85 ? 'var(--pass)' : r.passRatePct >= 50 ? 'var(--timeout-warn)' : 'var(--fail)';
        return `<rect x="${x}" y="${y}" width="${Math.max(barW - 2, 2)}" height="${Math.max(h, 1)}" fill="${fill}" rx="1"/>`;
      })
      .join('');

    const coveragePills = COVERAGE_MODULES.map(({ label }) => {
      const on = coveredMods.has(label);
      return `<span class="cov-pill${on ? ' cov-on' : ' cov-off'}" title="${on ? 'Covered this run' : 'Not exercised this run'}">${escapeHtml(label)}</span>`;
    }).join('');

    const slowRows = slowest
      .map((t) => {
        const pct = Math.round((t.durationMs / maxSlowMs) * 100);
        const warn = t.duration >= SLOW_WARN_SEC;
        return `<div class="slow-row">
          <div class="slow-name"><span class="mono">${warn ? '⚠ ' : ''}</span>${escapeHtml(t.title.slice(0, 80))}${t.title.length > 80 ? '…' : ''}</div>
          <div class="slow-bar-wrap"><div class="slow-bar" style="width:${pct}%"></div></div>
          <div class="slow-dur mono">${t.duration.toFixed(1)}s</div>
        </div>`;
      })
      .join('');

    const renderTest = (t: TestEntry, idx: number, featIdx: number) => {
      const isFail = t.status === 'failed' || t.status === 'timedOut' || t.status === 'interrupted';
      const dotClass =
        t.status === 'passed'
          ? t.flaky
            ? 'dot-flaky'
            : 'dot-pass'
          : t.status === 'skipped'
            ? 'dot-skip'
            : t.status === 'timedOut'
              ? 'dot-timeout'
              : 'dot-fail';
      let tagLabel =
        t.flaky ? 'flaky' : t.status === 'timedOut' ? 'timed out' : t.status === 'interrupted' ? 'interrupted' : t.status;
      const dataStatus =
        t.status === 'failed' || t.status === 'timedOut' || t.status === 'interrupted'
          ? t.status === 'timedOut'
            ? 'timedOut'
            : t.status === 'interrupted'
              ? 'interrupted'
              : 'failed'
          : t.flaky
            ? 'flaky'
            : t.status;

      const tagChips = t.tags
        .map((tag) => `<span class="tag-chip ${tagChipVariant(tag)}">@${escapeHtml(tag)}</span>`)
        .join('');

      let body = `
        <div class="meta-box">
          <div class="meta-grid">
            <div><span class="meta-label">Location</span><span class="mono meta-val">${escapeHtml(t.location)}</span></div>
            <div><span class="meta-label">Time</span><span class="mono meta-val">${t.duration.toFixed(2)}s</span></div>
            <div><span class="meta-label">Project</span><span class="mono meta-val">${escapeHtml(t.project)}</span></div>
            <div><span class="meta-label">Browser</span><span class="meta-val">${escapeHtml(t.browser)}</span></div>
            <div><span class="meta-label">Run mode</span><span class="meta-val">${escapeHtml(t.runMode)}</span></div>
          </div>
        </div>`;

      if (t.likelyCause && isFail) {
        body += `<div class="likely-cause"><span class="likely-label">Triage</span> ${escapeHtml(t.likelyCause)}</div>`;
      }

      body += `<div class="breadcrumb mono">${escapeHtml(t.fullPath)}</div>`;

      if (t.screenshot) {
        body += `
        <div class="section">
          <div class="section-title">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
            Screenshot
          </div>
          <div class="screenshot-wrap">
            <img class="screenshot-img" src="${escapeHtml(t.screenshot)}" alt="Screenshot" />
          </div>
        </div>`;
      }

      if (isFail) {
        if (t.errors.length) {
          body += `
          <div class="error-box">
            <div class="error-title">${t.errors.length} error(s)</div>
            <pre class="error-pre">${escapeHtml(t.errors.join('\n\n'))}</pre>
          </div>`;
        }
        if (t.assertionValues.length) {
          body += `
          <div class="assert-box">
            <div class="assert-title">Assertion values</div>
            <pre class="assert-pre">${escapeHtml(t.assertionValues.join('\n\n---\n\n'))}</pre>
          </div>`;
        }
        const links: string[] = [];
        if (t.video) {
          links.push(
            `<a class="link-pill" href="${escapeHtml(t.video)}" target="_blank" rel="noreferrer">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Video
            </a>`,
          );
        }
        if (t.trace) {
          links.push(
            `<a class="link-pill" href="${escapeHtml(t.trace)}" target="_blank" rel="noreferrer">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              Trace
            </a>`,
          );
        }
        if (links.length) {
          body += `<div class="attach-row">${links.join('')}</div>`;
        }
      }

      return `
      <div class="test-item${isFail || t.flaky ? ' open' : ''}" data-status="${dataStatus}" data-feat="${featIdx}" data-test="${idx}">
        <button type="button" class="test-header" aria-expanded="${isFail || t.flaky ? 'true' : 'false'}">
          <span class="chevron">▶</span>
          <span class="${dotClass}"></span>
          <span class="test-title">${escapeHtml(t.title)}</span>
          <span class="test-tags-inline">${tagChips}</span>
          <span class="test-dur mono">${t.duration.toFixed(2)}s</span>
          <span class="test-browser">${escapeHtml(t.browser)}</span>
          <span class="test-tag tag-${tagLabel.replace(/\s/g, '')}">${escapeHtml(tagLabel)}</span>
        </button>
        <div class="test-body${isFail || t.flaky ? '' : ' hidden'}">
          ${body}
        </div>
      </div>`;
    };

    const renderFeature = (fg: FeatureGroup, featIdx: number) => {
      const hasFail = fg.tests.some(
        (t) => t.status === 'failed' || t.status === 'timedOut' || t.status === 'interrupted',
      );
      const badges: string[] = [];
      if (fg.passed) badges.push(`<span class="badge-pill pass">${fg.passed} passed</span>`);
      if (fg.flaky) badges.push(`<span class="badge-pill flaky">${fg.flaky} flaky</span>`);
      if (fg.failed) badges.push(`<span class="badge-pill fail">${fg.failed} failed</span>`);
      if (fg.timedOut) badges.push(`<span class="badge-pill timeout">${fg.timedOut} timed out</span>`);
      if (fg.interrupted) badges.push(`<span class="badge-pill interrupt">${fg.interrupted} interrupted</span>`);
      if (fg.skipped) badges.push(`<span class="badge-pill skip">${fg.skipped} skipped</span>`);

      const testsHtml = fg.tests.map((t, i) => renderTest(t, i, featIdx)).join('');

      return `
      <div class="feature-group${hasFail ? ' open' : ''}" data-feat="${featIdx}" data-has-fail="${hasFail}">
        <button type="button" class="feature-header" aria-expanded="${hasFail ? 'true' : 'false'}">
          <span class="chevron">▶</span>
          <span class="feature-name">${escapeHtml(fg.name)}</span>
          <span class="feature-badges">${badges.join('')}</span>
        </button>
        <div class="feature-body${hasFail ? '' : ' hidden'}">
          ${testsHtml}
        </div>
      </div>`;
    };

    const featuresHtml = features.map((f, i) => renderFeature(f, i)).join('');

    const logoHtml = this.logoBase64DataUri
      ? `<!-- Logo: embedded as base64 data URI (self-contained; no separate logo file in report output) -->
      <div class="header-brand" aria-label="Skyward Specialty Insurance"><img class="brand-logo" src="${this.logoBase64DataUri}" alt="Skyward Specialty Insurance"/></div>`
      : '';

    const passBarColor =
      passPct >= 85 ? 'var(--pass)' : passPct >= 50 ? 'var(--timeout-warn)' : 'var(--fail)';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(this.reportTitle)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --page-bg: #eef2f8;
      --surface: #ffffff;
      --surface-soft: #f8f9fc;
      --border: #d9dfec;
      --brand: #1f179a;
      --brand-mid: #2b2ca8;
      --text: #1f2a44;
      --muted: #6d7895;
      --accent: #d9188a;
      --highlight: #f4e76b;
      --pass: #1d9f53;
      --fail: #c62828;
      --skip: #6d7895;
      --timeout-warn: #b8860b;
      --flaky: #7b68a6;
      --info: #1f179a;
      --pii-gap: #b8860b;
    }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Inter, system-ui, sans-serif;
    background: var(--page-bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100vh;
  }
  .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
  .report-hero {
    background: linear-gradient(110deg, var(--brand) 0%, var(--brand-mid) 62%, #f4f6fb 62.2%, #ffffff 100%);
    border-bottom: 1px solid var(--border);
    box-shadow: 0 6px 20px rgba(7, 13, 56, 0.12);
  }
  .report-hero-inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px 20px 22px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    flex-wrap: wrap;
  }
  .report-hero-text h1 {
    margin: 0 0 8px 0;
    font-size: clamp(1.1rem, 2.5vw, 1.65rem);
    font-weight: 700;
    letter-spacing: 0.4px;
    color: #ffffff;
    text-transform: uppercase;
    text-shadow: 0 1px 2px rgba(0,0,0,0.15);
    max-width: 36rem;
  }
  .timestamp { color: #e8ecff; font-size: 0.88rem; margin: 0; }
  .header-brand { flex-shrink: 0; margin-left: auto; }
  .brand-logo {
    display: block;
    max-height: 72px;
    max-width: min(300px, 40vw);
    width: auto;
    height: auto;
    object-fit: contain;
    background: rgba(255,255,255,0.96);
    border-radius: 8px;
    padding: 8px 12px;
    border: 1px solid rgba(12, 24, 82, 0.12);
  }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 20px 48px; }
  .section-title-row { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin: 8px 0 10px; font-weight: 700; }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 10px;
    margin-bottom: 16px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px;
    box-shadow: 0 3px 10px rgba(8, 16, 58, 0.06);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(8, 16, 58, 0.1); }
  .card-label { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 6px; }
  .card-val { font-size: 1.35rem; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
  .card-val.total { color: var(--brand); }
  .card-val.pass { color: var(--pass); }
  .card-val.fail { color: var(--fail); }
  .card-val.skip { color: var(--skip); }
  .card-val.timeout { color: var(--timeout-warn); }
  .card-val.intr { color: var(--muted); }
  .card-val.flaky { color: var(--flaky); }
  .card-val.status { color: var(--brand); }
  .exec-trend {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 16px;
    align-items: end;
    margin-bottom: 20px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    box-shadow: 0 3px 10px rgba(8, 16, 58, 0.06);
  }
  .pass-rate-block { min-width: 0; }
  .pass-rate-label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 6px; }
  .pass-rate-row { display: flex; align-items: center; gap: 12px; }
  .pass-rate-bar {
    flex: 1;
    height: 10px;
    border-radius: 999px;
    background: #e1e7f3;
    overflow: hidden;
  }
  .pass-rate-fill { height: 100%; border-radius: 999px; transition: width 0.2s; }
  .pass-rate-pct { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 1.1rem; min-width: 3.2rem; text-align: right; }
  .spark-wrap { text-align: right; }
  .spark-label { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 4px; }
  .spark-svg { display: block; vertical-align: bottom; }
  .governance-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
    margin-bottom: 20px;
    box-shadow: 0 3px 10px rgba(8, 16, 58, 0.06);
  }
  .gov-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px 16px;
    font-size: 0.82rem;
  }
  .gov-k { color: var(--muted); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; display: block; margin-bottom: 2px; }
  .gov-v { font-weight: 600; word-break: break-word; }
  .gov-v a { color: var(--brand); }
  .gate-no { color: var(--fail); font-weight: 800; }
  .gate-yes { color: var(--pass); font-weight: 800; }
  .pii-gap { color: var(--pii-gap); font-weight: 800; background: rgba(184,134,11,0.12); padding: 2px 6px; border-radius: 4px; }
  .cov-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 20px; align-items: center; }
  .cov-pill {
    font-size: 0.68rem; font-weight: 600; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border);
    transition: opacity 0.15s;
  }
  .cov-on { background: rgba(29,159,83,0.14); color: var(--pass); border-color: rgba(29,159,83,0.35); }
  .cov-off { opacity: 0.38; color: var(--muted); }
  .slowest-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    margin-bottom: 20px;
    box-shadow: 0 3px 10px rgba(8, 16, 58, 0.06);
  }
  .slow-row {
    display: grid;
    grid-template-columns: 1fr 2fr 4rem;
    gap: 10px;
    align-items: center;
    margin-bottom: 8px;
    font-size: 0.82rem;
  }
  .slow-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .slow-bar-wrap {
    height: 8px;
    background: #e1e7f3;
    border-radius: 999px;
    overflow: hidden;
  }
  .slow-bar { height: 100%; background: linear-gradient(90deg, var(--brand-mid), var(--accent)); border-radius: 999px; }
  .slow-dur { text-align: right; color: var(--muted); font-size: 0.8rem; }
  .progress-wrap { height: 8px; border-radius: 999px; overflow: hidden; background: #e1e7f3; margin-bottom: 16px; display: flex; }
  .progress-wrap span { height: 100%; transition: width 0.15s; }
  .progress-wrap .p { background: var(--pass); }
  .progress-wrap .f { background: var(--fail); }
  .progress-wrap .t { background: var(--timeout-warn); }
  .progress-wrap .i { background: #8892aa; }
  .progress-wrap .y { background: var(--flaky); }
  .progress-wrap .s { background: var(--skip); }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
  .filter-btn {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    padding: 8px 16px;
    border-radius: 999px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .filter-btn:hover { border-color: var(--brand); color: var(--brand); }
  .filter-btn.active {
    background: linear-gradient(135deg, var(--brand) 0%, var(--brand-mid) 100%);
    color: #ffffff;
    border-color: var(--brand);
    box-shadow: 0 2px 8px rgba(31, 23, 154, 0.25);
  }
  .feature-group {
    border: 1px solid var(--border);
    border-radius: 12px;
    margin-bottom: 12px;
    background: var(--surface);
    overflow: hidden;
    box-shadow: 0 3px 10px rgba(8, 16, 58, 0.06);
    border-left: 4px solid var(--highlight);
  }
  .feature-group.hidden { display: none; }
  .feature-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    background: linear-gradient(90deg, #f0f3fa 0%, #ffffff 100%);
    border: none;
    color: var(--text);
    font-size: 1rem;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s;
  }
  .feature-header:hover { background: linear-gradient(90deg, #e8ecf3 0%, #fafbfe 100%); }
  .feature-header .chevron {
    display: inline-block;
    transition: transform 0.15s;
    font-size: 0.7rem;
    color: var(--brand);
  }
  .feature-group.open .feature-header .chevron { transform: rotate(90deg); }
  .feature-name { flex: 1; color: var(--brand); }
  .feature-badges { display: flex; flex-wrap: wrap; gap: 6px; }
  .badge-pill { font-size: 0.7rem; padding: 0.2rem 0.5rem; border-radius: 6px; font-weight: 600; }
  .badge-pill.pass { background: rgba(29,159,83,0.12); color: var(--pass); border: 1px solid rgba(29,159,83,0.25); }
  .badge-pill.fail { background: rgba(198,40,40,0.1); color: var(--fail); border: 1px solid rgba(198,40,40,0.22); }
  .badge-pill.skip { background: rgba(109,120,149,0.12); color: var(--skip); border: 1px solid rgba(109,120,149,0.25); }
  .badge-pill.timeout { background: rgba(184,134,11,0.15); color: var(--timeout-warn); border: 1px solid rgba(184,134,11,0.35); }
  .badge-pill.interrupt { background: rgba(136,146,170,0.15); color: #5a6478; border: 1px solid rgba(136,146,170,0.35); }
  .badge-pill.flaky { background: rgba(123,104,166,0.14); color: var(--flaky); border: 1px solid rgba(123,104,166,0.3); }
  .feature-body { padding: 0 12px 12px; background: var(--surface-soft); }
  .feature-body.hidden { display: none; }
  .test-item { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; background: var(--surface); }
  .test-item.hidden { display: none; }
  .test-header {
    width: 100%;
    display: grid;
    grid-template-columns: auto auto 1fr auto auto auto auto;
    align-items: center;
    gap: 8px 10px;
    padding: 10px 12px;
    background: transparent;
    border: none;
    color: var(--text);
    font-size: 0.88rem;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s;
  }
  @media (max-width: 900px) {
    .test-header { grid-template-columns: auto auto 1fr; }
    .test-tags-inline { grid-column: 1 / -1; }
    .test-dur { justify-self: end; }
  }
  .test-header:hover { background: rgba(31, 23, 154, 0.04); }
  .test-header .chevron { transition: transform 0.15s; font-size: 0.65rem; color: var(--brand); grid-column: 1; }
  .test-item.open .test-header .chevron { transform: rotate(90deg); }
  .dot-pass, .dot-fail, .dot-skip, .dot-timeout, .dot-flaky {
    width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  }
  .dot-pass { background: var(--pass); box-shadow: 0 0 8px rgba(29,159,83,0.5); }
  .dot-fail { background: var(--fail); box-shadow: 0 0 8px rgba(198,40,40,0.45); }
  .dot-skip { background: var(--skip); box-shadow: 0 0 8px rgba(109,120,149,0.35); }
  .dot-timeout { background: var(--timeout-warn); box-shadow: 0 0 8px rgba(184,134,11,0.5); }
  .dot-flaky { background: var(--flaky); box-shadow: 0 0 8px rgba(123,104,166,0.45); }
  .test-title { min-width: 0; font-weight: 600; text-align: left; }
  .test-tags-inline { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; align-items: center; }
  .tag-chip {
    font-size: 0.6rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; border: 1px solid transparent;
  }
  .chip-serial { background: rgba(31,23,154,0.12); color: var(--brand); border-color: rgba(31,23,154,0.25); }
  .chip-area { background: rgba(29,159,83,0.1); color: #158a45; border-color: rgba(29,159,83,0.25); }
  .chip-meta { background: rgba(13,110,180,0.1); color: #0d6eb4; border-color: rgba(13,110,180,0.22); }
  .chip-role { background: rgba(217,24,138,0.1); color: #b01074; border-color: rgba(217,24,138,0.22); }
  .chip-h0 { background: rgba(90,100,120,0.12); color: #3d4558; }
  .chip-h1 { background: rgba(180,100,40,0.12); color: #a65c12; }
  .chip-h2 { background: rgba(40,130,100,0.12); color: #0d6b52; }
  .chip-h3 { background: rgba(130,60,160,0.12); color: #6b2d8a; }
  .chip-h4 { background: rgba(200,120,30,0.12); color: #a65c0a; }
  .chip-h5 { background: rgba(30,100,180,0.12); color: #0d5a9e; }
  .test-dur { color: var(--muted); font-size: 0.8rem; text-align: right; min-width: 4.5rem; }
  .test-browser { color: var(--muted); font-size: 0.72rem; max-width: 8rem; overflow: hidden; text-overflow: ellipsis; }
  .test-tag {
    font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 0.2rem 0.45rem; border-radius: 6px; font-weight: 700; white-space: nowrap;
  }
  .tag-passed { background: rgba(29,159,83,0.12); color: var(--pass); border: 1px solid rgba(29,159,83,0.28); }
  .tag-failed { background: rgba(198,40,40,0.12); color: var(--fail); border: 1px solid rgba(198,40,40,0.24); }
  .tag-timedout { background: rgba(184,134,11,0.18); color: var(--timeout-warn); border: 1px solid rgba(184,134,11,0.35); }
  .tag-interrupted { background: rgba(109,120,149,0.15); color: var(--skip); border: 1px solid rgba(109,120,149,0.28); }
  .tag-flaky { background: rgba(123,104,166,0.15); color: var(--flaky); border: 1px solid rgba(123,104,166,0.3); }
  .tag-skipped { background: rgba(109,120,149,0.12); color: var(--skip); border: 1px solid rgba(109,120,149,0.25); }
  .test-body { padding: 0 12px 14px; }
  .test-body.hidden { display: none; }
  .likely-cause {
    background: rgba(184,134,11,0.08);
    border: 1px solid rgba(184,134,11,0.28);
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 12px;
    font-size: 0.88rem;
  }
  .likely-label { font-weight: 800; color: var(--timeout-warn); margin-right: 6px; }
  .meta-box { border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px; background: var(--surface); }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
  .meta-grid > div { min-width: 0; }
  .meta-label { display: block; font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 4px; }
  .meta-val { display: block; font-size: 0.85rem; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
  .breadcrumb { font-size: 0.8rem; color: var(--muted); margin-bottom: 14px; word-break: break-word; }
  .section { margin-bottom: 14px; }
  .section-title { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 8px; color: var(--text); }
  .icon { width: 18px; height: 18px; }
  .screenshot-wrap { max-width: 420px; }
  .screenshot-img { max-width: 100%; border-radius: 8px; border: 1px solid var(--border); cursor: zoom-in; }
  .error-box { background: rgba(198,40,40,0.06); border: 1px solid rgba(198,40,40,0.24); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .error-title { font-weight: 600; color: var(--fail); margin-bottom: 8px; }
  .error-pre { margin: 0; max-height: 300px; overflow: auto; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; color: var(--text); }
  .assert-box { background: rgba(184,134,11,0.06); border: 1px solid rgba(184,134,11,0.22); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .assert-title { font-weight: 600; color: var(--timeout-warn); margin-bottom: 8px; }
  .assert-pre { margin: 0; font-size: 0.8rem; white-space: pre-wrap; color: var(--text); }
  .attach-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .link-pill {
    display: inline-flex; align-items: center; gap: 6px;
    background: rgba(31, 23, 154, 0.08); color: var(--brand);
    border: 1px solid rgba(31, 23, 154, 0.25); padding: 8px 14px; border-radius: 999px;
    font-size: 0.85rem; font-weight: 600; text-decoration: none;
    transition: background 0.15s;
  }
  .link-pill:hover { background: rgba(31, 23, 154, 0.14); }
  #lightbox {
    display: none; position: fixed; inset: 0; z-index: 9999;
    background: rgba(10,14,46,0.94); align-items: center; justify-content: center; cursor: zoom-out;
  }
  #lightbox.open { display: flex; }
  #lightbox img { max-width: 90vw; max-height: 90vh; object-fit: contain; border: 2px solid #ffffff; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="report-hero">
    <div class="report-hero-inner">
      <div class="report-hero-text">
        <h1>${escapeHtml(this.reportTitle)}</h1>
        <p class="timestamp">${escapeHtml(ts)}</p>
      </div>
      ${logoHtml}
    </div>
  </div>
  <div class="wrap">
    <div class="section-title-row">Execution summary</div>
    <div class="summary-grid">
      <div class="card"><div class="card-label">Total</div><div class="card-val mono total">${total}</div></div>
      <div class="card"><div class="card-label">Passed</div><div class="card-val mono pass">${passed}</div></div>
      <div class="card"><div class="card-label">Failed</div><div class="card-val mono fail">${failed}</div></div>
      <div class="card"><div class="card-label">Timed out</div><div class="card-val mono timeout">${tOut}</div></div>
      <div class="card"><div class="card-label">Skipped</div><div class="card-val mono skip">${skipped}</div></div>
      <div class="card"><div class="card-label">Interrupted</div><div class="card-val mono intr">${intr}</div></div>
      <div class="card"><div class="card-label">Flaky</div><div class="card-val mono flaky">${flaky}</div></div>
      <div class="card"><div class="card-label">Run status</div><div class="card-val mono status">${escapeHtml(status)}</div></div>
    </div>
    <div class="exec-trend">
      <div class="pass-rate-block">
        <div class="pass-rate-label">Pass rate this run</div>
        <div class="pass-rate-row">
          <div class="pass-rate-bar"><div class="pass-rate-fill" style="width:${passPct}%; background:${passBarColor}"></div></div>
          <div class="pass-rate-pct" style="color:${passBarColor}">${passPct}%</div>
        </div>
      </div>
      <div class="spark-wrap">
        <div class="spark-label">Last ${history.length} runs</div>
        <svg class="spark-svg" width="${sparkW}" height="${sparkH}" viewBox="0 0 ${sparkW} ${sparkH}" aria-label="Pass rate trend">${sparkBars}</svg>
      </div>
    </div>
    <div class="progress-wrap" title="Mix of outcomes (executed tests)">
      <span class="p" style="width:${wPass}%"></span>
      <span class="y" style="width:${wFlaky}%"></span>
      <span class="f" style="width:${wFail}%"></span>
      <span class="t" style="width:${wTime}%"></span>
      <span class="i" style="width:${wIntr}%"></span>
      <span class="s" style="width:${wSkipBar}%"></span>
    </div>

    <div class="section-title-row">Environment &amp; governance</div>
    <div class="governance-panel">
      <div class="gov-grid">
        <div><span class="gov-k">Tested by</span><span class="gov-v">${escapeHtml(testedBy)}</span></div>
        <div><span class="gov-k">Base URL</span><span class="gov-v">${baseURL ? `<a href="${escapeHtml(baseURL)}" target="_blank" rel="noreferrer">${escapeHtml(baseURL.length > 48 ? baseURL.slice(0, 46) + '…' : baseURL)}</a>` : '—'}</span></div>
        <div><span class="gov-k">Project(s)</span><span class="gov-v">${escapeHtml(projectsLine || '—')}</span></div>
        <div><span class="gov-k">Node</span><span class="gov-v mono">${escapeHtml(nodeVer)}</span></div>
        <div><span class="gov-k">OS</span><span class="gov-v">${escapeHtml(osName)}</span></div>
        <div><span class="gov-k">Duration</span><span class="gov-v mono">${durationSec.toFixed(1)}s</span></div>
        <div><span class="gov-k">Release gate</span><span class="gov-v ${gateBad ? 'gate-no' : 'gate-yes'}">${escapeHtml(releaseGate)}</span></div>
        <div><span class="gov-k">Data classification</span><span class="gov-v">${escapeHtml(gov.dataClass)}</span></div>
        <div><span class="gov-k">PII masking</span><span class="gov-v ${piiGap ? 'pii-gap' : ''}">${escapeHtml(gov.pii)}</span></div>
        <div><span class="gov-k">BU</span><span class="gov-v">${escapeHtml(gov.bu)}</span></div>
        <div><span class="gov-k">Sprint / release</span><span class="gov-v">${gov.releaseTag ? escapeHtml(gov.releaseTag) : '<em>— not set —</em>'}</span></div>
      </div>
    </div>

    <div class="section-title-row">Module coverage (this run)</div>
    <div class="cov-strip">${coveragePills}</div>

    <div class="section-title-row">Slowest tests</div>
    <div class="slowest-panel">${slowRows || '<p class="gov-v" style="margin:0;color:var(--muted)">No tests recorded.</p>'}</div>

    <div class="filters">
      <button type="button" class="filter-btn active" data-filter="all">All</button>
      <button type="button" class="filter-btn" data-filter="passed">Passed</button>
      <button type="button" class="filter-btn" data-filter="failed">Failed</button>
      <button type="button" class="filter-btn" data-filter="timedOut">Timed out</button>
      <button type="button" class="filter-btn" data-filter="interrupted">Interrupted</button>
      <button type="button" class="filter-btn" data-filter="flaky">Flaky</button>
      <button type="button" class="filter-btn" data-filter="skipped">Skipped</button>
    </div>
    <div id="features">${featuresHtml}</div>
  </div>
  <div id="lightbox" aria-hidden="true"><img alt="" id="lightbox-img"/></div>
  <script>
(function() {
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function toggleSection(el, isOpen) {
    el.classList.toggle('open', isOpen);
    var body = el.querySelector('.feature-body, .test-body');
    if (body) body.classList.toggle('hidden', !isOpen);
    var btn = el.querySelector('.feature-header, .test-header');
    if (btn) btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }
  qsa('.feature-group').forEach(function(fg) {
    var hdr = fg.querySelector('.feature-header');
    if (!hdr) return;
    var open = fg.classList.contains('open');
    toggleSection(fg, open);
    hdr.addEventListener('click', function() {
      toggleSection(fg, !fg.classList.contains('open'));
    });
  });
  qsa('.test-item').forEach(function(ti) {
    var hdr = ti.querySelector('.test-header');
    if (!hdr) return;
    var open = ti.classList.contains('open');
    toggleSection(ti, open);
    hdr.addEventListener('click', function() {
      toggleSection(ti, !ti.classList.contains('open'));
    });
  });
  document.getElementById('features').addEventListener('click', function(ev) {
    var t = ev.target;
    if (t && t.classList && t.classList.contains('screenshot-img')) {
      var lb = document.getElementById('lightbox');
      var img = document.getElementById('lightbox-img');
      img.src = t.getAttribute('src');
      lb.classList.add('open');
      lb.setAttribute('aria-hidden', 'false');
    }
  });
  document.getElementById('lightbox').addEventListener('click', function() {
    this.classList.remove('open');
    this.setAttribute('aria-hidden', 'true');
    document.getElementById('lightbox-img').src = '';
  });
  function applyFilter(mode) {
    qsa('.filter-btn').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-filter') === mode);
    });
    qsa('.test-item').forEach(function(ti) {
      var st = ti.getAttribute('data-status');
      var show = mode === 'all' ||
        (mode === 'passed' && st === 'passed') ||
        (mode === 'failed' && st === 'failed') ||
        (mode === 'timedOut' && st === 'timedOut') ||
        (mode === 'interrupted' && st === 'interrupted') ||
        (mode === 'flaky' && st === 'flaky') ||
        (mode === 'skipped' && st === 'skipped');
      ti.classList.toggle('hidden', !show);
    });
    qsa('.feature-group').forEach(function(fg) {
      var visible = qsa('.test-item', fg).filter(function(ti) { return !ti.classList.contains('hidden'); }).length;
      fg.classList.toggle('hidden', visible === 0);
    });
  }
  qsa('.filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      applyFilter(btn.getAttribute('data-filter') || 'all');
    });
  });
})();
  </script>
</body>
</html>`;
  }
}
