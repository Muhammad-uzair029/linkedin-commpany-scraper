/** Default People page when CLI / env omit URL (Pakistan geo + sales filter). */
export const DEFAULT_LINKEDIN_URL =
  'https://www.linkedin.com/company/motive-inc/people/?facetGeoRegion=101022442&keywords=sales';

/** @type {string} */
let defaultCookie = '';
try {
  const mod = await import('./constants.local.js');
  defaultCookie =
    typeof mod.LINKEDIN_COOKIE === 'string' ? mod.LINKEDIN_COOKIE : '';
} catch {
  /* optional gitignored secrets */
}

/** Session cookie when CLI / env omit cookie (from `constants.local.js` if present). */
export const DEFAULT_LINKEDIN_COOKIE = defaultCookie;
