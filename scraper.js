import { existsSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { config, profileDir } from './config.js';
import * as logger from './utils/logger.js';
import {
  baseNameFromOutputPath,
  createIncrementalWriter,
} from './utils/fileHandler.js';

/**
 * Read a JSONL output file from a previous run and return the parsed people.
 * @param {string} jsonlPath
 * @returns {Promise<PersonRecord[]>}
 */
export async function loadPeopleFromJsonl(jsonlPath) {
  const content = await fs.readFile(jsonlPath, 'utf8');
  /** @type {PersonRecord[]} */
  const out = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip bad lines */
    }
  }
  return out;
}

export class SessionWallError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SessionWallError';
  }
}

export class NavigationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'NavigationError';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

const HTTP_ONLY_COOKIE_NAMES = new Set([
  'li_at',
  'JSESSIONID',
  'bcookie',
  'bscookie',
  'li_rm',
  'liap',
  'lidc',
  'fptctx2',
]);

/**
 * Prefer bundled Chrome-for-Testing; fall back to a system Chrome install.
 * @param {boolean} headless
 * @param {{ userDataDir?: string }} [launchExtras]
 */
export function getPuppeteerLaunchOptions(headless, launchExtras = {}) {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    ...config.extraLaunchArgs(),
  ];
  /** @type {import('puppeteer').LaunchOptions} */
  const base = { headless: headless ? true : false, args, ...launchExtras };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return { ...base, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH };
  }

  let bundled = '';
  try {
    bundled = puppeteer.executablePath();
  } catch {
    /* no pinned revision */
  }
  if (bundled && existsSync(bundled)) {
    return { ...base, executablePath: bundled };
  }

  logger.info(
    'Using system Google Chrome (Chrome-for-Testing not in Puppeteer cache). Optional: npx puppeteer browsers install chrome',
  );
  return { ...base, channel: 'chrome' };
}

/** Remove stale Chrome singleton locks so a new scrape can start. */
function clearProfileLocks() {
  for (const file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(profileDir, file);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        /* another Chrome instance may still be running */
      }
    }
  }
}

/**
 * @param {boolean} headless
 * @param {{ useProfile?: boolean }} [options]
 */
export async function launchLinkedInBrowser(headless, options = {}) {
  if (options.useProfile) clearProfileLocks();
  const launchExtras = options.useProfile ? { userDataDir: profileDir } : {};
  return puppeteer.launch(getPuppeteerLaunchOptions(headless, launchExtras));
}

/**
 * @param {import('puppeteer').Page} page
 */
export async function preparePage(page) {
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  if (!config.blockMedia) return;

  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();
      if (
        type === 'image' ||
        type === 'media' ||
        type === 'font' ||
        /\.(jpg|jpeg|png|gif|webp|svg|ico|mp4|webm|woff2?|ttf|otf)(\?|$)/i.test(url) ||
        /(google-analytics|googletagmanager|doubleclick|hotjar|segment|fullstory|datadoghq)/i.test(
          url,
        )
      ) {
        req.abort().catch(() => {});
        return;
      }
      req.continue().catch(() => {});
    });
  } catch {
    /* request interception may already be set */
  }
}

/** LinkedIn profile DOM selectors (Experience + Motive). */
export const LINKEDIN_SELECTORS = {
  main: 'main',
  profileName: 'h1.text-heading-xlarge, main h1, h1',
  experienceAnchor: '#experience',
  experienceHeading: 'h2',
  experienceSection: '#experience, [data-testid*="ExperienceTopLevelSection"], [data-testid*="Experience"]',
  experienceShowAll:
    'button[aria-label*="Show all" i], button[aria-label*="experience" i], [role="button"]',
  motiveLogo:
    'img[alt*="Motive" i], img[src*="motive_inc_logo" i], img[src*="motive" i], svg[aria-label*="Motive" i]',
  motiveCompanyLink:
    'a[href*="/company/3271606"], a[href*="/company/motive-inc"], a[href*="/company/keeptruckin"]',
  experienceCard:
    '[componentkey*="entity-collection-item"], li.pvs-list__paged-list-item, .pvs-entity, li.artdeco-list__item',
  textLine: 'p, span[aria-hidden="true"]',
};

export async function humanDelay() {
  await sleep(randomBetween(config.minDelayMs, config.maxDelayMs));
}

/**
 * Parse Cookie header or raw "a=b; c=d" / single pair string into Puppeteer cookie objects.
 * @param {string} cookieStr
 * @returns {import('puppeteer').CookieParam[]}
 */
export function parseCookieString(cookieStr) {
  const trimmed = cookieStr.trim();
  if (!trimmed) return [];

  // Bare token pasted without "li_at=" — treat whole string as li_at value.
  if (!trimmed.includes('=')) {
    return [
      {
        name: 'li_at',
        value: trimmed,
        domain: '.linkedin.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ];
  }

  const segments = trimmed.includes(';')
    ? trimmed.split(';').map((s) => s.trim()).filter(Boolean)
    : [trimmed];

  /** @type {import('puppeteer').CookieParam[]} */
  const out = [];

  for (const seg of segments) {
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    const value = seg.slice(eq + 1).trim();
    if (!name) continue;

    out.push({
      name,
      value,
      domain: '.linkedin.com',
      path: '/',
      secure: true,
      httpOnly: HTTP_ONLY_COOKIE_NAMES.has(name),
      sameSite: 'Lax',
    });
  }

  return out;
}

/**
 * Cookie-based login: land on linkedin.com, set cookies, warm up on /feed/.
 * @param {import('puppeteer').Page} page
 * @param {string} cookieStr
 */
export async function authenticate(page, cookieStr) {
  const cookies = parseCookieString(cookieStr);
  if (!cookies.length) {
    throw new Error(
      'No cookie pairs parsed. Use li_at=...; JSESSIONID=... (copy full Cookie header from DevTools), or run: npm run login',
    );
  }

  await page.goto('https://www.linkedin.com/', {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs,
  });
  await page.setCookie(...cookies);
  await page.goto('https://www.linkedin.com/feed/', {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs,
  });
  await sleep(randomBetween(1500, 2500));
}

/**
 * Profile-based session: reuse saved Chrome login (no pasted li_at).
 * @param {import('puppeteer').Page} page
 */
export async function authenticateWithProfile(page) {
  await page.goto('https://www.linkedin.com/feed/', {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs,
  });
  await sleep(randomBetween(1000, 2000));
  if (await detectSessionWall(page)) {
    throw new SessionWallError(
      'Not logged in in the saved browser profile. Run: npm run login — sign in once in that window, then scrape again.',
    );
  }
}

/**
 * @param {string} href
 * @returns {string | null}
 */
export function normalizeProfileUrl(href) {
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('linkedin.com')) return null;

    let pathname = u.pathname.replace(/\/+$/, '') || '/';
    const m = pathname.match(/^\/in\/([^/]+)$/i);
    if (!m) return null;
    const slug = m[1];
    if (!slug || slug.toLowerCase() === 'unavailable') return null;

    return `https://www.linkedin.com/in/${slug}/`;
  } catch {
    return null;
  }
}

/** @param {string} url */
export function isValidProfileUrl(url) {
  return /^https:\/\/(www\.)?linkedin\.com\/in\/[^/]+\/?$/i.test(url);
}

/** Stable map key (pathname) — matches mergePeopleRows during listing. */
/** @param {string} profileUrl */
export function personMapKey(profileUrl) {
  try {
    const pathname = new URL(profileUrl).pathname.replace(/\/+$/, '').toLowerCase();
    return pathname || profileUrl.toLowerCase();
  } catch {
    return profileUrl.toLowerCase();
  }
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} url
 */
export async function navigateToUrl(page, url) {
  let lastErr = /** @type {Error | null} */ (null);
  for (let attempt = 1; attempt <= config.navigationRetries; attempt++) {
    try {
      await page.goto(url, {
        waitUntil: config.waitUntil,
        timeout: config.navigationTimeoutMs,
      });
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      logger.warn(`Navigation attempt ${attempt}/${config.navigationRetries} failed`, {
        message: lastErr.message,
      });
      if (attempt < config.navigationRetries) {
        await sleep(config.navigationBackoffMs * attempt);
      }
    }
  }
  throw new NavigationError(
    lastErr ? `Failed to load page after retries: ${lastErr.message}` : 'Failed to load page after retries',
  );
}

/**
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
/**
 * Wait until the LinkedIn profile page has finished loading (name visible, main content ready).
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if loaded within timeout
 */
export async function waitForProfileLoaded(page) {
  await page
    .waitForSelector(LINKEDIN_SELECTORS.profileName, { timeout: 20_000 })
    .catch(() => {});
  await page.waitForSelector(LINKEDIN_SELECTORS.main, { timeout: 15_000 }).catch(() => {});

  const deadline = Date.now() + 35_000;
  let stablePasses = 0;

  while (Date.now() < deadline) {
    const state = await page.evaluate((profileNameSel) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const onProfile = /linkedin\.com\/in\//i.test(window.location.href);
      const h1 =
        document.querySelector(profileNameSel) ||
        document.querySelector('main h1') ||
        document.querySelector('h1');
      const name = norm(h1?.innerText || h1?.textContent || '');
      const hasName =
        name.length >= 2 &&
        name.length < 140 &&
        !/^linkedin$/i.test(name) &&
        !/sign in/i.test(name);

      const main = document.querySelector('main');
      const mainText = norm(main?.innerText || '').slice(0, 500);
      const mainHasContent = mainText.length > 80;

      const hasSkeleton = !!document.querySelector(
        '.skeleton, .artdeco-skeleton, [class*="skeleton"], [class*="Skeleton"], [aria-busy="true"]',
      );

      const spinner = !!document.querySelector(
        '.artdeco-loader, [data-test-loader], .pv-profile-section__loader',
      );

      return {
        onProfile,
        hasName,
        mainHasContent,
        busy: hasSkeleton || spinner,
      };
    }, LINKEDIN_SELECTORS.profileName);

    if (state.onProfile && state.hasName && state.mainHasContent && !state.busy) {
      stablePasses += 1;
      if (stablePasses >= 1) {
        await sleep(randomBetween(2000, 3500));
        return true;
      }
    } else {
      stablePasses = 0;
    }

    await sleep(randomBetween(700, 1100));
  }

  logger.warn('waitForProfileLoaded: timed out, scrolling anyway');
  await sleep(randomBetween(2000, 3000));
  return false;
}

export async function detectSessionWall(page) {
  const current = page.url();
  if (/linkedin\.com\/(login|u\/login|checkpoint|authwall)/i.test(current)) {
    return true;
  }

  return page.evaluate(() => {
    const pwd = document.querySelector('input[type="password"], input#password');
    const title = document.title || '';
    if (/sign in to linkedin/i.test(title) && pwd) return true;
    if (document.querySelector('[data-id="sign-in-form"]')) return true;
    if (document.querySelector('form[action*="checkpoint"]')) return true;
    return false;
  });
}

/**
 * @typedef {object} RawPersonRow
 * @property {string} href
 * @property {string} name
 * @property {string | null} connectionDegree
 * @property {string | null} company1
 * @property {string | null} company2
 * @property {string | null} company3
 * @property {string | null} about
 */

/**
 * Raw rows from DOM (href may be relative). Includes degree, up to 3 company names from card links, and headline/about text when visible.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<RawPersonRow[]>}
 */
export async function extractPeopleData(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    /** @type {RawPersonRow[]} */
    const rows = [];
    const anchors = document.querySelectorAll('a[href*="/in/"]');
    const seenHref = new Set();

    anchors.forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!href || href.includes('/in/unavailable')) return;
      if (seenHref.has(href)) return;
      seenHref.add(href);

      let name = (
        a.getAttribute('aria-label') ||
        a.getAttribute('title') ||
        ''
      ).trim();

      const card =
        a.closest('li') ||
        a.closest('article') ||
        a.closest('[data-chameleon-result-urn]');

      let bounded = card;
      if (!bounded) {
        let el = a.parentElement;
        for (let depth = 0; depth < 8 && el; depth += 1, el = el.parentElement) {
          const t = norm(el.innerText || '');
          if (t.length > 40 && t.length < 3500) {
            bounded = el;
            break;
          }
        }
      }

      if (!name && bounded) {
        const strong = bounded.querySelector('strong');
        if (strong) name = norm(strong.textContent || '');
      }

      if (!name) {
        name = norm(a.textContent || '');
      }

      const root = bounded || a.parentElement || document.body;
      const blockText = root.innerText || '';

      let connectionDegree = null;
      const degMatch = blockText.match(/\b(1st|2nd|3rd\+?)\b/i);
      if (degMatch) connectionDegree = degMatch[1];

      const companySeen = new Set();
      /** @type {string[]} */
      const companies = [];
      root.querySelectorAll('a[href*="/company/"]').forEach((link) => {
        const cn = norm(link.innerText || link.getAttribute('aria-label') || '');
        if (cn.length < 2 || cn.length > 160) return;
        if (/view all employees|see all/i.test(cn)) return;
        const key = cn.toLowerCase();
        if (companySeen.has(key)) return;
        companySeen.add(key);
        companies.push(cn);
      });

      const company1 = companies[0] || null;
      const company2 = companies[1] || null;
      const company3 = companies[2] || null;

      const rawLines = blockText.split(/\n+/).map(norm).filter(Boolean);
      const skipLine = (l) => {
        if (!l) return true;
        if (/^provides services\b/i.test(l)) return true;
        if (/^(1st|2nd|3rd\+?)$/i.test(l)) return true;
        if (/^(connect|follow|message)$/i.test(l)) return true;
        if (/mutual connection/i.test(l)) return true;
        if (/^see your mutual connections$/i.test(l)) return true;
        if (/^following$/i.test(l)) return true;
        return false;
      };
      const candidates = rawLines.filter((l) => !skipLine(l));

      // LinkedIn often puts "Provides services - …" on the link; real name is another line on the card.
      if (/^provides services\b/i.test(name) || !name || name.length > 120) {
        const personName = candidates.find(
          (l) =>
            l.length >= 3 &&
            l.length <= 80 &&
            !/@/.test(l) &&
            !/\|/.test(l) &&
            !/^(sales|account|business|senior|manager|director|development)/i.test(l),
        );
        name = personName || candidates.find((l) => l.length <= 80) || 'Pending profile';
      }

      const skipLineAfterName = (l) => {
        if (!l || l === name) return true;
        return skipLine(l);
      };
      const candidatesForAbout = rawLines.filter((l) => !skipLineAfterName(l));
      let about = candidatesForAbout.find((l) => l.length > 15) || null;
      if (!about && candidatesForAbout.length) {
        about = candidatesForAbout.slice(0, 4).join(' — ');
      }
      if (about && about.length > 800) {
        about = about.slice(0, 800);
      }

      rows.push({
        href,
        name,
        connectionDegree,
        company1,
        company2,
        company3,
        about,
      });
    });

    return rows;
  });
}

