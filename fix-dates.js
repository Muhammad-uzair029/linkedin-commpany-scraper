#!/usr/bin/env node
/**
 * fix-dates.js — sequential profile enricher
 *
 * Visits each profile one-by-one, scrolls until the Experience section is visible,
 * then searches for Present (with dash) / Full-time. Falls back to whole-page
 * search (like Ctrl+F) if the section-scoped search finds no dates.
 *
 * Usage:
 *   node fix-dates.js output/linkedin_people_live_*.json
 *   node fix-dates.js <file.json> --parallel-tabs 8 --force
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import * as logger from './utils/logger.js';
import {
  applyPresentExperienceToPerson,
  detectSessionWall,
  launchLinkedInBrowser,
  preparePage,
  scrapePresentExperienceFromPage,
  guardProfileNavigation,
  scrollToExperienceSection,
} from './scraper.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;


function parseArgs(argv) {
  /** @type {{ file?: string, parallelTabs?: number, headed?: boolean, useProfile?: boolean, force?: boolean, startFrom?: number }} */
  const out = { useProfile: true, parallelTabs: 8, force: false };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--parallel-tabs') out.parallelTabs = Number(argv[++i]);
    else if (a === '--start-from') out.startFrom = Number(argv[++i]);
    else if (a === '--headed') out.headed = true;
    else if (a === '--no-profile') out.useProfile = false;
    else if (a === '--force') out.force = true;
    else if (!a.startsWith('--')) positional.push(a);
  }
  out.file = positional[0];
  return out;
}

/**
 * @typedef {{
 *   name?: string,
 *   fullName?: string,
 *   profileUrl: string,
 *   title?: string | null,
 *   about?: string | null,
 *   experiences?: Array<{ title?: string|null, company?: string|null, dates?: string|null, location?: string|null, description?: string|null }>,
 *   motiveExperience?: any,
 *   profileEnriched?: boolean,
 *   [k: string]: any
 * }} Record
 */

/**
 * @param {string} jsonPath
 * @returns {{ records: Record[], envelope: any }}
 */
function loadRecords(jsonPath) {
  if (!existsSync(jsonPath)) {
    throw new Error(`File not found: ${jsonPath}`);
  }
  const raw = readFileSync(jsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return { records: parsed, envelope: null };
  }
  if (parsed && Array.isArray(parsed.people)) {
    return { records: parsed.people, envelope: parsed };
  }
  throw new Error('Unrecognized JSON shape: expected an array or { people: [...] }');
}

function persist(jsonPath, jsonlPath, records, envelope) {
  const tmpJson = `${jsonPath}.tmp`;
  const enrichedCount = records.filter((r) => r.experiences?.[0]?.dates).length;
  /** @type {any} */
  let payload;
  if (envelope) {
    payload = { ...envelope, people: records };
    if (payload.metadata) {
      payload.metadata = {
        ...payload.metadata,
        updatedAt: new Date().toISOString(),
        totalUniquePeople: records.length,
        enrichedCount: records.filter((p) => p.profileEnriched).length,
        withDates: enrichedCount,
      };
    }
  } else {
    payload = records;
  }
  writeFileSync(tmpJson, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmpJson, jsonPath);

  if (jsonlPath) {
    const tmpJsonl = `${jsonlPath}.tmp`;
    const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(tmpJsonl, body, 'utf8');
    renameSync(tmpJsonl, jsonlPath);
  }

  const csvPath = jsonPath.replace(/\.json$/i, '.csv');
  if (existsSync(csvPath)) {
    const escapeCsv = (s) => {
      const v = String(s ?? '');
      return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const header =
      'fullName,title,about,profileUrl,motiveExperience,connectionDegree,experiences,company1,company2,company3,profileEnriched';
    const rows = records.map((p) =>
      [
        escapeCsv(p.fullName ?? p.name ?? ''),
        escapeCsv(p.title ?? ''),
        escapeCsv(p.about ?? ''),
        escapeCsv(p.profileUrl ?? ''),
        escapeCsv(JSON.stringify(p.motiveExperience ?? null)),
        escapeCsv(p.connectionDegree ?? ''),
        escapeCsv(JSON.stringify(p.experiences ?? [])),
        escapeCsv(p.company1 ?? ''),
        escapeCsv(p.company2 ?? ''),
        escapeCsv(p.company3 ?? ''),
        escapeCsv(String(!!p.profileEnriched)),
      ].join(','),
    );
    writeFileSync(csvPath, [header, ...rows].join('\n') + '\n', 'utf8');
  }
}

/**
 * @param {import('puppeteer').Page} page
 * @param {Record} person
 */
async function fixOne(page, person) {
  guardProfileNavigation(page, person.profileUrl);

  await page.goto(person.profileUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs,
  });
  await page.waitForSelector('main, h1', { timeout: 12_000 }).catch(() => {});
  await sleep(config.profileLoadWaitMs);

  if (await detectSessionWall(page)) {
    throw new Error('SESSION_WALL');
  }

  if (/feed\/update|urn:li:activity/i.test(page.url())) {
    await page.goto(person.profileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.navigationTimeoutMs,
    });
    await sleep(config.profileLoadWaitMs);
  }

  const atExperience = await scrollToExperienceSection(page);
  if (!atExperience) {
    logger.warn('Experience section not fully visible; extracting anyway', {
      profile: person.profileUrl,
    });
  }

  return scrapePresentExperienceFromPage(page, { skipScroll: true });
}

/**
 * @param {Record[]} records
 * @param {{ parallelTabs?: number, headed?: boolean, useProfile?: boolean, force?: boolean, jsonPath: string, jsonlPath: string, envelope?: any }} opts
 */
