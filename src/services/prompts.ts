// Versioned prompt registry for INTERNAL experimentation. Prompt text stays
// code, owned by the module that uses it; each module registers its prompts
// here so that (a) an experiment can select a non-default version via the
// VOXTALE_EDITOR_PROMPTS env var without touching the default path, and (b) run
// artifacts can stamp exact prompt provenance (version + content hash) the
// same way they stamp models. This is never a user-facing surface.
//
// Rules:
// - Versions are append-only. Never edit a shipped version's text - add the
//   next number and (once the experiment wins) move `active` to it. The
//   content hash in artifacts makes silent edits visible.
// - judge.* prompts are calibrated: activating a new version requires
//   re-running the frozen eval, exactly like a
//   judge model change (see DEFAULT_JUDGE_MODEL in llm.ts).
// - An override for an id that is not registered is silently inert at
//   resolution time (the owning module may simply not be loaded), so
//   always verify an experiment via the `prompts`
//   stamp in the run artifact.

import { createHash } from "node:crypto";

/** Env override, e.g. VOXTALE_EDITOR_PROMPTS="generate.concepts=2,perceiver.critique=3" */
export const PROMPT_OVERRIDES_ENV = "VOXTALE_EDITOR_PROMPTS";
/** The old name, still read when the new one is unset. */
export const LEGACY_PROMPT_OVERRIDES_ENV = "SUPERTALE_PROMPTS";

interface PromptEntry {
  versions: Map<number, string>;
  active: number;
}

export interface PromptProvenance {
  version: number;
  /** First 12 hex chars of sha256 of the resolved text. */
  hash: string;
}

export interface PromptListing {
  id: string;
  versions: number[];
  active: number;
  /** Version actually resolved right now (differs from active under an override). */
  resolved: number;
  hash: string;
}

const registry = new Map<string, PromptEntry>();
let explicitOverrides: Map<string, number> | null = null;
let envOverrides: Map<string, number> | null = null;

function parseOverrides(raw: string): Map<string, number> {
  const overrides = new Map<string, number>();
  for (const part of raw.split(",")) {
    const pair = part.trim();
    if (!pair) {
      continue;
    }
    const eq = pair.indexOf("=");
    const id = eq >= 0 ? pair.slice(0, eq).trim() : "";
    const version = eq >= 0 ? Number(pair.slice(eq + 1).trim()) : Number.NaN;
    if (!id || !Number.isInteger(version) || version < 1) {
      throw new Error(`malformed ${PROMPT_OVERRIDES_ENV} entry ${JSON.stringify(pair)} (want id=version)`);
    }
    overrides.set(id, version);
  }
  return overrides;
}

function activeOverrides(): Map<string, number> {
  if (explicitOverrides) {
    return explicitOverrides;
  }
  if (!envOverrides) {
    envOverrides = parseOverrides(process.env[PROMPT_OVERRIDES_ENV] ?? process.env[LEGACY_PROMPT_OVERRIDES_ENV] ?? "");
  }
  return envOverrides;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Register a prompt's versions; returns the id so modules can export it.
 *  `active` defaults to the highest version. */
export function registerPrompt(id: string, versions: Record<number, string>, active?: number): string {
  const entries = Object.entries(versions).map(([version, text]) => [Number(version), text] as const);
  if (!entries.length) {
    throw new Error(`prompt ${id} registered with no versions`);
  }
  for (const [version] of entries) {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`prompt ${id} has a non-positive-integer version: ${version}`);
    }
  }
  const map = new Map(entries);
  const selected = active ?? Math.max(...map.keys());
  if (!map.has(selected)) {
    throw new Error(`prompt ${id} activates missing version ${selected}`);
  }
  // A dev server's hot reload re-runs the registering module; the same
  // registration again is harmless, a different one is a clash.
  const existing = registry.get(id);
  if (existing) {
    const same = existing.active === selected && existing.versions.size === map.size
      && [...map].every(([v, t]) => existing.versions.get(v) === t);
    if (same) return id;
    throw new Error(`prompt already registered: ${id}`);
  }
  registry.set(id, { versions: map, active: selected });
  return id;
}

function resolvedVersion(id: string, entry: PromptEntry): number {
  const version = activeOverrides().get(id) ?? entry.active;
  if (!entry.versions.has(version)) {
    const available = [...entry.versions.keys()].sort((a, b) => a - b).join(", ");
    throw new Error(`prompt ${id} has no version ${version} (available: ${available})`);
  }
  return version;
}

/** Resolve a prompt id to its text, honoring overrides. Call-time, not import-time. */
export function promptText(id: string): string {
  const entry = registry.get(id);
  if (!entry) {
    throw new Error(`unknown prompt id: ${id}`);
  }
  return entry.versions.get(resolvedVersion(id, entry)) as string;
}

/**
 * Resolve a specific version's text, for callers that route versions by their
 * own calibrated context (e.g. a per-cell judge assignment) rather than the
 * single registry-wide active default. An explicit override still wins, so
 * `VOXTALE_EDITOR_PROMPTS="id=N"` forces version N for controlled evals regardless
 * of the requested version — the override is the experiment's escape hatch.
 */
export function promptTextVersion(id: string, version: number): string {
  const entry = registry.get(id);
  if (!entry) {
    throw new Error(`unknown prompt id: ${id}`);
  }
  const selected = activeOverrides().get(id) ?? version;
  if (!entry.versions.has(selected)) {
    const available = [...entry.versions.keys()].sort((a, b) => a - b).join(", ");
    throw new Error(`prompt ${id} has no version ${selected} (available: ${available})`);
  }
  return entry.versions.get(selected) as string;
}

/** Replace overrides programmatically (tests, future admin surface). */
export function setPromptOverrides(overrides: Record<string, number>): void {
  explicitOverrides = new Map(Object.entries(overrides));
}

/** Drop programmatic overrides, falling back to the env var. */
export function clearPromptOverrides(): void {
  explicitOverrides = null;
  envOverrides = null;
}

/** The override map in effect (env or programmatic), including ids that match no registered prompt. */
export function promptOverrides(): Record<string, number> {
  return Object.fromEntries(activeOverrides());
}

/** Provenance of every registered prompt as resolved right now - stamped into run artifacts. */
export function promptStamp(): Record<string, PromptProvenance> {
  const stamp: Record<string, PromptProvenance> = {};
  for (const id of [...registry.keys()].sort()) {
    const entry = registry.get(id) as PromptEntry;
    const version = resolvedVersion(id, entry);
    stamp[id] = { version, hash: contentHash(entry.versions.get(version) as string) };
  }
  return stamp;
}

/** Introspection for a `prompts` listing. */
export function listPrompts(): PromptListing[] {
  return [...registry.keys()].sort().map((id) => {
    const entry = registry.get(id) as PromptEntry;
    const resolved = resolvedVersion(id, entry);
    return {
      id,
      versions: [...entry.versions.keys()].sort((a, b) => a - b),
      active: entry.active,
      resolved,
      hash: contentHash(entry.versions.get(resolved) as string),
    };
  });
}

/** Which registered prompt a resolved text is, for traces of calls that only carry the text. */
export function promptForText(text: string): ({ id: string } & PromptProvenance) | null {
  for (const [id, entry] of registry) {
    for (const [version, t] of entry.versions) if (t === text) return { id, version, hash: contentHash(t) };
  }
  return null;
}