/** @param {import('puppeteer').Page} page */
export async function scrapeInitialPage(page) {
  return extractPeopleData(page);
}

/**
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if a button was clicked
 */
export async function clickShowMore(page) {
  await humanDelay();
  let clicked = false;
  try {
    clicked = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      /** LinkedIn company People tab uses a pill like "Show more results". */
      const matchesShowMore = (el) => {
        const t = norm(el.innerText || el.textContent);
        const aria = norm(el.getAttribute('aria-label'));
        return (
          /show\s+more(\s+results)?/i.test(t) ||
          /show\s+more(\s+results)?/i.test(aria)
        );
      };

      const candidates = [
        ...document.querySelectorAll('button, [role="button"]'),
      ];
      const target = candidates.find((el) => matchesShowMore(el));
      if (target) {
        const disabled =
          target.getAttribute('disabled') != null ||
          target.hasAttribute('disabled') ||
          target.getAttribute('aria-disabled') === 'true';
        if (!disabled) {
          target.click();
          return true;
        }
      }
      return false;
    });
  } catch (err) {
    logger.warn('clickShowMore failed', { message: err instanceof Error ? err.message : String(err) });
  }
  if (clicked) {
    // Let DOM update / results render.
    await sleep(randomBetween(config.showMoreDelayMinMs, config.showMoreDelayMaxMs));
    try {
      await page.evaluate(() => {
        // Scroll a bit to keep the newly loaded cards in view.
        window.scrollBy(0, 400);
      });
    } catch {
      /* ignore */
    }
  }
  await humanDelay();
  return clicked;
}

/**
 * @param {import('puppeteer').Page} page
 * @returns {Promise<number>}
 */
export async function countProfileAnchors(page) {
  try {
    return await page.evaluate(() => document.querySelectorAll('a[href*="/in/"]').length);
  } catch {
    return 0;
  }
}

/**
 * Wait briefly for new people cards to render after clicking "Show more results".
 * @param {import('puppeteer').Page} page
 * @param {number} prevAnchorCount
 */
export async function waitForMoreResults(page, prevAnchorCount) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(900);
    const next = await countProfileAnchors(page);
    if (next > prevAnchorCount + 3) return true;
  }
  return false;
}

/** @param {import('puppeteer').Page} page */
export async function scrollAndLoad(page) {
  await humanDelay();
  try {
    for (let i = 0; i < config.scrollRounds; i++) {
      await page.evaluate(
        (step) => {
          window.scrollBy(0, step);
        },
        config.scrollStepPx,
      );
      await sleep(config.scrollPauseMs);
    }
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(config.scrollPauseMs);
  } catch (err) {
    logger.warn('scrollAndLoad failed', { message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * @typedef {object} ExperienceRecord
 * @property {string | null} title
 * @property {string | null} company
 * @property {string | null} dates
 * @property {string | null} location
 * @property {string | null} description
 */

/**
 * @typedef {object} PersonRecord
 * @property {string} name
 * @property {string} fullName
 * @property {string} profileUrl
 * @property {string | null} title
 * @property {string | null} connectionDegree
 * @property {string | null} company1
 * @property {string | null} company2
 * @property {string | null} company3
 * @property {string | null} about
 * @property {ExperienceRecord[]} experiences
 * @property {CompanyExperience | null} [motiveExperience]
 * @property {boolean} [profileEnriched]
 */

/**
 * @typedef {object} CompanyRole
 * @property {string | null} title
 * @property {string | null} dates
 * @property {string | null} description
 */

/**
 * @typedef {object} CompanyExperience
 * @property {string} company
 * @property {string | null} employmentType
 * @property {string | null} location
 * @property {string | null} [companyUrl]
 * @property {CompanyRole[]} roles
 */

/**
 * Merge raw rows into a Map keyed by normalized profile path.
 * @param {Map<string, PersonRecord>} map
 * @param {RawPersonRow[]} rows
 */
/**
 * @param {Map<string, PersonRecord>} map
 * @param {RawPersonRow[]} rows
 * @returns {PersonRecord[]} newly added people
 */
export function mergePeopleRows(map, rows) {
  /** @type {PersonRecord[]} */
  const added = [];

  for (const row of rows) {
    const profileUrl = normalizeProfileUrl(row.href);
    if (!profileUrl || !isValidProfileUrl(profileUrl)) continue;
    const name = row.name.trim();
    if (!name) continue;

    let key;
    try {
      key = new URL(profileUrl).pathname.toLowerCase();
    } catch {
      key = profileUrl.toLowerCase();
    }

    /** @type {PersonRecord} */
    const incoming = {
      name,
      fullName: name,
      profileUrl,
      title: null,
      connectionDegree: row.connectionDegree || null,
      company1: row.company1 || null,
      company2: row.company2 || null,
      company3: row.company3 || null,
      about: row.about || null,
      experiences: [],
      motiveExperience: null,
      profileEnriched: false,
    };

    if (!map.has(key)) {
      map.set(key, incoming);
      added.push(incoming);
      continue;
    }

    const prev = map.get(key);
    if (!prev) continue;

    /** @type {PersonRecord} */
    const next = {
      ...prev,
      name: prev.fullName || prev.name || incoming.name,
      fullName: prev.fullName || prev.name || incoming.name,
      profileUrl: prev.profileUrl,
      connectionDegree: prev.connectionDegree || incoming.connectionDegree,
      company1: prev.company1 || incoming.company1,
      company2: prev.company2 || incoming.company2,
      company3: prev.company3 || incoming.company3,
      title: prev.title,
      experiences: prev.experiences?.length ? prev.experiences : incoming.experiences,
      profileEnriched: prev.profileEnriched,
    };
    if (!prev.profileEnriched && incoming.about && (!prev.about || incoming.about.length > (prev.about || '').length)) {
      next.about = incoming.about;
    }
    map.set(key, next);
  }

  return added;
}

/**
 * Scroll the profile page until the About section is in view.
 * @param {import('puppeteer').Page} page
 */
export async function scrollToAboutSection(page) {
  try {
    await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const anchor =
        document.querySelector('#about') ||
        [...document.querySelectorAll('h2, h3')].find((h) =>
          /^about$/i.test(norm(h.innerText || h.textContent)),
        );
      anchor?.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    await sleep(randomBetween(600, 1000));
    await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const buttons = [...document.querySelectorAll('button, a, span[role="button"]')];
      const seeMore = buttons.find((el) => {
        const t = norm(el.innerText || el.textContent);
        return /^see more$/i.test(t) || /^show more$/i.test(t);
      });
      const aboutRoot =
        document.querySelector('#about')?.closest('section') ||
        document.querySelector('[data-testid*="about"]');
      if (seeMore && aboutRoot?.contains(seeMore)) seeMore.click();
    });
    await sleep(randomBetween(500, 900));
  } catch {
    /* ignore */
  }
}

/**
 * Scrape the About section from the open profile page.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string | null>}
 */
export async function scrapeProfileAbout(page) {
  await scrollToAboutSection(page);

  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    /** @param {string} label */
    const findSection = (label) => {
      const re = new RegExp(`^\\s*${label}\\s*$`, 'i');
      const anchor = document.querySelector(`#${label.toLowerCase()}`);
      if (anchor) {
        return anchor.closest('section') || anchor.parentElement?.parentElement || anchor.parentElement;
      }
      for (const h of document.querySelectorAll('h2, h3')) {
        const headingText = norm(h.innerText || h.textContent || '');
        if (re.test(headingText)) {
          return h.closest('section') || h.parentElement?.parentElement || h.parentElement;
        }
      }
      return null;
    };

    const pickAboutText = (root) => {
      if (!root) return null;
      const expandable = root.querySelector(
        '[data-testid="expandable-text-box"], [data-testid*="about"] span[dir]',
      );
      if (expandable) {
        const t = norm(expandable.innerText || expandable.textContent);
        if (t.length > 15) return t.slice(0, 5000);
      }
      const clone = root.cloneNode(true);
      clone
        .querySelectorAll('button, a[href*="about"], h2, h3, [aria-label*="about" i]')
        .forEach((el) => el.remove());
      const text = norm(clone.innerText || '').replace(/^about\s*/i, '');
      if (text.length > 15) return text.slice(0, 5000);
      return null;
    };

    let about = pickAboutText(findSection('about'));

    if (!about) {
      const byTestId = document.querySelector('[data-testid*="about-i18n"], [data-testid*="About"]');
      about = pickAboutText(byTestId?.closest('section') || byTestId?.parentElement);
    }

    if (!about) {
      const anchor = document.querySelector('#about');
      about = pickAboutText(anchor?.closest('section') || anchor?.parentElement);
    }

    return about;
  });
}

/**
 * Focus the profile content area so keyboard / wheel scroll applies.
 * @param {import('puppeteer').Page} page
 */
async function focusProfileScrollArea(page) {
  const heading = await findExperienceHeadingHandle(page);
  if (heading) {
    const box = await heading.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 20, box.y + 10);
    }
    await heading.evaluate((el) => el.focus?.());
  } else {
    const vp = page.viewport();
    await page.mouse.move(Math.floor((vp?.width || 1366) * 0.25), 400);
  }
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLAnchorElement) {
      document.body.focus();
    }
  });
  await sleep(randomBetween(150, 300));
}

/** @type {WeakMap<import('puppeteer').Page, string>} */
const profileGuardUrls = new WeakMap();

/**
 * Block navigation to Activity / feed posts; return to profile if mis-clicked.
 * @param {import('puppeteer').Page} page
 * @param {string} profileUrl
 */
export function guardProfileNavigation(page, profileUrl) {
  profileGuardUrls.set(page, profileUrl);
  if (page.__navGuardInstalled) return;
  page.__navGuardInstalled = true;

  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    const guardUrl = profileGuardUrls.get(page);
    if (!guardUrl) return;

    const profilePath = (() => {
      try {
        return new URL(guardUrl).pathname.replace(/\/$/, '');
      } catch {
        return '';
      }
    })();

    const url = frame.url();
    const isBad =
      /feed\/update|urn:li:activity|\/posts\//i.test(url) ||
      (profilePath && !url.includes(profilePath) && /\/feed\//i.test(url));

    if (!isBad) return;
    logger.warn('Stray navigation (Activity/feed), returning to profile', { url });
    try {
      await page.goto(guardUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      /* ignore */
    }
  });
}

/**
 * Scroll the profile down using wheel, scroll containers, and keyboard (LinkedIn often ignores window.scrollBy).
 * @param {import('puppeteer').Page} page
 * @param {number} [deltaY]
 */
/** @param {import('puppeteer').Page} page */
async function findAndScrollProfile(page, deltaY) {
  const scrolled = await page.evaluate((dy) => {
    const findScroller = () => {
      const picks = [
        document.querySelector('.scaffold-layout__main'),
        document.querySelector('.scaffold-layout__inner'),
        document.querySelector('main'),
        document.querySelector('[role="main"]'),
        document.scrollingElement,
        document.documentElement,
      ];
      for (const el of picks) {
        if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 40) {
          return el;
        }
      }
      for (const node of document.querySelectorAll('motion.main, div, main')) {
        if (!(node instanceof HTMLElement) || node.clientHeight < 200) continue;
        if (node.scrollHeight > node.clientHeight + 80) {
          const oy = getComputedStyle(node).overflowY;
          if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return node;
        }
      }
      return document.scrollingElement || document.documentElement;
    };

    const el = findScroller();
    if (!(el instanceof HTMLElement)) return { before: 0, after: 0 };
    const before = el.scrollTop;
    el.scrollTop = Math.min(before + dy, el.scrollHeight - el.clientHeight);
    return { before, after: el.scrollTop };
  }, deltaY);

  const vp = page.viewport() || { width: 1366, height: 900 };
  await page.mouse.move(Math.floor(vp.width * 0.35), Math.floor(vp.height * 0.5));
  await page.mouse.wheel({ deltaY });

  return scrolled;
}

export async function profileScrollDown(
  page,
  deltaY = config.profileExperienceScrollPx || 300,
) {
  await findAndScrollProfile(page, deltaY);
  await sleep(randomBetween(350, 550));
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} selector
 */
async function scrollSelectorIntoView(page, selector) {
  const handle = await page.$(selector);
  if (!handle) return false;
  await handle.evaluate((el) =>
    el.scrollIntoView({ block: 'center', behavior: 'instant', inline: 'nearest' }),
  );
  await sleep(randomBetween(600, 900));
  return true;
}

