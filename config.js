import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @returns {string[]} */
function extraLaunchArgs() {
  if (process.env.PUPPETEER_NO_SANDBOX === '1') {
    return ['--no-sandbox', '--disable-setuid-sandbox'];
  }
  return [];
}

/** Persistent Chrome profile — log in once with `npm run login`, reuse for scrape. */
export const profileDir = path.join(__dirname, '.linkedin-profile');

export const config = {
  outputDir: path.join(__dirname, 'output'),
  profileDir,
  useProfile: process.env.LINKEDIN_USE_PROFILE === '1',
  /** Maximum people per run (--max cannot exceed this). */
  maxPeopleLimit: Number(process.env.MAX_PEOPLE_LIMIT) || 2600,
  maxPeople: Number(process.env.MAX_PEOPLE) || 2518,
  /** List N people, enrich those profiles, then repeat (0 = list all first, enrich once at end). */
  batchSize: Number(process.env.BATCH_SIZE) || 200,
  /** Parallel browser tabs for profile enrichment. */
  parallelTabs: Number(process.env.PARALLEL_TABS) || 6,
  parallelTabsMax: Number(process.env.PARALLEL_TABS_MAX) || 15,
  /** General human-like pauses between actions. */
  minDelayMs: Number(process.env.MIN_DELAY_MS) || 1800,
  maxDelayMs: Number(process.env.MAX_DELAY_MS) || 4200,
  navigationTimeoutMs: 60_000,
  navigationRetries: 3,
  navigationBackoffMs: Number(process.env.NAV_BACKOFF_MS) || 12_000,
  waitUntil: /** @type {'domcontentloaded' | 'load' | 'networkidle0' | 'networkidle2'} */ (
    process.env.LINKEDIN_WAIT_UNTIL || 'domcontentloaded'
  ),
  scrollStepPx: Number(process.env.SCROLL_STEP_PX) || 400,
  /** Small steps when scrolling to Experience on profiles (avoid scrolling to page bottom). */
  profileExperienceScrollPx: Number(process.env.PROFILE_EXPERIENCE_SCROLL_PX) || 320,
  profileExperienceMaxScrollSteps: Number(process.env.PROFILE_EXPERIENCE_MAX_SCROLL_STEPS) || 18,
  scrollRounds: Number(process.env.SCROLL_ROUNDS) || 3,
  scrollPauseMs: Number(process.env.SCROLL_PAUSE_MS) || 2500,
  showMoreDelayMinMs: Number(process.env.SHOW_MORE_DELAY_MIN_MS) || 3500,
  showMoreDelayMaxMs: Number(process.env.SHOW_MORE_DELAY_MAX_MS) || 7000,
  listingCycleMinMs: Number(process.env.LISTING_CYCLE_DELAY_MIN_MS) || 4500,
  listingCycleMaxMs: Number(process.env.LISTING_CYCLE_DELAY_MAX_MS) || 9000,
  /** Pause between list-batch and profile enrichment batch. */
  batchCooldownMs: Number(process.env.BATCH_COOLDOWN_MS) || 18_000,
  stallIterations: Number(process.env.STALL_ITERATIONS) || 12,
  progressLogInterval: 15,
  headless: process.env.HEADLESS !== '0',
  /** Visit each /in/ profile for fullName, title, about, experiences. */
  scrapeProfiles: process.env.LINKEDIN_SCRAPE_PROFILES !== '0',
  /** After each profile visit completes. */
  profileDelayMinMs: Number(process.env.PROFILE_DELAY_MIN_MS) || 4500,
  profileDelayMaxMs: Number(process.env.PROFILE_DELAY_MAX_MS) || 10_000,
  /** After navigating to a profile, before scraping. */
  profileNavigationMinMs: Number(process.env.PROFILE_NAV_DELAY_MIN_MS) || 5000,
  profileNavigationMaxMs: Number(process.env.PROFILE_NAV_DELAY_MAX_MS) || 5000,
  /** fix-dates.js wait after each profile goto. */
  profileLoadWaitMs: Number(process.env.PROFILE_LOAD_WAIT_MS) || 6000,
  /** Stagger start of parallel tabs (ms per tab index). */
  parallelTabStaggerMs: Number(process.env.PARALLEL_TAB_STAGGER_MS) || 3500,
  /** Company name to match in Experience section (e.g. Motive). */
  targetCompanyName: process.env.TARGET_COMPANY_NAME || 'Motive',
  /** Also match href/text aliases (KeepTruckin rebranded to Motive). */
  targetCompanyAliases: ['Motive', 'KeepTruckin', 'motive-inc', 'keeptruckin', '3271606'],
  /** Block images/media/fonts for faster loads. Set BLOCK_MEDIA=0 to allow images. */
  blockMedia: process.env.BLOCK_MEDIA !== '0',
  extraLaunchArgs,
};
