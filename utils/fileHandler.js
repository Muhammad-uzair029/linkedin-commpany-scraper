import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Incremental writer: append JSONL + periodically update a meta JSON file.
 * @param {{ baseName?: string }} [opts]
 */
export async function createIncrementalWriter(opts = {}) {
  await fs.mkdir(config.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = opts.baseName || `linkedin_people_live_${stamp}`;

  const jsonlPath = path.join(config.outputDir, `${base}.jsonl`);
  const metaPath = path.join(config.outputDir, `${base}.meta.json`);
  const csvPath = path.join(config.outputDir, `${base}.csv`);
  const jsonPath = path.join(config.outputDir, `${base}.json`);

  /** @type {Map<string, Record<string, unknown>>} */
  const peopleByUrl = new Map();

  const csvHeader =
    'fullName,title,about,profileUrl,motiveExperience,connectionDegree,experiences,company1,company2,company3,profileEnriched';

  /** @param {Record<string, unknown>} p */
  function personToCsvRow(p) {
    const fullName = /** @type {string} */ (p.fullName ?? p.name ?? '');
    return [
      escapeCsvField(fullName),
      escapeCsvField(/** @type {string} */ (p.title ?? '')),
      escapeCsvField(/** @type {string} */ (p.about ?? '')),
      escapeCsvField(/** @type {string} */ (p.profileUrl ?? '')),
      escapeCsvField(JSON.stringify(p.motiveExperience ?? null)),
      escapeCsvField(/** @type {string} */ (p.connectionDegree ?? '')),
      escapeCsvField(JSON.stringify(p.experiences ?? [])),
      escapeCsvField(/** @type {string} */ (p.company1 ?? '')),
      escapeCsvField(/** @type {string} */ (p.company2 ?? '')),
      escapeCsvField(/** @type {string} */ (p.company3 ?? '')),
      escapeCsvField(String(!!p.profileEnriched)),
    ].join(',');
  }

  async function flushJsonl() {
    if (!peopleByUrl.size) {
      await fs.writeFile(jsonlPath, '', 'utf8');
      return;
    }
    const chunk = [...peopleByUrl.values()].map((p) => `${JSON.stringify(p)}\n`).join('');
    await fs.writeFile(jsonlPath, chunk, 'utf8');
  }

  async function rebuildCsv() {
    const lines = [csvHeader];
    for (const p of peopleByUrl.values()) {
      lines.push(personToCsvRow(p));
    }
    await fs.writeFile(csvPath, `${lines.join('\n')}\n`, 'utf8');
  }

  async function rebuildJsonSnapshot() {
    const people = [...peopleByUrl.values()];
    const enrichedCount = people.reduce((n, p) => n + (p.profileEnriched ? 1 : 0), 0);
    const payload = {
      metadata: {
        updatedAt: new Date().toISOString(),
        totalUniquePeople: people.length,
        enrichedCount,
      },
      people,
    };
    await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  async function rewriteAll() {
    await flushJsonl();
    await rebuildCsv();
    await rebuildJsonSnapshot();
  }

  /**
   * Save one person immediately (JSONL + CSV + JSON). Updates existing row if profileUrl matches.
   * @param {Record<string, unknown>} person
   */
  async function upsertPerson(person) {
    const key = person.profileUrl;
    if (!key || typeof key !== 'string') return { jsonlPath, metaPath, csvPath, jsonPath };

    peopleByUrl.set(key, { ...person });
    await rewriteAll();

    return { jsonlPath, metaPath, csvPath, jsonPath };
  }

  /**
   * @param {Array<{ profileUrl: string }>} people
   */
  async function appendPeople(people) {
    let appended = 0;
    for (const p of people) {
      const key = p.profileUrl;
      if (!key || peopleByUrl.has(key)) continue;
      peopleByUrl.set(key, { ...p });
      appended += 1;
    }
    if (appended > 0) {
      await rewriteAll();
    }
    return { appended, jsonlPath, metaPath, csvPath, jsonPath };
  }

  /**
   * @param {object} meta
   */
  async function writeMeta(meta) {
    await fs.writeFile(
      metaPath,
      JSON.stringify({ ...meta, jsonlPath, csvPath, jsonPath, metaPath }, null, 2),
      'utf8',
    );
    return { metaPath };
  }

  /**
   * Rewrite JSONL/CSV/JSON from the full in-memory set.
   * @param {Array<{ profileUrl: string }>} people
   */
  async function rewritePeople(people) {
    peopleByUrl.clear();
    for (const p of people) {
      if (p.profileUrl) peopleByUrl.set(p.profileUrl, { ...p });
    }
    await rewriteAll();
    return { count: peopleByUrl.size, jsonlPath, metaPath, csvPath, jsonPath };
  }

  return {
    jsonlPath,
    metaPath,
    csvPath,
    jsonPath,
    upsertPerson,
    appendPeople,
    rewritePeople,
    writeMeta,
  };
}

/**
 * @param {{ metadata: object, people: Array<Record<string, unknown>> }} payload
 * @param {{ format?: 'json' | 'csv' | 'both' }} [opts]
 * @returns {Promise<{ jsonPath?: string, csvPath?: string }>}
 */
export async function saveToFile(payload, opts = {}) {
  const format = opts.format ?? 'json';
  await fs.mkdir(config.outputDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `linkedin_people_${stamp}`;
  const result = {};

  if (format === 'json' || format === 'both') {
    const jsonPath = path.join(config.outputDir, `${base}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
    result.jsonPath = jsonPath;
  }

  if (format === 'csv' || format === 'both') {
    const csvPath = path.join(config.outputDir, `${base}.csv`);
    const header =
      'fullName,title,about,profileUrl,motiveExperience,connectionDegree,experiences,company1,company2,company3';
    const lines = [header];
    for (const p of payload.people) {
      const fullName = /** @type {string} */ (p.fullName ?? p.name ?? '');
      lines.push(
        [
          escapeCsvField(fullName),
          escapeCsvField(/** @type {string} */ (p.title ?? '')),
          escapeCsvField(/** @type {string} */ (p.about ?? '')),
          escapeCsvField(p.profileUrl),
          escapeCsvField(JSON.stringify(p.motiveExperience ?? null)),
          escapeCsvField(/** @type {string} */ (p.connectionDegree ?? '')),
          escapeCsvField(JSON.stringify(p.experiences ?? [])),
          escapeCsvField(/** @type {string} */ (p.company1 ?? '')),
          escapeCsvField(/** @type {string} */ (p.company2 ?? '')),
          escapeCsvField(/** @type {string} */ (p.company3 ?? '')),
        ].join(','),
      );
    }
    await fs.writeFile(csvPath, lines.join('\n'), 'utf8');
    result.csvPath = csvPath;
  }

  return result;
}

/** @param {string} s */
function escapeCsvField(s) {
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