async function findExperienceHeadingHandle(page) {
  const anchor = await page.$(LINKEDIN_SELECTORS.experienceAnchor);
  if (anchor) return anchor;

  for (const h of await page.$$(LINKEDIN_SELECTORS.experienceHeading)) {
    const text = await h.evaluate((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
    if (/^experience$/i.test(text)) return h;
  }
  for (const h of await page.$$('h3')) {
    const text = await h.evaluate((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
    if (/^experience$/i.test(text)) return h;
  }
  return null;
}

/**
 * Scroll using selectors until Experience section + Motive logo/cards are visible.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
export async function scrollToExperienceSection(page) {
  try {
    await page.waitForSelector(LINKEDIN_SELECTORS.main, { timeout: 10_000 }).catch(() => {});
    await sleep(randomBetween(1200, 1800));

    const stepPx = config.profileExperienceScrollPx || 300;
    const maxSteps = config.profileExperienceMaxScrollSteps || 18;

    for (let step = 0; step < maxSteps; step += 1) {
      const state = await page.evaluate((sel) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const headingEl =
          document.querySelector('#experience') ||
          [...document.querySelectorAll('h2')].find((h) =>
            /^experience$/i.test(norm(h.textContent)),
          );
        if (!headingEl) {
          return { hasHeading: false, ready: false, scrollY: 0 };
        }

        const rect = headingEl.getBoundingClientRect();
        const inView = rect.top >= 40 && rect.top < window.innerHeight * 0.88;

        let scope = headingEl.parentElement;
        for (let i = 0; i < 12 && scope; i += 1) {
          if (scope.querySelectorAll('p').length >= 2) break;
          scope = scope.parentElement;
        }
        scope = scope || headingEl.parentElement || headingEl;

        const texts = [...scope.querySelectorAll(sel.textLine)].map((n) =>
          norm(n.textContent),
        );
        const hasPresentDash = texts.some((t) => /\bpresent\b/i.test(t) && /[-–]/.test(t));
        const hasCards = texts.filter((t) => t.length > 2).length >= 2;

        const scroller =
          document.querySelector('.scaffold-layout__main') ||
          document.scrollingElement ||
          document.documentElement;
        const scrollY = scroller instanceof HTMLElement ? scroller.scrollTop : window.scrollY;

        return {
          hasHeading: true,
          inView,
          ready: inView && (hasPresentDash || hasCards),
          hasPresentDash,
          scrollY,
        };
      }, LINKEDIN_SELECTORS);

      if (state.ready) {
        const heading = await findExperienceHeadingHandle(page);
        if (heading) {
          await heading.evaluate((el) =>
            el.scrollIntoView({ block: 'start', behavior: 'instant', inline: 'nearest' }),
          );
        }
        logger.info('Experience section in view', {
          step,
          scrollY: state.scrollY,
          hasPresentDash: state.hasPresentDash,
        });
        await sleep(randomBetween(500, 800));
        return true;
      }

      if (state.hasHeading && state.inView && step >= 1) {
        logger.info('Experience heading visible', { step, scrollY: state.scrollY });
        await sleep(randomBetween(400, 600));
        return true;
      }

      const scrollResult = await findAndScrollProfile(page, stepPx);
      if (step > 0 && step % 4 === 0) {
        logger.info('Scrolling to Experience…', {
          step,
          scrollY: scrollResult?.after ?? state.scrollY,
        });
      }
      await sleep(randomBetween(400, 600));
    }

    logger.warn('Experience section not reached after gentle scroll');
    return false;
  } catch (err) {
    logger.warn('scrollToExperienceSection failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Scroll-poll until a Motive logo or `/company/3271606` link appears in the DOM.
 * @param {import('puppeteer').Page} page
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function waitForMotiveBlock(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const inExperience = await page.evaluate((sel) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const heading =
          document.querySelector('#experience') ||
          [...document.querySelectorAll('h2')].find((h) => /^experience$/i.test(norm(h.textContent)));
        if (!heading) return false;
        let scope = heading.parentElement;
        for (let i = 0; i < 12 && scope; i += 1) {
          if (scope.querySelector(sel.motiveCompanyLink)) return true;
          scope = scope.parentElement;
        }
        return false;
      }, LINKEDIN_SELECTORS);
      if (inExperience) return true;
    } catch {
      return false;
    }
    try {
      await profileScrollDown(page, 650);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Find Motive under Experience via logo (alt/src), company URL, or "Motive · …" text.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<CompanyExperience | null>}
 */
export async function scrapeCompanyExperience(
  page,
  aliases = config.targetCompanyAliases,
) {
  await scrollToExperienceSection(page);
  await expandExperienceSection(page);
  await page
    .waitForSelector('a[href*="3271606"], a[href*="/company/"], img[alt], svg[aria-label]', {
      timeout: 8000,
    })
    .catch(() => {});

  return page.evaluate((companyAliases) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const matchesCompany = (text, href) => {
      const t = (text || '').toLowerCase();
      const h = (href || '').toLowerCase();
      return companyAliases.some((a) => {
        const al = a.toLowerCase();
        return t.includes(al) || h.includes(`/company/${al}`) || h.includes(al.replace(/\s+/g, '-'));
      });
    };

    const isMotiveLogo = (el) => {
      if (!el) return false;
      const alt = (el.getAttribute('alt') || '').toLowerCase();
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const src = (el.getAttribute('src') || '').toLowerCase();
      if (/motive/.test(alt) || /motive/.test(label)) return true;
      if (/motive_inc_logo|3271606|motive-inc|keeptruckin/.test(src)) return true;
      const link = el.closest('a[href*="/company/"]');
      return link ? matchesCompany('', link.getAttribute('href') || '') : false;
    };

    const isJunkLine = (t) => !t || /^[·•\s]+$/.test(t) || t.length < 2;

    const isDateLine = (t) => {
      if (isJunkLine(t) || t.length > 140) return false;
      const hasMonth = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t);
      const hasYear = /\b(19|20)\d{2}\b/.test(t);
      const hasPresent = /\bpresent\b/i.test(t);
      const hasRange = /[-–]/.test(t);
      const hasDuration = /\b(mos|yr|yrs|month|months|year|years)\b/i.test(t);
      // Solid signals first.
      if (hasPresent && (hasYear || hasMonth)) return true;
      if (/\d{4}\s*[-–]\s*(\d{4}|present)\b/i.test(t)) return true;
      if (hasMonth && hasYear && (hasRange || hasDuration || hasPresent)) return true;
      if (hasYear && hasDuration) return true;
      return false;
    };

    const isLocationLine = (t) => {
      if (isJunkLine(t)) return false;
      if (t.length > 80) return false; // descriptions are long
      if (/\./.test(t)) return false; // sentences contain full stops
      if (isDateLine(t)) return false;
      if (/^motive\b/i.test(t)) return false;
      if (/\b(responsible|achieved|leading|leveraging|key|skills?|managing)\b/i.test(t)) return false;
      return (
        t.includes(',') ||
        /\bremote\b/i.test(t) ||
        /·\s*(remote|hybrid|on[-\s]?site|office)/i.test(t) ||
        /^(pakistan|islamabad|lahore|karachi|rawalpindi|peshawar|quetta)\b/i.test(t)
      );
    };

    const isEmploymentHeader = (t) =>
      !isJunkLine(t) &&
      !isDateLine(t) &&
      (/^(full-time|part-time|contract|internship|self-employed|freelance)$/i.test(t) ||
        (/full-time|part-time|contract|internship|self-employed|freelance/i.test(t) &&
          t.length < 40 &&
          !/^motive\s*·/i.test(t)));

    const isBadExperienceLine = (t) =>
      /^(contact info|education|skills|about|recommendations|activity|licenses|certifications)$/i.test(
        t,
      ) ||
      /\b(school|university|college|institute|academy|economics)\b/i.test(t);

    const isLikelyJobTitle = (t) =>
      !isJunkLine(t) &&
      !isBadExperienceLine(t) &&
      !isDateLine(t) &&
      !isLocationLine(t) &&
      !isEmploymentHeader(t) &&
      !/^motive\s*·/i.test(t) &&
      !matchesCompany(t, '') &&
      t.length >= 3 &&
      t.length <= 120 &&
      (t.match(/\|/g) || []).length < 2;

    const splitCompanyLine = (line) => {
      if (!line || !line.includes('·')) return { company: null, employmentType: null };
      const parts = line.split('·').map((p) => norm(p)).filter(Boolean);
      const head = parts[0] || '';
      if (!matchesCompany(head, '')) return { company: null, employmentType: null };
      return { company: head, employmentType: parts.slice(1).join(' · ') || null };
    };

    const companyHref = (root) => {
      const link = [...root.querySelectorAll('a[href*="/company/"]')].find((a) =>
        matchesCompany('', a.getAttribute('href') || ''),
      );
      const href = link?.getAttribute('href') || '';
      if (!href) return null;
      return href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
    };

    const getExperienceScope = () => {
      const fromAnchor = (start) => {
        if (!start) return null;
        return (
          start.closest('section') ||
          start.parentElement?.parentElement ||
          start.parentElement ||
          document.querySelector('main')
        );
      };
      const anchor = document.querySelector('#experience');
      if (anchor) return fromAnchor(anchor);
      const byTestId = document.querySelector('[data-testid*="Experience"]');
      if (byTestId) return fromAnchor(byTestId);
      const h2 = [...document.querySelectorAll('h2, h3')].find((h) =>
        /^experience$/i.test(norm(h.innerText || h.textContent)),
      );
      if (h2) return fromAnchor(h2);
      return document.querySelector('main') || document.body;
    };

    /** Must have Motive logo or /company/3271606 link — no text-only guesses. */
    /** @param {Element} root */
    const isMotiveBlock = (root) => {
      if (isBadExperienceLine(norm(root.innerText || '').split('\n')[0] || '')) return false;
      if ([...root.querySelectorAll('img, svg')].some(isMotiveLogo)) return true;
      return [...root.querySelectorAll('a[href*="/company/"]')].some((a) =>
        matchesCompany('', a.getAttribute('href') || ''),
      );
    };

    /**
     * Score a date string — prefer ones with " - " separator, "Present", and
     * duration tokens ("yr"/"mos"). This avoids picking a partial span like
     * "Jun 2022" when the full "<p>Jun 2022 - Present · 3 yrs</p>" exists.
     * @param {string} t
     */
    const scoreDateLine = (t) => {
      if (!isDateLine(t)) return -1;
      let score = t.length;
      if (/\bpresent\b/i.test(t)) score += 30;
      if (/-/.test(t)) score += 20;
      if (/\b(yr|yrs|mos|month|year)\b/i.test(t)) score += 15;
      if (/·/.test(t)) score += 5;
      return score;
    };

    /** Prefer <p> nodes that contain Present or a month–year range (LinkedIn date row). */
    /** @param {Element} root */
    const findDateLine = (root, fallbackLines = []) => {
      /** @type {{ t: string, score: number }[]} */
      const candidates = [];
      for (const p of root.querySelectorAll('p')) {
        if (p.closest('ul')) continue;
        const t = norm(p.innerText);
        const score = scoreDateLine(t);
        if (score > 0) candidates.push({ t, score });
      }
      for (const span of root.querySelectorAll('span[aria-hidden="true"]')) {
        const t = norm(span.textContent);
        const score = scoreDateLine(t);
        if (score > 0) candidates.push({ t, score });
      }
      for (const l of fallbackLines) {
        const score = scoreDateLine(l);
        if (score > 0) candidates.push({ t: l, score });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0].t;
    };

    /** @param {object | null} parsed */
    const isValidMotiveResult = (parsed) => {
      if (!parsed?.company) return false;
      if (parsed.employmentType && isBadExperienceLine(parsed.employmentType)) return false;
      const roles = parsed.roles || [];
      if (roles.some((r) => r.title && isBadExperienceLine(r.title))) return false;
      if (parsed.companyUrl) return true;
      return roles.some((r) => r.dates);
    };

    /** @param {object | null} parsed @param {Element} root */
    const scoreMotiveResult = (parsed, root) => {
      if (!parsed) return -1;
      let score = 0;
      if (parsed.companyUrl) score += 50;
      if ([...root.querySelectorAll('img, svg')].some(isMotiveLogo)) score += 40;
      for (const r of parsed.roles || []) {
        if (r.dates) score += 35;
        if (r.title && isLikelyJobTitle(r.title)) score += 25;
        if (r.title && isBadExperienceLine(r.title)) score -= 200;
      }
      if (parsed.employmentType && !isBadExperienceLine(parsed.employmentType)) score += 5;
      if (parsed.employmentType && isBadExperienceLine(parsed.employmentType)) score -= 80;
      if (findDateLine(root, [])) score += 20;
      return score;
    };

    /** @param {Element} start */
    const findCardRoot = (start) => {
      const byItem =
        start.closest('[componentkey*="entity-collection-item"]') ||
        start.closest('li.pvs-list__paged-list-item') ||
        start.closest('li.artdeco-list__item') ||
        start.closest('.pvs-entity');
      if (byItem) return byItem;
      let el = start;
      for (let depth = 0; depth < 16 && el; depth += 1) {
        if (el.getAttribute?.('componentkey')?.includes('entity-collection-item')) return el;
        if (el.classList?.contains('pvs-list__paged-list-item')) return el;
        if (el.classList?.contains('artdeco-list__item')) return el;
        if (el.classList?.contains('pvs-entity')) return el;
        const hasLogo = [...el.querySelectorAll('img, svg')].some(isMotiveLogo);
        const ps = [...el.querySelectorAll('p, span[aria-hidden="true"]')].filter(
          (n) => !n.closest('ul'),
        );
        const companyLink = [...el.querySelectorAll('a[href*="/company/"]')].find((a) =>
          matchesCompany('', a.getAttribute('href') || ''),
        );
        if (companyLink && (hasLogo || ps.length >= 2)) return el;
        el = el.parentElement;
      }
      return start.closest('[componentkey]') || start.parentElement || start;
    };

    /** @param {Element} root */
    const collectLines = (root) => {
      /** @type {string[]} */
      const lines = [];
      const pushIf = (t) => {
        if (t && !isJunkLine(t) && t.length < 500 && !/^experience$/i.test(t)) lines.push(t);
      };
      root.querySelectorAll('p').forEach((p) => {
        if (p.closest('ul')) return;
        pushIf(norm(p.innerText));
      });
      root.querySelectorAll('span[aria-hidden="true"]').forEach((s) => {
        if (s.closest('ul')) return;
        pushIf(norm(s.textContent));
      });
      if (lines.length < 2) {
        norm(root.innerText)
          .split('\n')
          .map(norm)
          .filter((l) => !isJunkLine(l) && !/^experience$/i.test(l))
          .forEach((l) => lines.push(l));
      }
      return [...new Set(lines)];
    };

    /** Grouped Motive block (multiple roles under one company) — matches 07-25 successful runs. */
    /** @param {Element} root */
    const parseGroupedMotiveBlock = (root) => {
      if (!isMotiveBlock(root)) return null;

      const href = companyHref(root);
      const allLines = collectLines(root);

      let company = 'Motive';
      let employmentType =
        allLines.find(
          (l) =>
            isEmploymentHeader(l) &&
            !isDateLine(l) &&
            !isBadExperienceLine(l) &&
            !matchesCompany(l, ''),
        ) || null;
      const companyLine = allLines.find((l) => matchesCompany(l, href || '') || /^motive\s*·/i.test(l));
      if (companyLine) {
        const split = splitCompanyLine(companyLine);
        if (split.company) {
          company = split.company;
          if (!employmentType) employmentType = split.employmentType;
        }
      }

      const location =
        allLines.find((l) => isLocationLine(l) && !employmentType?.includes(l)) || null;

      /** @type {CompanyRole[]} */
      const roles = [];
      // Only take the latest (first) <li> — LinkedIn lists most-recent first.
      const firstLi = root.querySelector('ul li');
      if (firstLi) {
        const ps = [...firstLi.querySelectorAll('p, span[aria-hidden="true"]')]
          .map((el) => norm(el.innerText || el.textContent))
          .filter((t) => !isJunkLine(t));
        if (ps.length) {
          const dates = findDateLine(firstLi, ps) || ps.find((t) => isDateLine(t)) || null;
          const title =
            ps.find(
              (t) =>
                t !== dates &&
                isLikelyJobTitle(t) &&
                !/skills$/i.test(t),
            ) || ps.find((t) => t !== dates && !matchesCompany(t, '')) || null;
          const descEl = firstLi.querySelector('[data-testid="expandable-text-box"]');
          const description = descEl ? norm(descEl.innerText).slice(0, 2000) : null;
          if (title && !isJunkLine(title)) roles.push({ title, dates, description });
        }
      }

      if (!roles.length) return null;

      return {
        company,
        employmentType,
        location,
        roles,
        companyUrl: href,
      };
    };

    /** Single-role Motive card (logo + title / Motive · Full-time / dates / location). */
    /** @param {Element} root */
    const parseSingleMotiveBlock = (root) => {
      if (!isMotiveBlock(root)) return null;

      const href = companyHref(root);
      const unique = collectLines(root);
      if (!unique.length && !href) return null;

      const companyLine = unique.find(
        (l) => matchesCompany(l, href || '') || /^motive\s*·/i.test(l),
      );
      let company = 'Motive';
      let employmentType = null;
      if (companyLine) {
        const split = splitCompanyLine(companyLine);
        if (split.company) {
          company = split.company;
          employmentType = split.employmentType;
        }
      }

      const dates = findDateLine(root, unique) || null;
      const location = unique.find((l) => isLocationLine(l)) || null;
      const used = new Set([companyLine, dates, location].filter(Boolean));
      const title = unique.find((l) => !used.has(l) && isLikelyJobTitle(l)) || null;

      if (employmentType && /^motive\s*·/i.test(employmentType)) {
        const split = splitCompanyLine(employmentType);
        employmentType = split.employmentType;
      }
      if (!employmentType) {
        const empLine = unique.find(
          (l) => !used.has(l) && l !== title && /^motive\s*·/i.test(l),
        );
        if (empLine) employmentType = splitCompanyLine(empLine).employmentType;
      }
      if (!employmentType) {
        employmentType =
          unique.find((l) => !used.has(l) && l !== title && isEmploymentHeader(l)) || null;
      }

      /** @type {CompanyRole[]} */
      const roles = [];
      if (title || dates) roles.push({ title, dates, description: null });

      if (!href && !dates && !roles.length) return null;
      if (!roles.length && !dates) return null;

      return {
        company,
        employmentType,
        location,
        roles,
        companyUrl: href,
      };
    };

    /** @param {Element} root */
    const parseMotiveBlock = (root) => parseGroupedMotiveBlock(root) || parseSingleMotiveBlock(root);

    /**
     * Parse a single <li> sub-role inside a grouped Motive card.
     * Returns { title, dates, location, description } or null.
     * @param {Element} li
     */
    const parseGroupedRoleLi = (li) => {
      const ps = [...li.querySelectorAll('p')]
        .filter((p) => p.closest('li') === li)
        .map((p) => norm(p.innerText));
      const spanTexts = [...li.querySelectorAll('span[aria-hidden="true"]')]
        .filter((s) => s.closest('li') === li)
        .map((s) => norm(s.textContent));
      const allTexts = [...ps, ...spanTexts].filter((t) => t && !isJunkLine(t));
      if (!allTexts.length) return null;
      const dates = findDateLine(li, allTexts) || null;
      const location = allTexts.find((t) => t !== dates && isLocationLine(t)) || null;
      const used = new Set([dates, location].filter(Boolean));
      const title =
        allTexts.find(
          (t) =>
            !used.has(t) &&
            isLikelyJobTitle(t) &&
            !/skills$/i.test(t) &&
            !/^motive\b/i.test(t),
        ) ||
        allTexts.find(
          (t) => !used.has(t) && t.length > 2 && !matchesCompany(t, ''),
        ) ||
        null;
      const descEl = li.querySelector('[data-testid="expandable-text-box"]');
      const description = descEl ? norm(descEl.innerText).slice(0, 2000) : null;
      if (!title && !dates) return null;
      return { title, dates, location, description };
    };

    /**
     * Build a Motive result by reading title / company line / dates / location
     * from a card element's <p> + <span aria-hidden> nodes in document order.
     * If the card contains a <ul> with sub-role <li>s (grouped multi-role Motive
     * card), each <li> becomes a role and the first (latest) role drives the
     * top-level title/dates.
     * @param {Element} card
     * @returns {object | null}
     */
    const buildMotiveResultFromCard = (card) => {
      if (!card) return null;
      const href = companyHref(card);

      // Detect grouped multi-role list (e.g. the user's <ul><li>Title<p>dates</p></li>…</ul>).
      const lis = [...card.querySelectorAll('ul > li')].filter((li) =>
        li.querySelector('a[href*="/company/"], p'),
      );
      // <li> is a Motive sub-role if it links to Motive, mentions "Motive · …",
      // or has no foreign company link (inherits the parent Motive context).
      const groupedRoleLis = lis.filter((li) => {
        const links = [...li.querySelectorAll('a[href*="/company/"]')];
        if (!links.length) {
          const txts = [...li.querySelectorAll('p, span[aria-hidden="true"]')].map((n) =>
            norm(n.innerText || n.textContent),
          );
          if (txts.some((t) => /^motive\s*·/i.test(t))) return true;
          return false;
        }
        return links.some((a) => matchesCompany('', a.getAttribute('href') || ''));
      });

      // Grouped multi-role <ul><li>…</li><li>…</li></ul> — keep ONLY the latest
      // role (the first <li>, which is the most recent per LinkedIn ordering).
      if (groupedRoleLis.length >= 1 && card.querySelector('ul > li')) {
        const latestLi = groupedRoleLis[0];
        const latestRole = parseGroupedRoleLi(latestLi);
        if (latestRole && (latestRole.title || latestRole.dates)) {
          const outerLines = collectLines(card);
          const companyLine = outerLines.find(
            (l) => /^motive\s*·/i.test(l) || matchesCompany(l, href || ''),
          );
          let company = 'Motive';
          let employmentType = null;
          if (companyLine) {
            const split = splitCompanyLine(companyLine);
            if (split.company) {
              company = split.company;
              employmentType = split.employmentType;
            }
          }
          const parsed = {
            company,
            employmentType,
            location: latestRole.location,
            roles: [
              {
                title: latestRole.title,
                dates: latestRole.dates,
                description: latestRole.description,
              },
            ],
            companyUrl: href,
          };
          if (isValidMotiveResult(parsed)) return parsed;
        }
      }

      // Single-role fallback.
      const lines = collectLines(card);
      if (!lines.length) return null;
      const companyLine = lines.find(
        (l) => /^motive\s*·/i.test(l) || matchesCompany(l, href || ''),
      );
      let company = 'Motive';
      let employmentType = null;
      if (companyLine) {
        const split = splitCompanyLine(companyLine);
        if (split.company) {
          company = split.company;
          employmentType = split.employmentType;
        }
      }
      const dates = findDateLine(card, lines) || null;
      const location = lines.find((l) => isLocationLine(l)) || null;
      const used = new Set([companyLine, dates, location].filter(Boolean));
      let title = lines.find((l) => !used.has(l) && isLikelyJobTitle(l)) || null;

      // If title is still null, fall back to the latest <li>'s title (user's
      // grouped Motive card layout).
      if (!title && lis.length) {
        for (const li of lis) {
          const role = parseGroupedRoleLi(li);
          if (role?.title) {
            title = role.title;
            break;
          }
        }
      }

      if (!employmentType) {
        const empLine = lines.find(
          (l) => !used.has(l) && l !== title && /^motive\s*·/i.test(l),
        );
        if (empLine) employmentType = splitCompanyLine(empLine).employmentType;
      }
      /** @type {CompanyRole[]} */
      const roles = [];
      if (title || dates) roles.push({ title, dates, description: null });
      const parsed = {
        company,
        employmentType,
        location,
        roles,
        companyUrl: href,
      };
      if (!isValidMotiveResult(parsed)) return null;
      return parsed;
    };

    /**
     * Locate the first experience card that appears right after the "Experience"
     * heading and parse it as Motive. The user confirmed that for current Motive
     * employees the very first card is the Motive one.
     * @returns {object | null}
     */
    const parseFirstCardAfterExperienceHeading = () => {
      const heading =
        document.querySelector('#experience') ||
        [...document.querySelectorAll('h2, h3')].find((h) =>
          /^experience$/i.test(norm(h.innerText || h.textContent)),
        );
      if (!heading) return null;

      let container = heading.parentElement;
      for (let i = 0; i < 8 && container; i += 1) {
        if (container.querySelector('a[href*="/company/"]')) break;
        container = container.parentElement;
      }
      if (!container) container = heading.closest('section') || document.querySelector('main');
      if (!container) return null;

      const firstCompanyLink = container.querySelector('a[href*="/company/"]');
      if (!firstCompanyLink) return null;

      let card = firstCompanyLink;
      let bestCard = null;
      for (let i = 0; i < 14 && card; i += 1) {
        const ps = [...card.querySelectorAll('p, span[aria-hidden="true"]')].filter(
          (n) => !n.closest('ul'),
        );
        const uniqueTexts = new Set(
          ps.map((n) => norm(n.innerText || n.textContent)).filter(Boolean),
        );
        if (uniqueTexts.size >= 3) {
          bestCard = card;
          break;
        }
        card = card.parentElement;
      }
      if (!bestCard) bestCard = firstCompanyLink.closest('li, div');
      if (!bestCard) return null;

      const href = firstCompanyLink.getAttribute('href') || '';
      const matchesMotive =
        matchesCompany('', href) ||
        [...bestCard.querySelectorAll('img, svg')].some(isMotiveLogo) ||
        [...bestCard.querySelectorAll('p, span[aria-hidden="true"]')].some((n) =>
          /^motive\s*·/i.test(norm(n.innerText || n.textContent)),
        );
      if (!matchesMotive) return null;

      const parsed = buildMotiveResultFromCard(bestCard);
      if (!parsed) return null;

      // Date fallback: if no dates parsed from the card itself, scan up the
      // ancestor chain for any <p> containing "Present" or a month/year range
      // that lives near (within ~2 ancestors of) the matched company link.
      if (!parsed.roles?.[0]?.dates) {
        const datesGuess = (() => {
          let anc = bestCard;
          for (let i = 0; i < 4 && anc; i += 1) {
            for (const p of anc.querySelectorAll('p, span[aria-hidden="true"]')) {
              if (p.closest('ul')) continue;
              const t = norm(p.innerText || p.textContent);
              if (isDateLine(t)) return t;
            }
            anc = anc.parentElement;
          }
          return null;
        })();
        if (datesGuess) {
          if (!parsed.roles?.length) {
            parsed.roles = [{ title: null, dates: datesGuess, description: null }];
          } else {
            parsed.roles[0] = { ...parsed.roles[0], dates: datesGuess };
          }
        }
      }

      return parsed;
    };

    /**
     * Targeted parser for the new obfuscated layout (e.g. <div class="_905c4fe2 ...">).
     * Starts from each Motive `<a href="/company/3271606/">` link inside the scope,
     * climbs to the smallest ancestor that holds 3+ `<p>` siblings, and reads them in
     * document order.
     * @param {Element} scope
     * @returns {object[]} list of parsed candidates
     */
    const parseObfuscatedMotiveCard = (scope) => {
      const results = [];
      const motiveLinks = [...scope.querySelectorAll('a[href*="/company/"]')].filter((a) =>
        matchesCompany('', a.getAttribute('href') || ''),
      );
      const linkSeen = new Set();
      for (const link of motiveLinks) {
        let container = link;
        let bestContainer = null;
        for (let i = 0; i < 14 && container; i += 1) {
          const ps = [...container.querySelectorAll('p, span[aria-hidden="true"]')].filter(
            (n) => !n.closest('ul'),
          );
          const uniqueTexts = new Set(
            ps.map((n) => norm(n.innerText || n.textContent)).filter(Boolean),
          );
          if (uniqueTexts.size >= 3) {
            bestContainer = container;
            break;
          }
          container = container.parentElement;
        }
        if (!bestContainer) continue;
        const key = bestContainer.getAttribute?.('componentkey') ||
          (bestContainer.innerText || '').slice(0, 120);
        if (linkSeen.has(key)) continue;
        linkSeen.add(key);

        const href = link.getAttribute('href') || companyHref(bestContainer);
        const lines = collectLines(bestContainer);
        if (!lines.length) continue;

        const companyLine = lines.find(
          (l) => /^motive\s*·/i.test(l) || matchesCompany(l, href || ''),
        );
        let company = 'Motive';
        let employmentType = null;
        if (companyLine) {
          const split = splitCompanyLine(companyLine);
          if (split.company) {
            company = split.company;
            employmentType = split.employmentType;
          }
        }

        const dates = findDateLine(bestContainer, lines) || null;
        const location = lines.find((l) => isLocationLine(l)) || null;
        const used = new Set([companyLine, dates, location].filter(Boolean));
        const title = lines.find((l) => !used.has(l) && isLikelyJobTitle(l)) || null;

        if (!employmentType) {
          const empLine = lines.find(
            (l) => !used.has(l) && l !== title && /^motive\s*·/i.test(l),
          );
          if (empLine) employmentType = splitCompanyLine(empLine).employmentType;
        }

        /** @type {CompanyRole[]} */
        const roles = [];
        if (title || dates) roles.push({ title, dates, description: null });

        const parsed = {
          company,
          employmentType,
          location,
          roles,
          companyUrl: href,
        };
        if (!isValidMotiveResult(parsed)) continue;
        results.push(parsed);
      }
      return results;
    };

    const scope = getExperienceScope();
    if (!scope) return null;

    /** @type {{ parsed: object, score: number }[]} */
    const candidates = [];
    const seen = new Set();

    const tryBlock = (block) => {
      const key = block.getAttribute?.('componentkey') || (block.innerText || '').slice(0, 100);
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      if (!isMotiveBlock(block)) return;
      const parsed = parseMotiveBlock(block);
      const score = scoreMotiveResult(parsed, block);
      if (parsed && score > 0) candidates.push({ parsed, score });
    };

    /**
     * Direct extractor for the exact pattern the user pasted: a single Motive
     * company anchor `<a href="/company/3271606/">` whose descendants contain
     * the title <p>, "Motive · Full-time" <p>, and the dates <p> all together.
     * This is the most reliable signal because one anchor == one role, no
     * climb-up needed.
     * @param {Element} scopeEl
     * @returns {object | null}
     */
    const parseInnerAnchorMotiveCard = (scopeEl) => {
      const anchors = [...scopeEl.querySelectorAll('a[href*="/company/"]')].filter((a) =>
        matchesCompany('', a.getAttribute('href') || ''),
      );
      for (const a of anchors) {
        const ps = [...a.querySelectorAll('p, span[aria-hidden="true"]')]
          .filter((n) => !n.closest('ul') && !n.closest('figure'))
          .map((n) => norm(n.innerText || n.textContent))
          .filter(Boolean);
        if (ps.length < 2) continue;

        const companyLine = ps.find((t) => /^motive\s*·/i.test(t));
        const dates = ps.find((t) => isDateLine(t));
        if (!companyLine && !dates) continue;

        const used = new Set([companyLine, dates].filter(Boolean));
        const title = ps.find((t) => !used.has(t) && isLikelyJobTitle(t)) || null;

        let company = 'Motive';
        let employmentType = null;
        if (companyLine) {
          const split = splitCompanyLine(companyLine);
          if (split.company) {
            company = split.company;
            employmentType = split.employmentType;
          }
        }
        const result = {
          company,
          employmentType,
          location: null,
          roles: [{ title, dates: dates || null, description: null }],
          companyUrl: a.getAttribute('href'),
        };
        if (isValidMotiveResult(result)) return result;
      }
      return null;
    };

    const inner = parseInnerAnchorMotiveCard(scope);
    if (inner) {
      candidates.push({ parsed: inner, score: scoreMotiveResult(inner, scope) + 150 });
    }

    const firstCard = parseFirstCardAfterExperienceHeading();
    if (firstCard) {
      const score = scoreMotiveResult(firstCard, scope) + 100;
      candidates.push({ parsed: firstCard, score });
    }

    /**
     * Last-resort date scan: pick any "Present" / "Mon YYYY - …" / year range
     * line anywhere on the page. Prefer one near a Motive marker.
     * @returns {string | null}
     */
    const findAnyDateAnywhere = () => {
      /** @type {{ t: string, score: number }[]} */
      const all = [];
      const isNearMotive = (el) => {
        let cur = el;
        for (let i = 0; i < 14 && cur; i += 1) {
          if (
            [...cur.querySelectorAll('a[href*="/company/"]')].some((a) =>
              matchesCompany('', a.getAttribute('href') || ''),
            )
          )
            return true;
          if ([...cur.querySelectorAll('img, svg')].some(isMotiveLogo)) return true;
          if (
            [...cur.querySelectorAll('p, span[aria-hidden="true"]')].some((n) =>
              /^motive\s*·/i.test(norm(n.innerText || n.textContent)),
            )
          )
            return true;
          cur = cur.parentElement;
        }
        return false;
      };
      for (const el of document.querySelectorAll('p, span[aria-hidden="true"]')) {
        const t = norm(el.innerText || el.textContent);
        const base = scoreDateLine(t);
        if (base <= 0) continue;
        const motiveBoost = isNearMotive(el) ? 200 : 0;
        all.push({ t, score: base + motiveBoost });
      }
      if (!all.length) return null;
      all.sort((a, b) => b.score - a.score);
      return all[0].t;
    };

    for (const parsed of parseObfuscatedMotiveCard(scope)) {
      const score = scoreMotiveResult(parsed, scope) + 60;
      candidates.push({ parsed, score });
    }

    let blocks = [...scope.querySelectorAll('[componentkey*="entity-collection-item"]')];
    for (const block of blocks) tryBlock(block);

    const pvsBlocks = [
      ...scope.querySelectorAll(
        'li.pvs-list__paged-list-item, li.artdeco-list__item, .pvs-entity',
      ),
    ];
    for (const block of pvsBlocks) tryBlock(block);

    /** @type {Element[]} */
    const markers = [];
    scope.querySelectorAll('img, svg').forEach((el) => {
      if (isMotiveLogo(el)) markers.push(el);
    });
    scope.querySelectorAll('a[href*="/company/"]').forEach((a) => {
      if (matchesCompany('', a.getAttribute('href') || '')) markers.push(a);
    });

    for (const marker of markers) {
      tryBlock(findCardRoot(marker));
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates.find((c) => isValidMotiveResult(c.parsed));
    if (!best) return null;

    // Final safety: ensure the top role has dates. Use any near-Motive date on
    // the page as a last resort.
    if (best.parsed?.roles?.length && !best.parsed.roles[0]?.dates) {
      const datesGuess = findAnyDateAnywhere();
      if (datesGuess) {
        best.parsed.roles[0] = { ...best.parsed.roles[0], dates: datesGuess };
      }
    }
    // Trim to only the latest role.
    if (best.parsed?.roles?.length > 1) {
      best.parsed.roles = [best.parsed.roles[0]];
    }
    return best.parsed;
  }, aliases);
}

/**
 * Generic fallback: extract the TOP-MOST experience card on the profile
 * regardless of company. Used only when Motive-specific extractors return null
 * so every row still has a designation / dates / company name.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<CompanyExperience | null>}
 */
export async function scrapeFirstExperienceCard(page) {
  await scrollToExperienceSection(page);
  await expandExperienceSection(page);
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const isJunkLine = (t) => !t || /^[·•\s]+$/.test(t) || t.length < 2;

    const isDateLine = (t) => {
      if (isJunkLine(t) || t.length > 140) return false;
      const hasMonth = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t);
      const hasYear = /\b(19|20)\d{2}\b/.test(t);
      const hasPresent = /\bpresent\b/i.test(t);
      const hasRange = /[-–]/.test(t);
      const hasDuration = /\b(mos|yr|yrs|month|months|year|years)\b/i.test(t);
      if (hasPresent && (hasYear || hasMonth)) return true;
      if (/\d{4}\s*[-–]\s*(\d{4}|present)\b/i.test(t)) return true;
      if (hasMonth && hasYear && (hasRange || hasDuration || hasPresent)) return true;
      if (hasYear && hasDuration) return true;
      return false;
    };

    const scoreDateLine = (t) => {
      if (!isDateLine(t)) return -1;
      let score = t.length;
      if (/\bpresent\b/i.test(t)) score += 30;
      if (/-/.test(t)) score += 20;
      if (/\b(yr|yrs|mos|month|year)\b/i.test(t)) score += 15;
      if (/·/.test(t)) score += 5;
      return score;
    };

    const findDateLine = (root, fallbackLines = []) => {
      /** @type {{ t: string, score: number }[]} */
      const candidates = [];
      for (const p of root.querySelectorAll('p')) {
        if (p.closest('ul')) continue;
        const t = norm(p.innerText);
        const score = scoreDateLine(t);
        if (score > 0) candidates.push({ t, score });
      }
      for (const span of root.querySelectorAll('span[aria-hidden="true"]')) {
        const t = norm(span.textContent);
        const score = scoreDateLine(t);
        if (score > 0) candidates.push({ t, score });
      }
      for (const l of fallbackLines) {
        const score = scoreDateLine(l);
        if (score > 0) candidates.push({ t: l, score });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0].t;
    };

    const isBadExperienceLine = (t) =>
      /^(contact info|education|skills|about|recommendations|activity|licenses|certifications)$/i.test(
        t,
      ) || /\b(school|university|college|institute|academy)\b/i.test(t);

    const isLikelyJobTitle = (t) => {
      if (isJunkLine(t)) return false;
      if (t.length > 200) return false;
      if (isDateLine(t)) return false;
      if (isBadExperienceLine(t)) return false;
      if (/\s\·\s/.test(t) && /(full-time|part-time|internship|contract|self-employed|freelance)/i.test(t)) {
        return false;
      }
      return true;
    };

    const isLocationLine = (t) => {
      if (isJunkLine(t)) return false;
      if (t.length > 80) return false;
      if (/\./.test(t)) return false;
      if (isDateLine(t)) return false;
      if (/\b(responsible|achieved|leading|leveraging|key|skills?|managing)\b/i.test(t)) return false;
      return (
        t.includes(',') ||
        /\bremote\b/i.test(t) ||
        /·\s*(remote|hybrid|on[-\s]?site|office)/i.test(t)
      );
    };

    /** Split a company line like "Company Name · Full-time" → { company, employmentType }. */
    const splitCompanyLine = (line) => {
      if (!line) return { company: null, employmentType: null };
      const parts = line.split('·').map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return { company: null, employmentType: null };
      const company = parts[0];
      const employmentType = parts.length > 1 ? parts.slice(1).join(' · ') : null;
      return { company, employmentType };
    };

    const getExperienceScope = () => {
      const fromAnchor = (start) => {
        if (!start) return null;
        return (
          start.closest('section') ||
          start.parentElement?.parentElement ||
          start.parentElement ||
          document.querySelector('main')
        );
      };
      const anchor = document.querySelector('#experience');
      if (anchor) return fromAnchor(anchor);
      const h2 = [...document.querySelectorAll('h2, h3')].find((h) =>
        /^experience$/i.test(norm(h.innerText || h.textContent)),
      );
      if (h2) return fromAnchor(h2);
      return document.querySelector('main') || document.body;
    };

    const scope = getExperienceScope();
    if (!scope) return null;

    // 1. Try inner-anchor pattern first (a[href*="/company/"] holds title +
    //    "Company · Full-time" + dates). Any company is fine.
    for (const a of scope.querySelectorAll('a[href*="/company/"]')) {
      const ps = [...a.querySelectorAll('p, span[aria-hidden="true"]')]
        .filter((n) => !n.closest('ul') && !n.closest('figure'))
        .map((n) => norm(n.innerText || n.textContent))
        .filter(Boolean);
      if (ps.length < 2) continue;
      const companyLine = ps.find((t) => /·/.test(t) && t.length < 80);
      const dates = ps.find((t) => isDateLine(t));
      if (!companyLine && !dates) continue;
      const used = new Set([companyLine, dates].filter(Boolean));
      const title =
        ps.find((t) => !used.has(t) && isLikelyJobTitle(t)) ||
        ps.find((t) => !used.has(t) && !isJunkLine(t)) ||
        null;
      const split = splitCompanyLine(companyLine);
      const company = split.company || norm(a.textContent).split('·')[0] || null;
      if (!company || isBadExperienceLine(company)) continue;
      return {
        company,
        employmentType: split.employmentType,
        location: null,
        roles: [{ title, dates: dates || null, description: null }],
        companyUrl: a.getAttribute('href'),
      };
    }

    // 2. Fallback: first <a href="/company/…"> + climb to a card with 3+ <p>.
    const firstLink = scope.querySelector('a[href*="/company/"]');
    if (!firstLink) return null;
    let card = firstLink;
    let bestCard = null;
    for (let i = 0; i < 14 && card; i += 1) {
      const ps = [...card.querySelectorAll('p, span[aria-hidden="true"]')].filter(
        (n) => !n.closest('ul'),
      );
      const uniq = new Set(ps.map((n) => norm(n.innerText || n.textContent)).filter(Boolean));
      if (uniq.size >= 3) {
        bestCard = card;
        break;
      }
      card = card.parentElement;
    }
    if (!bestCard) bestCard = firstLink.closest('li, div');
    if (!bestCard) return null;

    const lines = [
      ...[...bestCard.querySelectorAll('p, span[aria-hidden="true"]')]
        .filter((n) => !n.closest('ul'))
        .map((n) => norm(n.innerText || n.textContent))
        .filter((t) => t && !isJunkLine(t) && t.length < 500),
    ];
    if (!lines.length) return null;

    const companyLine = lines.find((t) => /·/.test(t) && t.length < 80);
    const split = splitCompanyLine(companyLine);
    const company =
      split.company ||
      norm(firstLink.textContent).split('·')[0]?.trim() ||
      null;
    if (!company || isBadExperienceLine(company)) return null;

    const dates = findDateLine(bestCard, lines) || null;
    const location = lines.find((t) => t !== dates && isLocationLine(t)) || null;
    const used = new Set([companyLine, dates, location].filter(Boolean));
    const title =
      lines.find((t) => !used.has(t) && isLikelyJobTitle(t)) ||
      lines.find((t) => !used.has(t) && !isJunkLine(t)) ||
      null;

    return {
      company,
      employmentType: split.employmentType,
      location,
      roles: [{ title, dates, description: null }],
      companyUrl: firstLink.getAttribute('href'),
    };
  });
}