async function run(records, opts) {
  const parallelTabs = Math.min(
    Math.max(opts.parallelTabs ?? 1, 1),
    config.parallelTabsMax ?? 15,
  );

  const startOffset =
    opts.startFrom && opts.startFrom > 1 ? Math.min(opts.startFrom - 1, records.length) : 0;
  const recordPool = startOffset > 0 ? records.slice(startOffset) : records;

  const candidates = recordPool
    .map((r, i) => ({ idx: startOffset + i, r }))
    .filter(({ r }) => {
      if (!r.profileUrl) return false;
      if (opts.force) return true;
      const first = r.experiences?.[0];
      if (!first) return true;
      return !first.dates;
    });

  const resumeName =
    startOffset > 0
      ? records[startOffset]?.fullName || records[startOffset]?.name || records[startOffset]?.profileUrl
      : null;

  logger.info('fix-dates: starting parallel enrichment', {
    total: records.length,
    startFrom: opts.startFrom ?? 1,
    resumeAt: resumeName,
    toProcess: candidates.length,
    parallelTabs,
    headless: !opts.headed,
    profileLoadWaitMs: config.profileLoadWaitMs,
    force: opts.force,
  });

  if (!candidates.length) return;

  const headless = !opts.headed;
  const browser = await launchLinkedInBrowser(headless, { useProfile: opts.useProfile });
  /** @type {Array<{ page: import('puppeteer').Page }>} */
  const tabs = [];
  for (let i = 0; i < parallelTabs; i += 1) {
    const page = await browser.newPage();
    await preparePage(page);
    tabs.push({ page });
    if (i > 0) {
      await sleep(randomBetween(config.parallelTabStaggerMs / 2, config.parallelTabStaggerMs));
    }
  }

  let cursor = 0;
  let updated = 0;
  let skipped = 0;
  let saveTimer = null;
  const persistAll = () => persist(opts.jsonPath, opts.jsonlPath, records, opts.envelope);
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        persistAll();
      } catch (e) {
        logger.warn('fix-dates: persist failed', { message: e?.message });
      }
    }, 800);
  };

  const reopenTab = async (tabIdx) => {
    try {
      await tabs[tabIdx].page?.close().catch(() => {});
    } catch {
      /* ignore */
    }
    tabs[tabIdx].page = await browser.newPage();
    await preparePage(tabs[tabIdx].page);
  };

  /** @param {number} tabIdx */
  const worker = async (tabIdx) => {
    while (true) {
      const myIdx = cursor++;
      if (myIdx >= candidates.length) break;
      const { idx, r } = candidates[myIdx];
      const label = `${idx + 1}/${records.length} ${r.fullName || r.name || r.profileUrl}`;
      try {
        const found = await fixOne(tabs[tabIdx].page, r);
        const hasValidDates =
          found?.dates && /\bpresent\b/i.test(found.dates) && /[-–]/.test(found.dates);
        if (hasValidDates || found?.title || found?.employmentType) {
          applyPresentExperienceToPerson(r, found);
          updated += 1;
          logger.info(
            `[${label}] title="${found.title ?? ''}" dates="${found.dates ?? ''}" type="${found.employmentType ?? ''}"`,
          );
        } else {
          skipped += 1;
          logger.info(`[${label}] no Present (with dash) / Full-time experience found`);
        }
        scheduleSave();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'SESSION_WALL') {
          logger.error('Session wall hit. Run `npm run login` and re-run.');
          throw err;
        }
        skipped += 1;
        logger.warn(`[${label}] failed: ${message}`);
        if (/detached frame|target closed|context.*destroyed|connection closed/i.test(message)) {
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              await reopenTab(tabIdx);
              break;
            } catch (e) {
              logger.warn(`tab ${tabIdx + 1} reopen attempt ${attempt}/3 failed`, {
                message: e instanceof Error ? e.message : String(e),
              });
              await sleep(randomBetween(2000, 4000));
            }
          }
        }
      }
      await sleep(randomBetween(config.profileDelayMinMs, config.profileDelayMaxMs));
    }
  };

  try {
    await Promise.all(tabs.map((_, i) => worker(i)));
  } finally {
    if (saveTimer) clearTimeout(saveTimer);
    try {
      persistAll();
    } catch (e) {
      logger.warn('fix-dates: final persist failed', { message: e?.message });
    }
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }

  logger.info('fix-dates: done', {
    updated,
    skipped,
    withDates: records.filter((r) => r.experiences?.[0]?.dates).length,
    remainingMissing: records.filter((r) => !r.experiences?.[0]?.dates).length,
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error(
      'Usage: node fix-dates.js <path-to-linkedin_people_live_*.json> [--parallel-tabs 8] [--start-from 90] [--force] [--headed]',
    );
    process.exit(2);
  }
  const jsonPath = path.resolve(args.file);
  const jsonlPath = jsonPath.replace(/\.json$/i, '.jsonl');

  const { records, envelope } = loadRecords(jsonPath);
  logger.info('fix-dates: loaded', {
    jsonPath,
    jsonlPath: existsSync(jsonlPath) ? jsonlPath : '(missing — will be skipped)',
    total: records.length,
    shape: envelope ? '{metadata, people}' : 'array',
    force: args.force,
  });

  try {
    await run(records, {
      parallelTabs: args.parallelTabs,
      headed: args.headed,
      useProfile: args.useProfile,
      force: args.force,
      startFrom: args.startFrom,
      jsonPath,
      jsonlPath: existsSync(jsonlPath) ? jsonlPath : '',
      envelope,
    });
  } catch (err) {
    logger.error('fix-dates: aborted', {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

main();
