import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { config, profileDir } from './config.js';
import * as logger from './utils/logger.js';
import { createIncrementalWriter } from './utils/fileHandler.js';

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
    ...config.extraLaunchArgs(),
  ];
  /** @type {import('puppeteer').LaunchOptions} */
  const base = { headless, args, ...launchExtras };

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
}

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
 * Scroll the profile page until the Experience heading is in view and any
 * lazy-loaded experience cards have rendered. We progressively scroll if the
 * heading isn't there yet (it usually lives 400-800px below the top).
 * @param {import('puppeteer').Page} page
 */
export async function scrollToExperienceSection(page) {
  try {
    const findHeading = async () =>
      page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const anchor =
          document.querySelector('#experience') ||
          document.querySelector('[data-testid*="ExperienceTopLevelSection"]') ||
          [...document.querySelectorAll('h2, h3')].find((h) =>
            /^experience$/i.test(norm(h.innerText || h.textContent)),
          );
        if (!anchor) return false;
        anchor.scrollIntoView({ block: 'center', behavior: 'instant' });
        return true;
      });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (await findHeading()) break;
      await page.evaluate(() => window.scrollBy(0, 500));
      await sleep(randomBetween(450, 800));
    }

    await sleep(randomBetween(700, 1100));
    await page.evaluate(() => window.scrollBy(0, 220));
    await sleep(randomBetween(350, 600));
    await page.evaluate(() => window.scrollBy(0, 380));
    await sleep(randomBetween(300, 500));
  } catch {
    /* ignore */
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
      const found = await page.evaluate(() => {
        const hasLogo = !![
          ...document.querySelectorAll(
            'img[alt*="Motive" i], svg[aria-label*="Motive" i], img[src*="motive_inc_logo"]',
          ),
        ].length;
        const hasLink = !!document.querySelector(
          'a[href*="/company/3271606"], a[href*="/company/motive-inc"], a[href*="/company/keeptruckin"]',
        );
        return hasLogo || hasLink;
      });
      if (found) return true;
    } catch {
      return false;
    }
    try {
      await page.evaluate(() => window.scrollBy(0, 600));
    } catch {
      return false;
    }
    await sleep(randomBetween(700, 1100));
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
      if (/\bpresent\b/i.test(t) && /\b(19|20)\d{2}\b/i.test(t)) return true;
      if (
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t) &&
        (/\b(19|20)\d{2}\b/i.test(t) || /\bpresent\b/i.test(t))
      ) {
        return true;
      }
      if (/\b(19|20)\d{2}\b/.test(t) && /\b(mos|yr|month|year)\b/i.test(t)) return true;
      if (/\d{4}\s*[-–]\s*(\d{4}|present)\b/i.test(t)) return true;
      return false;
    };

    const isLocationLine = (t) =>
      !isJunkLine(t) &&
      (t.includes(',') || /\bremote\b/i.test(t)) &&
      !isDateLine(t) &&
      !/^motive\b/i.test(t);

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

    /** Prefer <p> nodes that contain Present or a month–year range (LinkedIn date row). */
    /** @param {Element} root */
    const findDateLine = (root, fallbackLines = []) => {
      for (const p of root.querySelectorAll('p')) {
        if (p.closest('ul')) continue;
        const t = norm(p.innerText);
        if (isDateLine(t)) return t;
      }
      for (const span of root.querySelectorAll('span[aria-hidden="true"]')) {
        const t = norm(span.textContent);
        if (isDateLine(t)) return t;
      }
      return fallbackLines.find((l) => isDateLine(l)) || null;
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
      root.querySelectorAll('ul li').forEach((li) => {
        const ps = [...li.querySelectorAll('p, span[aria-hidden="true"]')]
          .map((el) => norm(el.innerText || el.textContent))
          .filter((t) => !isJunkLine(t));
        if (!ps.length) return;
        const dates = findDateLine(li, ps) || ps.find((t) => isDateLine(t)) || null;
        const title =
          ps.find(
            (t) =>
              t !== dates &&
              isLikelyJobTitle(t) &&
              !/skills$/i.test(t),
          ) || ps.find((t) => t !== dates && !matchesCompany(t, '')) || null;
        const descEl = li.querySelector('[data-testid="expandable-text-box"]');
        const description = descEl ? norm(descEl.innerText).slice(0, 2000) : null;
        if (title && !isJunkLine(title)) roles.push({ title, dates, description });
      });

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
     * Build a Motive result by reading title / company line / dates / location
     * from a card element's <p> + <span aria-hidden> nodes in document order.
     * @param {Element} card
     * @returns {object | null}
     */
    const buildMotiveResultFromCard = (card) => {
      if (!card) return null;
      const lines = collectLines(card);
      if (!lines.length) return null;
      const href = companyHref(card);
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

      return buildMotiveResultFromCard(bestCard);
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

    const firstCard = parseFirstCardAfterExperienceHeading();
    if (firstCard) {
      const score = scoreMotiveResult(firstCard, scope) + 100;
      candidates.push({ parsed: firstCard, score });
    }

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
    return best?.parsed ?? null;
  }, aliases);
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