/** @param {CompanyExperience | null | undefined} motive */
export function isValidMotiveExperience(motive) {
  if (!motive?.company) return false;
  const badTitle = /^(contact info|education|skills|about|recommendations|activity)$/i;
  const badWord = /\b(school|university|college|institute|academy|economics|contact info)\b/i;
  if (motive.employmentType && badWord.test(motive.employmentType)) return false;
  for (const r of motive.roles || []) {
    if (r.title && (badTitle.test(r.title) || badWord.test(r.title))) return false;
  }
  if (motive.companyUrl) return true;
  const roles = motive.roles || [];
  if (roles.some((r) => r.dates || r.title)) return true;
  return Boolean(motive.employmentType || motive.location);
}

/** @param {CompanyExperience | null} motive */
export function companyExperienceToRecords(motive) {
  if (!motive) return [];
  if (motive.roles?.length) {
    return motive.roles.map((r) => ({
      title: r.title,
      company: motive.company,
      dates: r.dates,
      location: motive.location,
      description: r.description,
    }));
  }
  return [
    {
      title: null,
      company: motive.company,
      dates: motive.employmentType,
      location: motive.location,
      description: null,
    },
  ];
}

/**
 * @typedef {object} PresentExperience
 * @property {string | null} title
 * @property {string | null} company
 * @property {string | null} employmentType
 * @property {string | null} dates
 * @property {string | null} location
 */

