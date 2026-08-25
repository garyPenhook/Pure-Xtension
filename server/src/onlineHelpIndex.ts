import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HelpEntry {
  /** Original-case command name, e.g. "AddGadgetItem". */
  name: string;
  url: string;
}

/** Keyed by lowercase command name -> {original-case name, full doc URL}. */
export interface HelpIndex {
  fetchedAt: number;
  commands: Record<string, HelpEntry>;
}

const INDEX_URL = "https://www.purebasic.com/documentation/reference/commandindex.html";
const DOC_BASE = "https://www.purebasic.com/documentation/";
// Verified against the live page: every command entry is an unquoted
// `<a href=../lib/name.html>Name</a>` link, no exceptions found in the 1888 entries.
const LINK_RE = /<a href=(\.\.\/[a-z0-9_]+\/[a-z0-9_]+\.html)>([^<]+)<\/a>/gi;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Bump this filename whenever HelpIndex's on-disk shape changes, so a stale
// cache from an older schema (e.g. `commands` used to map name -> url string,
// not -> {name, url}) is never parsed as if it matched the current shape.
function cacheFile(cacheDir: string): string {
  return join(cacheDir, "help-index-v2.json");
}

export async function fetchHelpIndex(): Promise<HelpIndex> {
  const res = await fetch(INDEX_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`commandindex.html fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const commands: Record<string, HelpEntry> = {};
  for (const match of html.matchAll(LINK_RE)) {
    const [, href, name] = match;
    commands[name.toLowerCase()] = { name, url: DOC_BASE + href.replace(/^\.\.\//, "") };
  }
  return { fetchedAt: Date.now(), commands };
}

async function readCache(cacheDir: string): Promise<HelpIndex | undefined> {
  try {
    return JSON.parse(await readFile(cacheFile(cacheDir), "utf8")) as HelpIndex;
  } catch {
    return undefined;
  }
}

/** Loads a fresh-enough disk cache, otherwise re-fetches from purebasic.com and
 *  persists the result. Falls back to a stale cache (or undefined) if offline. */
export async function loadOrFetchHelpIndex(cacheDir: string): Promise<HelpIndex | undefined> {
  const cached = await readCache(cacheDir);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  try {
    const fresh = await fetchHelpIndex();
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile(cacheDir), JSON.stringify(fresh), "utf8");
    return fresh;
  } catch {
    return cached;
  }
}

export function getHelpUrl(index: HelpIndex | undefined, name: string): string | undefined {
  return index?.commands[name.toLowerCase()]?.url;
}