export async function expandExperienceSection(page) {
  try {
    await page.evaluate(() => {
      document.querySelector('#experience')?.scrollIntoView({ block: 'center' });
    });
    await sleep(randomBetween(600, 1000));
    await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const buttons = [...document.querySelectorAll('button, a, span[role="button"]')];
      const expand = buttons.find((el) => {
        const t = norm(el.innerText || el.textContent);
        return /show all \d+ experiences|see all experiences|show all experience/i.test(t);
      });
      if (expand) expand.click();
    });
    await sleep(randomBetween(1000, 1800));
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
    waitUntil: config.waitUntil,
    timeout: config.navigationTimeoutMs,
  });
  await sleep(randomBetween(config.profileNavigationMinMs, config.profileNavigationMaxMs));
  await page.waitForSelector('main, h1', { timeout: 15_000 }).catch(() => {});
  await sleep(randomBetween(config.minDelayMs, config.maxDelayMs));

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

  return {
    ...base,
    about: about || person.about || null,
    motiveExperience,
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
  const toEnrich = entries.filter(
    ([, person]) =>
      !person.profileEnriched || !isValidMotiveExperience(person.motiveExperience),
  );

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

  /** @param {import('puppeteer').Page} page @param {number} workerId */
  const worker = async (page, workerId) => {
    while (true) {
      const i = nextIndex++;
      if (i >= toEnrich.length) break;

      const [key, person] = toEnrich[i];

      logger.info(`[tab ${workerId}] Enriching ${i + 1}/${toEnrich.length}`, {
        profileUrl: person.profileUrl,
      });

      try {
        const details = await enrichOneProfile(page, person);

        if (details.motiveExperience) {
          logger.info(`[tab ${workerId}] Found ${config.targetCompanyName} experience`, {
            profileUrl: person.profileUrl,
            dates: details.motiveExperience.roles?.[0]?.dates ?? null,
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
        logger.warn(`[tab ${workerId}] Profile enrich failed`, {
          profileUrl: person.profileUrl,
          message: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof SessionWallError) {
          throw err;
        }
      }

      await sleep(randomBetween(config.profileDelayMinMs, config.profileDelayMaxMs));
    }
  };

  /** @type {import('puppeteer').Page[]} */
  const workerPages = [];
  try {
    for (let t = 0; t < parallelTabs; t += 1) {
      if (t > 0) {
        await sleep(t * config.parallelTabStaggerMs + randomBetween(500, 1500));
      }
      try {
        const p = await browser.newPage();
        await preparePage(p);
        workerPages.push(p);
      } catch (err) {
        logger.warn(`Failed to open worker tab #${t + 1}, continuing with ${workerPages.length}`, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!workerPages.length) {
      throw new Error('Could not open any worker tab for enrichment');
    }

    const results = await Promise.allSettled(
      workerPages.map((p, idx) => worker(p, idx + 1)),
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
    for (const p of workerPages) {
      await p.close().catch(() => {});
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

    const writer = await createIncrementalWriter();
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