/**
 * Find the Experience card via a <p> containing "Present" or "Full-time", then
 * parse role, company, and dates from sibling <p> nodes in the same card.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<PresentExperience | null>}
 */
/**
 * @param {import('puppeteer').Page} page
 * @param {{ skipScroll?: boolean }} [opts]
 */
export async function scrapePresentExperienceFromPage(page, opts = {}) {
  if (!opts.skipScroll) {
    await scrollToExperienceSection(page);
  }
  await expandExperienceSection(page);
  await sleep(randomBetween(400, 700));

  return page.evaluate(() => {
    const getExperienceRoot = () => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

      /** @returns {Element | null} */
      const findExperienceHeading = () => {
        for (const h2 of document.querySelectorAll('h2')) {
          const t = norm(h2.innerText || h2.textContent || '');
          if (/^experience$/i.test(t)) return h2;
        }
        for (const h3 of document.querySelectorAll('h3')) {
          const t = norm(h3.innerText || h3.textContent || '');
          if (/^experience$/i.test(t)) return h3;
        }
        return document.querySelector('#experience');
      };

      const heading = findExperienceHeading();
      if (!heading) return null;

      let section = heading.parentElement;
      for (let i = 0; i < 12 && section; i += 1) {
        if (
          section.querySelector('a[href*="/company/"]') ||
          section.querySelectorAll('p').length >= 2
        ) {
          return section;
        }
        section = section.parentElement;
      }

      return (
        heading.closest('section') ||
        heading.parentElement?.parentElement ||
        heading.parentElement
      );
    };

    /** @param {Document | Element} searchRoot */
    const parseInScope = (searchRoot) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const isJunkLine = (t) => !t || /^[·•\s]+$/.test(t) || t.length < 2;

    const isProse = (t) =>
      /\b(responsible|achieved|leading|leveraging|pipeline|quota)\b/i.test(t) && t.length > 80;

    /** Required date pattern: "Present" AND a dash (e.g. May 2026 - Present · 1 mo). */
    const isPresentWithDash = (t) => {
      if (!t || t.length > 220 || isProse(t)) return false;
      return /\bpresent\b/i.test(t) && /[-–]/.test(t);
    };

    /** Card locator: Motive · Full-time line. */
    const isFullTimeLine = (t) => {
      if (!t || t.length > 120 || isProse(t)) return false;
      return /\bfull-time\b/i.test(t);
    };

    const isAnchorLine = (t) => isPresentWithDash(t) || isFullTimeLine(t);

    const isLocationLine = (t) => {
      if (isJunkLine(t) || t.length > 90) return false;
      if (/\./.test(t)) return false;
      if (/\bpresent\b/i.test(t)) return false;
      if (/\b(responsible|achieved|leading|leveraging|managing|prospect)\b/i.test(t)) return false;
      return (
        t.includes(',') ||
        /\bremote\b/i.test(t) ||
        /·\s*(remote|hybrid|on[-\s]?site|office)/i.test(t)
      );
    };

    const isEmploymentHeader = (t) =>
      /^(full-time|part-time|contract|internship|self-employed|freelance)$/i.test(t) ||
      (/full-time|part-time|contract|internship|self-employed|freelance/i.test(t) &&
        t.length < 45 &&
        !/^motive\s*·/i.test(t));

    const matchesMotiveText = (text) =>
      /motive|keeptruckin|3271606/i.test((text || '').toLowerCase());
    const matchesMotiveHref = (href) =>
      /3271606|motive-inc|keeptruckin/i.test((href || '').toLowerCase());
    const matchesMotive = (text, href = '') => matchesMotiveText(text) || matchesMotiveHref(href);

    const splitCompanyLine = (line) => {
      if (!line || !line.includes('·')) return { company: null, employmentType: null };
      const parts = line.split('·').map((p) => norm(p)).filter(Boolean);
      return { company: parts[0] || null, employmentType: parts.slice(1).join(' · ') || null };
    };

    const isLikelyJobTitle = (t) => {
      if (isJunkLine(t) || t.length > 120) return false;
      if (/\bpresent\b/i.test(t)) return false;
      if (isLocationLine(t)) return false;
      if (isEmploymentHeader(t)) return false;
      if (/^motive\s*·/i.test(t)) return false;
      if (/\b(school|university|college|institute|academy)\b/i.test(t)) return false;
      return true;
    };

    /** @param {Element} start */
    const findCardRoot = (start) => {
      let el = start;
      for (let depth = 0; depth < 16 && el; depth += 1) {
        if (el.getAttribute?.('componentkey')?.includes('entity-collection-item')) return el;
        if (el.classList?.contains('pvs-entity')) return el;
        if (el.classList?.contains('artdeco-list__item')) return el;
        const ps = [...el.querySelectorAll('p')].filter((p) => !p.closest('ul li ul'));
        if (ps.length >= 3) return el;
        el = el.parentElement;
      }
      return start.parentElement || start;
    };

    /** @param {Element} root */
    const collectLines = (root) => {
      /** @type {string[]} */
      const lines = [];
      const seen = new Set();
      const push = (el) => {
        if (isInsideBlockedSection(el)) return;
        if (el.closest('ul li ul')) return;
        if (el.closest('[data-testid="expandable-text-box"]')) return;
        const t = norm(el.innerText || el.textContent || '');
        if (t && !seen.has(t) && !isJunkLine(t) && t.length < 500) {
          seen.add(t);
          lines.push(t);
        }
      };
      root.querySelectorAll('p').forEach(push);
      root.querySelectorAll('span[aria-hidden="true"]').forEach(push);
      return lines;
    };

    /**
     * LinkedIn often nests Motive · Full-time + dates inside one company <a>.
     * @returns {ReturnType<typeof buildResult> | null}
     */
    const parseFromMotiveCompanyAnchor = () => {
      const buildResult = (title, company, employmentType, dates, location) => ({
        title,
        company: company || 'Motive',
        employmentType,
        dates,
        location,
      });

      for (const a of searchRoot.querySelectorAll('a[href*="/company/"]')) {
        const href = a.getAttribute('href') || '';
        if (!matchesMotive('', href)) continue;

        const texts = [...a.querySelectorAll('p, span[aria-hidden="true"]')]
          .filter((n) => !n.closest('ul li ul') && !n.closest('[data-testid="expandable-text-box"]'))
          .map((n) => norm(n.innerText || n.textContent || ''))
          .filter((t) => t && !isJunkLine(t));

        if (!texts.length) continue;

        const dates = texts.find((t) => isPresentWithDash(t)) || null;
        const companyLine =
          texts.find((t) => /^motive\s*·/i.test(t) || (t.includes('·') && isFullTimeLine(t))) ||
          null;
        let company = 'Motive';
        let employmentType = null;
        if (companyLine) {
          const split = splitCompanyLine(companyLine);
          company = split.company || 'Motive';
          employmentType = split.employmentType;
        }

        const used = new Set([dates, companyLine].filter(Boolean));
        const title = texts.find((t) => !used.has(t) && isLikelyJobTitle(t)) || null;

        if (dates || (companyLine && employmentType)) {
          return buildResult(title, company, employmentType, dates, null);
        }

        let container = a;
        for (let i = 0; i < 10 && container; i += 1) {
          const outer = collectLines(container);
          const outerDates = outer.find((t) => isPresentWithDash(t));
          if (outerDates) {
            const outerCompany = outer.find(
              (t) => t.includes('·') && (isFullTimeLine(t) || /^motive\s*·/i.test(t)),
            );
            let oc = 'Motive';
            let et = null;
            if (outerCompany) {
              const split = splitCompanyLine(outerCompany);
              oc = split.company || 'Motive';
              et = split.employmentType;
            }
            const used2 = new Set([outerDates, outerCompany].filter(Boolean));
            const ot = outer.find((t) => !used2.has(t) && isLikelyJobTitle(t)) || title;
            return buildResult(ot, oc, et, outerDates, null);
          }
          container = container.parentElement;
        }
      }
      return null;
    };

    const fromAnchor = parseFromMotiveCompanyAnchor();
    if (fromAnchor?.dates) return fromAnchor;

    /** @type {{ el: Element, text: string, score: number }[]} */
    const hits = [];
    const seenText = new Set();

    const isInsideBlockedSection = (el) => {
      for (const h of document.querySelectorAll('h2, h3')) {
        const label = norm(h.textContent);
        if (!/^(activity|posts|recent activity)$/i.test(label)) continue;
        const block = h.closest('section') || h.parentElement?.parentElement || h.parentElement;
        if (block?.contains(el)) return true;
      }
      if (el.closest?.('a[href*="feed/update"], a[href*="urn:li:activity"]')) return true;
      return false;
    };

    /** @param {Element} el @param {number} tagBonus */
    const consider = (el, tagBonus) => {
      if (isInsideBlockedSection(el)) return;
      if (el.closest('[data-testid="expandable-text-box"]')) return;
      if (el.closest('ul li ul')) return;
      const t = norm(el.innerText || el.textContent || '');
      if (!isAnchorLine(t) || seenText.has(t)) return;
      seenText.add(t);

      let score = 20 + tagBonus;
      if (el.tagName === 'P') score += 40;
      if (isPresentWithDash(t)) score += 70;
      if (isFullTimeLine(t)) score += 50;
      if (/^motive\s*·\s*full-time/i.test(t)) score += 40;
      if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t)) score += 50;
      if (/\b(19|20)\d{2}\b/.test(t)) score += 40;
      if (/[-–]/.test(t)) score += 30;
      if (/·/.test(t)) score += 20;
      if (/\b(yr|yrs|mos|month|months|year|years)\b/i.test(t)) score += 15;

      let cur = el;
      for (let i = 0; i < 14 && cur; i += 1) {
        if (
          cur.querySelector?.(
            'a[href*="/company/3271606"], a[href*="/company/motive-inc"], a[href*="/company/keeptruckin"]',
          )
        ) {
          score += 80;
          break;
        }
        if (cur.querySelector?.('img[alt*="Motive" i], svg[aria-label*="Motive" i]')) {
          score += 60;
          break;
        }
        cur = cur.parentElement;
      }
      hits.push({ el, text: t, score });
    };

    for (const p of searchRoot.querySelectorAll('p')) consider(p, 0);
    for (const span of searchRoot.querySelectorAll('span[aria-hidden="true"]')) consider(span, -5);

    if (!hits.length) return null;
    hits.sort((a, b) => b.score - a.score);

    const best = hits[0];
    const card = findCardRoot(best.el);
    const lines = collectLines(card);

    const companyLink = [...card.querySelectorAll('a[href*="/company/"]')][0];
    const href = companyLink?.getAttribute('href') || '';

    let company = matchesMotiveHref(href) ? 'Motive' : null;
    let employmentType = null;
    const companyLine = lines.find(
      (l) =>
        l.includes('·') &&
        !isPresentWithDash(l) &&
        (matchesMotiveText(l) || /^motive\s*·/i.test(l) || /\bfull-time\b/i.test(l)),
    );
    if (companyLine) {
      const split = splitCompanyLine(companyLine);
      company = split.company || company;
      employmentType = split.employmentType;
    } else if (/\bfull-time\b/i.test(best.text)) {
      const split = splitCompanyLine(best.text);
      company = split.company || (matchesMotiveText(best.text) ? 'Motive' : null);
      employmentType = split.employmentType || 'Full-time';
    } else {
      const plainCompany = lines.find((l) => matchesMotiveText(l) && l.length < 80);
      if (plainCompany) company = plainCompany.replace(/\s*·.*$/, '').trim() || 'Motive';
    }

    if (!employmentType && /\bfull-time\b/i.test(best.text)) {
      employmentType = 'Full-time';
    }

    const dates =
      (isPresentWithDash(best.text) ? best.text : null) ||
      lines.find((l) => isPresentWithDash(l)) ||
      null;

    const used = new Set([best.text, dates, companyLine].filter(Boolean));
    const location = lines.find((l) => !used.has(l) && isLocationLine(l)) || null;
    if (location) used.add(location);

    const title = lines.find((l) => !used.has(l) && isLikelyJobTitle(l)) || null;

    if (dates) {
      return {
        title,
        company: company || 'Motive',
        employmentType,
        dates,
        location,
      };
    }

    if (fromAnchor) return fromAnchor;

    if (employmentType && (title || companyLine)) {
      return {
        title,
        company: company || 'Motive',
        employmentType,
        dates: null,
        location,
      };
    }

    return null;
    };

    const experienceRoot = getExperienceRoot();
    if (!experienceRoot) return null;
    return parseInScope(experienceRoot);
  });
}

/**
 * Find the employment date line by scanning <p> tags that contain "Present".
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string | null>}
 */
export async function scrapePresentDateFromPage(page) {
  const exp = await scrapePresentExperienceFromPage(page);
  return exp?.dates ?? null;
}

/**
 * @param {PersonRecord} person
 * @param {PresentExperience | null | undefined} exp
 */
export function applyPresentExperienceToPerson(person, exp) {
  if (!exp || (!exp.dates && !exp.title && !exp.employmentType)) return;

  const company = exp.company || config.targetCompanyName;
  const prev = person.experiences?.[0];

  person.experiences = [
    {
      title: exp.title || prev?.title || null,
      company,
      dates: exp.dates || prev?.dates || null,
      location: exp.location || prev?.location || null,
      description: prev?.description || null,
    },
  ];

  const isMotive = config.targetCompanyAliases.some(
    (a) => company.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes('motive'),
  );
  if (isMotive || /motive/i.test(company)) {
    person.motiveExperience = {
      company,
      employmentType: exp.employmentType || person.motiveExperience?.employmentType || null,
      location: exp.location || person.motiveExperience?.location || null,
      roles: [
        {
          title: exp.title || person.motiveExperience?.roles?.[0]?.title || null,
          dates: exp.dates || person.motiveExperience?.roles?.[0]?.dates || null,
          description: person.motiveExperience?.roles?.[0]?.description || null,
        },
      ],
    };
  }

  person.profileEnriched = true;
}

/** @param {CompanyExperience | null | undefined} motive @param {string | null} presentDate */
export function applyPresentDateToMotive(motive, presentDate) {
  if (!presentDate || !motive) return motive;
  if (!motive.roles?.length) {
    motive.roles = [{ title: null, dates: presentDate, description: null }];
    return motive;
  }
  if (!motive.roles[0].dates) {
    motive.roles[0] = { ...motive.roles[0], dates: presentDate };
  }
  return motive;
}

export async function expandExperienceSection(page) {
  try {
    const clicked = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const findExperienceHeading = () => {
        for (const h2 of document.querySelectorAll('h2')) {
          if (/^experience$/i.test(norm(h2.textContent))) return h2;
        }
        return document.querySelector('#experience');
      };
      const heading = findExperienceHeading();
      if (!heading) return false;

      let root = heading.parentElement;
      for (let i = 0; i < 10 && root; i += 1) {
        if (root.querySelector('a[href*="/company/"]') || root.querySelectorAll('p').length >= 2) {
          break;
        }
        root = root.parentElement;
      }
      root = root || heading.parentElement;
      if (!root) return false;

      const buttons = [...root.querySelectorAll('button')];
      const expand = buttons.find((el) => {
        const t = norm(el.innerText || el.textContent);
        return /show all \d+ experiences|see all experiences|show all experience/i.test(t);
      });
      if (expand) {
        expand.click();
        return true;
      }
      return false;
    });
    if (clicked) await sleep(randomBetween(800, 1200));
  } catch {
    /* ignore */
  }
}

/**
 * Parse experience list from current profile or /details/experience/ page.
 * @param {import('puppeteer').Page} page
 */
/** @param {string} profileUrl */
export function experienceDetailsUrl(profileUrl) {
  return profileUrl.replace(/\/?$/, '/details/experience/');
}

export async function scrapeExperiencesFromPage(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    /** @type {ExperienceRecord[]} */
    const experiences = [];
    const seen = new Set();

    const add = (title, company, dates, location, description) => {
      const t = norm(title);
      if (!t || t.length < 2) return;
      if (/^(experience|show all|see all)/i.test(t)) return;
      const key = `${t}|${norm(company)}|${norm(dates)}`;
      if (seen.has(key)) return;
      seen.add(key);
      experiences.push({
        title: t,
        company: norm(company) || null,
        dates: norm(dates) || null,
        location: norm(location) || null,
        description: norm(description)?.slice(0, 2000) || null,
      });
    };

    document.querySelectorAll('main li').forEach((li) => {
      const spans = [...li.querySelectorAll('span[aria-hidden="true"]')]
        .map((s) => norm(s.textContent))
        .filter((t) => t.length > 1);
      if (spans.length < 2) return;
      const dates =
        spans.find((s) => /\b(19|20)\d{2}|present/i.test(s) && s.length < 90) || spans[2] || null;
      add(spans[0], spans[1], dates, null, spans.slice(3).join(' ') || null);
    });

    document
      .querySelectorAll('.pvs-entity, li.pvs-list__paged-list-item, li.artdeco-list__item')
      .forEach((entity) => {
        const titleEl = entity.querySelector(
          '.t-bold span[aria-hidden="true"], .hoverable-link-text span[aria-hidden="true"], a[data-field="experience_title"] span[aria-hidden="true"]',
        );
        const companyEl = entity.querySelector(
          '.t-14.t-normal span[aria-hidden="true"], .t-black--light span[aria-hidden="true"], a[data-field="experience_company"] span[aria-hidden="true"]',
        );
        const dateEl = entity.querySelector(
          '.pvs-entity__caption-wrapper span[aria-hidden="true"], .t-14.t-normal.t-black--light span[aria-hidden="true"]',
        );
        const title = titleEl?.textContent || '';
        const company = companyEl?.textContent || '';
        const dates = dateEl?.textContent || '';
        if (title && (company || dates)) {
          add(title, company, dates, null, null);
          return;
        }

        const lines = (entity.innerText || '')
          .split('\n')
          .map(norm)
          .filter((l) => l && !/^experience$/i.test(l));
        if (lines.length < 2) return;
        const datesLine =
          lines.find((l) =>
            /\b(19|20)\d{2}|present|yr|mos/i.test(l),
          ) || null;
        add(lines[0], lines[1], datesLine, null, null);
      });

    return experiences;
  });
}

/**
 * Scrape full profile: fullName, title (headline), about, all experiences.
 * @param {import('puppeteer').Page} page
 */
export async function extractProfileDetails(page) {
  const profileUrl = page.url().split('?')[0].replace(/\/$/, '');

  await expandExperienceSection(page);

  const base = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

    /** @param {string} label */
    const findSection = (label) => {
      const re = new RegExp(`^\\s*${label}\\s*$`, 'i');
      const anchor = document.querySelector(`#${label.toLowerCase()}`);
      if (anchor) {
        return anchor.closest('section') || anchor.parentElement;
      }
      for (const h of document.querySelectorAll('h2, h3')) {
        const headingText = norm(h.innerText || h.textContent || '');
        if (re.test(headingText)) {
          return h.closest('section') || h.parentElement;
        }
      }
      return null;
    };

    let fullName =
      norm(document.querySelector('h1.text-heading-xlarge')?.innerText) ||
      norm(document.querySelector('main h1')?.innerText) ||
      norm(document.querySelector('h1')?.innerText) ||
      '';

    let title = null;
    const topCard =
      document.querySelector('section.pv-top-card') ||
      document.querySelector('main section') ||
      document.querySelector('main');
    if (topCard) {
      for (const el of topCard.querySelectorAll('.text-body-medium, [data-generated-suggestion-target]')) {
        const t = norm(el.innerText || el.textContent);
        if (
          t &&
          t !== fullName &&
          t.length < 320 &&
          !/^\d+(\.\d+)?\s*(followers|connections)/i.test(t) &&
          !/^provides services/i.test(t)
        ) {
          title = t;
          break;
        }
      }
    }

    return { fullName, title };
  });

  const about = await scrapeProfileAbout(page);

  let experiences = await scrapeExperiencesFromPage(page);

  if (!experiences.length && profileUrl.includes('/in/')) {
    try {
      await page.goto(`${profileUrl}/details/experience/`, {
        waitUntil: 'domcontentloaded',
        timeout: config.navigationTimeoutMs,
      });
      await sleep(randomBetween(1200, 2000));
      await expandExperienceSection(page);
      experiences = await scrapeExperiencesFromPage(page);
    } catch {
      /* keep empty */
    }
  }

  return { ...base, about, experiences };
}

/**
 * @param {PersonRecord} person
 * @param {Awaited<ReturnType<typeof extractProfileDetails>>} details
 */
export function applyProfileDetails(person, details) {
  if (details.fullName) {
    person.fullName = details.fullName;
    person.name = details.fullName;
  }
  if (details.title) person.title = details.title;
  if (details.about && (!person.about || details.about.length >= (person.about || '').length)) {
    person.about = details.about;
  }
  if (details.motiveExperience) {
    person.motiveExperience = details.motiveExperience;
    person.experiences = companyExperienceToRecords(details.motiveExperience);
  } else if (details.experiences?.length) {
    person.experiences = details.experiences;
  } else if (!person.experiences?.length) {
    const fallbackTitle =
      person.title || person.about || person.company1 || null;
    person.experiences = [
      {
        title: fallbackTitle,
        company: config.targetCompanyName,
        dates: null,
        location: null,
        description: null,
      },
    ];
  }
  if (details.presentExp) {
    applyPresentExperienceToPerson(person, details.presentExp);
  } else {
    const presentDate =
      details.presentDate ||
      details.motiveExperience?.roles?.[0]?.dates ||
      null;
    if (presentDate && person.experiences?.length && !person.experiences[0].dates) {
      person.experiences[0] = { ...person.experiences[0], dates: presentDate };
    }
    if (presentDate && person.motiveExperience?.roles?.length && !person.motiveExperience.roles[0].dates) {
      person.motiveExperience.roles[0] = {
        ...person.motiveExperience.roles[0],
        dates: presentDate,
      };
    }
  }

  // Keep only the latest experience row.
  if (person.experiences?.length > 1) {
    person.experiences = [person.experiences[0]];
  }
  person.profileEnriched = true;
}

function createAsyncMutex() {
  let chain = Promise.resolve();
  return {
    /** @param {() => Promise<void>} fn */
    run(fn) {
      const next = chain.then(fn, fn);
      chain = next.catch(() => {});
      return next;
    },
  };
}

/**
 * Enrich one profile on an open tab.
 * @param {import('puppeteer').Page} page
 * @param {PersonRecord} person
 */
async function enrichOneProfile(page, person) {
  await page.goto(person.profileUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs,
  });
  await sleep(config.profileLoadWaitMs ?? 5000);

  if (await detectSessionWall(page)) {
    throw new SessionWallError('Session lost while opening profiles. Run npm run login again.');
  }

  const base = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const fullName =
      norm(document.querySelector('h1')?.innerText) ||
      norm(document.querySelector('main h1')?.innerText) ||
      '';
    let title = null;
    for (const el of document.querySelectorAll('.text-body-medium, [data-generated-suggestion-target]')) {
      const t = norm(el.innerText);
      if (t && t !== fullName && t.length < 320 && !/followers|connections/i.test(t)) {
        title = t;
        break;
      }
    }
    return { fullName, title };
  });

  const about = await scrapeProfileAbout(page);

  /** @type {CompanyExperience | null} */
  let motiveExperience = null;

  await waitForMotiveBlock(page, 15_000);
  try {
    motiveExperience = await scrapeCompanyExperience(page);
  } catch {
    /* keep null */
  }

  // If nothing found, try the dedicated /details/experience/ page (safe navigation).
  if (!isValidMotiveExperience(motiveExperience)) {
    motiveExperience = null;
    try {
      await page.goto(experienceDetailsUrl(person.profileUrl), {
        waitUntil: 'domcontentloaded',
        timeout: config.navigationTimeoutMs,
      });
      await page
        .waitForSelector(
          'main, #experience, [componentkey*="entity-collection-item"], li.pvs-list__paged-list-item, .pvs-entity, li.artdeco-list__item',
          { timeout: 15_000 },
        )
        .catch(() => {});
      await waitForMotiveBlock(page, 10_000);
      await sleep(randomBetween(config.profileNavigationMinMs, config.profileNavigationMaxMs));
      motiveExperience = await scrapeCompanyExperience(page);
    } catch {
      /* keep null */
    }
  }

  if (!isValidMotiveExperience(motiveExperience)) motiveExperience = null;

  // Final fallback: capture the top-most experience card regardless of company
  // so the row is never empty. Runs only when Motive parsing returned nothing.
  if (!motiveExperience) {
    try {
      const generic = await scrapeFirstExperienceCard(page);
      if (generic && generic.company) motiveExperience = generic;
    } catch {
      /* ignore */
    }
  }

  /** @type {PresentExperience | null} */
  let presentExp = null;
  try {
    const onDetails = /\/details\//i.test(page.url());
    if (onDetails) {
      await page.goto(person.profileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.navigationTimeoutMs,
      });
      await sleep(randomBetween(config.profileNavigationMinMs, config.profileNavigationMaxMs));
    }
    presentExp = await scrapePresentExperienceFromPage(page);
    if (!presentExp?.dates) {
      await page.goto(experienceDetailsUrl(person.profileUrl), {
        waitUntil: 'domcontentloaded',
        timeout: config.navigationTimeoutMs,
      });
      await sleep(randomBetween(2000, 3500));
      presentExp = await scrapePresentExperienceFromPage(page);
    }
  } catch {
    /* ignore */
  }

  if (presentExp?.dates && motiveExperience) {
    motiveExperience = applyPresentDateToMotive(motiveExperience, presentExp.dates);
    if (presentExp.title && motiveExperience.roles?.[0]) {
      motiveExperience.roles[0] = { ...motiveExperience.roles[0], title: presentExp.title };
    }
  }

  return {
    ...base,
    about: about || person.about || null,
    motiveExperience,
    presentExp,
    presentDate: presentExp?.dates ?? null,
    experiences: [],
  };
}

/**
 * Visit profile URLs and enrich records (parallel tabs when parallelTabs > 1).
 * @param {import('puppeteer').Browser} browser
 * @param {Map<string, PersonRecord>} map
 * @param {Awaited<ReturnType<typeof createIncrementalWriter>>} writer
 * @param {{ startIndex?: number, endIndex?: number, batchNum?: number }} [range]
 * @param {{ parallelTabs?: number }} [options]
 */
export async function enrichProfilesFromPages(browser, map, writer, range = {}, options = {}) {
  const all = [...map.entries()];
  const start = range.startIndex ?? 0;
  const end = range.endIndex ?? all.length;
  const entries = all.slice(start, end);
  const toEnrich = entries.filter(([, person]) => {
    const hasDates =
      person.motiveExperience?.roles?.[0]?.dates || person.experiences?.[0]?.dates;
    return (
      !person.profileEnriched ||
      !isValidMotiveExperience(person.motiveExperience) ||
      !hasDates
    );
  });

  const parallelTabs = Math.min(
    Math.max(1, options.parallelTabs ?? config.parallelTabs),
    config.parallelTabsMax,
  );

  if (range.batchNum) {
    logger.info(`Enriching batch ${range.batchNum}: ${toEnrich.length} profile(s)`, {
      from: start + 1,
      to: end,
      total: all.length,
      parallelTabs,
    });
  } else {
    logger.info(`Enriching ${toEnrich.length} profile(s)`, { parallelTabs });
  }

  if (!toEnrich.length) return;

  const saveMutex = createAsyncMutex();
  let completed = 0;
  let nextIndex = 0;

  const writeMetaProgress = () =>
    writer.writeMeta({
      updatedAt: new Date().toISOString(),
      phase: 'profile-enrichment',
      parallelTabs,
      enrichedCount: [...map.values()].filter((p) => p.profileEnriched).length,
      totalUniquePeople: map.size,
      jsonlPath: writer.jsonlPath,
      csvPath: writer.csvPath,
      jsonPath: writer.jsonPath,
    });

  /** @param {{ ref: import('puppeteer').Page }} pageRef @param {number} workerId */
  const worker = async (pageRef, workerId) => {
    while (true) {
      const i = nextIndex++;
      if (i >= toEnrich.length) break;

      const [key, person] = toEnrich[i];

      logger.info(`[tab ${workerId}] Enriching ${i + 1}/${toEnrich.length}`, {
        profileUrl: person.profileUrl,
      });

      try {
        const details = await enrichOneProfile(pageRef.ref, person);

        if (details.motiveExperience) {
          logger.info(`[tab ${workerId}] Found ${config.targetCompanyName} experience`, {
            profileUrl: person.profileUrl,
            dates: details.motiveExperience.roles?.[0]?.dates ?? details.presentDate ?? null,
          });
        } else if (details.presentExp?.dates || details.presentDate) {
          logger.info(`[tab ${workerId}] Present experience from page`, {
            profileUrl: person.profileUrl,
            title: details.presentExp?.title ?? null,
            dates: details.presentExp?.dates ?? details.presentDate ?? null,
          });
        } else {
          logger.info(`[tab ${workerId}] No Motive experience parsed`, {
            profileUrl: person.profileUrl,
          });
        }

        await saveMutex.run(async () => {
          applyProfileDetails(person, details);
          map.set(key, person);
          await writer.upsertPerson(person);
        });

        completed += 1;
        if (completed % 5 === 0 || completed === toEnrich.length) {
          await writeMetaProgress();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[tab ${workerId}] Profile enrich failed`, {
          profileUrl: person.profileUrl,
          message,
        });
        if (err instanceof SessionWallError) {
          throw err;
        }
        // Recover from detached/closed frame by replacing the tab.
        if (/detached frame|target closed|context.*destroyed/i.test(message)) {
          logger.info(`[tab ${workerId}] Replacing crashed tab…`);
          try {
            await pageRef.ref.close();
          } catch {
            /* ignore */
          }
          let reopened = false;
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              pageRef.ref = await browser.newPage();
              await preparePage(pageRef.ref);
              await sleep(randomBetween(800, 1500));
              reopened = true;
              break;
            } catch (newErr) {
              logger.warn(`[tab ${workerId}] Tab reopen attempt ${attempt}/3 failed`, {
                message: newErr instanceof Error ? newErr.message : String(newErr),
              });
              await sleep(randomBetween(1500, 3000));
            }
          }
          if (!reopened) {
            logger.warn(`[tab ${workerId}] Skipping profile after tab crash; continuing worker`);
          }
        }
      }

      await sleep(randomBetween(config.profileDelayMinMs, config.profileDelayMaxMs));
    }
  };

  /** @type {{ ref: import('puppeteer').Page }[]} */
  const pageRefs = [];
  try {
    for (let t = 0; t < parallelTabs; t += 1) {
      if (t > 0) {
        await sleep(t * config.parallelTabStaggerMs + randomBetween(500, 1500));
      }
      try {
        const p = await browser.newPage();
        await preparePage(p);
        pageRefs.push({ ref: p });
      } catch (err) {
        logger.warn(`Failed to open worker tab #${t + 1}, continuing with ${pageRefs.length}`, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!pageRefs.length) {
      throw new Error('Could not open any worker tab for enrichment');
    }

    const results = await Promise.allSettled(
      pageRefs.map((pageRef, idx) => worker(pageRef, idx + 1)),
    );
    const fatal = results.find(
      (r) => r.status === 'rejected' && r.reason instanceof SessionWallError,
    );
    if (fatal && fatal.status === 'rejected') throw fatal.reason;
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.warn('Worker tab terminated', {
          message: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
    await writeMetaProgress();
  } finally {
    for (const pageRef of pageRefs) {
      await pageRef.ref?.close().catch(() => {});
    }
  }
}

/**
 * Scroll the People listing until the map grows by up to `targetAdditional` people.
 * @returns {Promise<{ collected: number, exhausted: boolean }>}
 */
async function collectListingBatch(page, map, writer, url, targetAdditional) {
  const startSize = map.size;
  let stallIterations = 0;

  while (map.size < startSize + targetAdditional && stallIterations < config.stallIterations) {
    const countBefore = map.size;
    const anchorCountBefore = await countProfileAnchors(page);

    await scrollAndLoad(page);

    const rows = await extractPeopleData(page);
    const added = mergePeopleRows(map, rows);

    for (const person of added) {
      await writer.upsertPerson(person);
    }

    logger.progressEvery(map.size, config.progressLogInterval);

    const { appended } = { appended: added.length };
    await writer.writeMeta({
      updatedAt: new Date().toISOString(),
      sourceUrl: url,
      phase: 'listing',
      totalUniquePeople: map.size,
      appendedLastWrite: appended,
      batchTarget: targetAdditional,
      collectedInBatch: map.size - startSize,
    });

    if (map.size >= startSize + targetAdditional) break;

    const clicked = await clickShowMore(page);
    const moreRendered = clicked ? await waitForMoreResults(page, anchorCountBefore) : false;
    if (!clicked) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await sleep(randomBetween(config.listingCycleMinMs, config.listingCycleMaxMs));
    }

    await sleep(randomBetween(config.listingCycleMinMs, config.listingCycleMaxMs));

    const grewThisCycle = map.size > countBefore;
    const shouldStall = !grewThisCycle && !clicked && !moreRendered;
    if (shouldStall) {
      stallIterations += 1;
      logger.info(`No new people after load cycle (stall ${stallIterations}/${config.stallIterations})`);
    } else {
      stallIterations = 0;
    }
  }

  const collected = map.size - startSize;
  return { collected, exhausted: stallIterations >= config.stallIterations && collected < targetAdditional };
}

/**
 * @param {string} cookieStr
 * @param {string} url
 * @param {{
 *   maxPeople?: number;
 *   batchSize?: number;
 *   parallelTabs?: number;
 *   format?: 'json' | 'csv' | 'both';
 *   headless?: boolean;
 *   useProfile?: boolean;
 *   resumeFromJsonl?: string;
 *   forceReenrich?: boolean;
 * }} [options]
 */
export async function run(cookieStr, url, options = {}) {
  const maxPeople = Math.min(
    options.maxPeople ?? config.maxPeople,
    config.maxPeopleLimit,
  );
  const batchSize = options.batchSize ?? config.batchSize;
  const parallelTabs = Math.min(
    Math.max(1, options.parallelTabs ?? config.parallelTabs),
    config.parallelTabsMax,
  );
  const useBatches = batchSize > 0 && config.scrapeProfiles;
  const headless = options.headless ?? config.headless;
  const useProfile = options.useProfile ?? config.useProfile;

  if (!useProfile && !(cookieStr || '').trim()) {
    throw new Error(
      'No cookie provided. Set LINKEDIN_COOKIE / constants.local.js, or use --profile / npm run login',
    );
  }

  let browser = /** @type {import('puppeteer').Browser | null} */ (null);
  /** @type {(() => Promise<void>) | null} */
  let sigintHandler = null;

  try {
    browser = await launchLinkedInBrowser(headless, { useProfile });

    sigintHandler = async () => {
      logger.warn('SIGINT received, closing browser…');
      try {
        await browser?.close();
      } catch {
        /* ignore */
      }
      process.exit(130);
    };
    process.once('SIGINT', sigintHandler);

    const page = await browser.newPage();
    await preparePage(page);

    if (useProfile) {
      logger.info('Using saved browser profile (no cookie injection).');
      await authenticateWithProfile(page);
    } else {
      await authenticate(page, cookieStr);
    }
    await navigateToUrl(page, url);

    await sleep(randomBetween(2000, 4000));
    await page.waitForSelector('body', { timeout: 10_000 }).catch(() => {});

    if (await detectSessionWall(page)) {
      throw new SessionWallError(
        'Session not valid: redirected to login or checkpoint. Refresh LINKEDIN_COOKIE (e.g. li_at) from a logged-in browser.',
      );
    }

    /** @type {Map<string, PersonRecord>} */
    const map = new Map();
    let stallIterations = 0;

    const writer = await createIncrementalWriter(
      options.resumeFromJsonl
        ? { baseName: baseNameFromOutputPath(options.resumeFromJsonl) }
        : {},
    );
    await writer.writeMeta({
      startedAt: new Date().toISOString(),
      sourceUrl: url,
      mode: useProfile ? 'profile' : 'cookie',
      jsonlPath: writer.jsonlPath,
      jsonPath: writer.jsonPath,
    });
    logger.info('Incremental output enabled (saved per person)', {
      jsonlPath: writer.jsonlPath,
      jsonPath: writer.jsonPath,
      csvPath: writer.csvPath,
      metaPath: writer.metaPath,
    });

    if (options.resumeFromJsonl) {
      const resumed = await loadPeopleFromJsonl(options.resumeFromJsonl);
      for (const p of resumed) {
        const hasDates =
          p.motiveExperience?.roles?.[0]?.dates || p.experiences?.[0]?.dates;
        if (options.forceReenrich) {
          p.profileEnriched = false;
        } else if (p.profileEnriched && !hasDates) {
          // Re-visit profiles that were enriched but still have no dates.
          p.profileEnriched = false;
        } else if (
          p.profileEnriched &&
          !isValidMotiveExperience(p.motiveExperience) &&
          (!p.experiences?.length || !p.experiences?.[0]?.dates)
        ) {
          p.profileEnriched = false;
        }
        if (p.profileUrl) map.set(personMapKey(p.profileUrl), p);
      }
      await writer.rewritePeople([...map.values()]);
      logger.info(`Resumed ${map.size} people from ${options.resumeFromJsonl}`, {
        enriched: [...map.values()].filter((p) => p.profileEnriched).length,
        needsEnrichment: [...map.values()].filter((p) => !p.profileEnriched).length,
      });

      logger.info('Resume mode: enriching missing profiles in one pass…', {
        total: map.size,
        parallelTabs,
      });
      await enrichProfilesFromPages(browser, map, writer, {}, { parallelTabs });
      await writer.rewritePeople([...map.values()]);
      await writer.writeMeta({
        updatedAt: new Date().toISOString(),
        phase: 'resume-complete',
        totalUniquePeople: map.size,
        enrichedCount: [...map.values()].filter((p) => p.profileEnriched).length,
        needsEnrichment: [...map.values()].filter((p) => !p.profileEnriched).length,
        jsonlPath: writer.jsonlPath,
        jsonPath: writer.jsonPath,
      });
      const peopleResumed = [...map.values()];
      logger.info('Resume run finished.', {
        total: peopleResumed.length,
        withMotive: peopleResumed.filter((p) => isValidMotiveExperience(p.motiveExperience)).length,
      });
      return {
        people: peopleResumed,
        metadata: {
          scrapedAt: new Date().toISOString(),
          sourceUrl: url,
          totalCount: peopleResumed.length,
          profileDetails: true,
          batchSize: null,
          parallelTabs,
          resumeFromJsonl: options.resumeFromJsonl,
        },
      };
    }

    let people = [];

    if (useBatches) {
      let batchNum = 0;
      logger.info('Batch mode: list then enrich profiles per batch', {
        batchSize,
        maxPeople,
        parallelTabs,
      });

      while (map.size < maxPeople) {
        batchNum += 1;
        const batchStart = map.size;
        const target = Math.min(batchSize, maxPeople - map.size);

        logger.info(`Batch ${batchNum}: collecting up to ${target} people from listing`, {
          totalSoFar: map.size,
          maxPeople,
        });

        const { collected, exhausted } = await collectListingBatch(page, map, writer, url, target);

        logger.info(`Batch ${batchNum}: collected ${collected} new people`, {
          totalSoFar: map.size,
        });

        if (collected > 0) {
          logger.info(`Batch ${batchNum}: pausing before profile visits…`, {
            cooldownMs: config.batchCooldownMs,
          });
          await sleep(
            randomBetween(config.batchCooldownMs, config.batchCooldownMs + 8000),
          );
          logger.info(`Batch ${batchNum}: enriching ${collected} profile(s)…`);
          await enrichProfilesFromPages(browser, map, writer, {
            startIndex: batchStart,
            endIndex: map.size,
            batchNum,
          }, { parallelTabs });
          await writer.rewritePeople([...map.values()].slice(0, maxPeople));
          await writer.writeMeta({
            updatedAt: new Date().toISOString(),
            phase: 'batch-complete',
            batchNum,
            batchCollected: collected,
            totalUniquePeople: map.size,
            enrichedCount: [...map.values()].filter((p) => p.profileEnriched).length,
            jsonlPath: writer.jsonlPath,
            jsonPath: writer.jsonPath,
          });
        }

        if (map.size >= maxPeople) break;
        if (collected === 0 && exhausted) {
          logger.warn('Listing exhausted before reaching maxPeople', {
            totalCollected: map.size,
            maxPeople,
          });
          break;
        }
      }

      people = [...map.values()].slice(0, maxPeople);
    } else {
      while (map.size < maxPeople && stallIterations < config.stallIterations) {
        const { collected } = await collectListingBatch(page, map, writer, url, maxPeople - map.size);
        if (collected === 0) stallIterations += 1;
        else stallIterations = 0;
        if (map.size >= maxPeople) break;
      }

      people = [...map.values()].slice(0, maxPeople);

      if (config.scrapeProfiles && people.length > 0) {
        logger.info('Opening each profile for fullName, title, about, and experiences…', {
          count: people.length,
        });
        await enrichProfilesFromPages(browser, map, writer, { endIndex: maxPeople }, {
          parallelTabs,
        });
        people = [...map.values()].slice(0, maxPeople);
        await writer.rewritePeople(people);
      }
    }

    return {
      people,
      metadata: {
        scrapedAt: new Date().toISOString(),
        sourceUrl: url,
        totalCount: people.length,
        profileDetails: config.scrapeProfiles,
        batchSize: useBatches ? batchSize : null,
        parallelTabs: config.scrapeProfiles ? parallelTabs : null,
      },
    };
  } finally {
    if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}
