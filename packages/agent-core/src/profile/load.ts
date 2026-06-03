import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'pathe';

import { load as loadYaml } from 'js-yaml';

import { resolveAgentProfiles } from './resolve';
import { RawAgentProfileSchema, type RawAgentProfile, type ResolvedAgentProfile } from './types';

export async function loadAgentProfilesFromDir(
  paths: readonly string[],
  fallbackProfiles?: Readonly<Record<string, ResolvedAgentProfile>>,
): Promise<Record<string, ResolvedAgentProfile>> {
  const loaded = await loadRawAgentProfiles(paths);
  const resolved = resolvePathBasedExtends(loaded);
  const rawProfiles = resolved.map((r) => r.profile);

  // Merge with fallback profiles so OMK-style references to built-ins
  // (e.g. extending "default" or "agent") resolve correctly.
  if (fallbackProfiles !== undefined) {
    const fallbackRaw: RawAgentProfile[] = [];
    for (const [name, resolvedProfile] of Object.entries(fallbackProfiles)) {
      // Reconstruct a minimal RawAgentProfile from the resolved one.
      // This is sufficient for resolveAgentProfiles to link extends.
      fallbackRaw.push({
        name,
        description: resolvedProfile.description,
        systemPromptTemplate: '',
        promptVars: {},
        tools: [...resolvedProfile.tools],
        whenToUse: resolvedProfile.whenToUse,
        subagents: resolvedProfile.subagents
          ? Object.fromEntries(
              Object.entries(resolvedProfile.subagents).map(([k, v]) => [
                k,
                { description: v.description },
              ]),
            )
          : undefined,
      });
    }
    return resolveAgentProfiles([...fallbackRaw, ...rawProfiles]);
  }

  return resolveAgentProfiles(rawProfiles);
}

export function loadAgentProfilesFromSources(
  paths: readonly string[],
  sources: Readonly<Record<string, string>>,
): Record<string, ResolvedAgentProfile> {
  const rawProfiles = paths.map((profilePath) =>
    finalizeRawAgentProfileSource(readRequiredSource(sources, profilePath), profilePath, sources),
  );
  return resolveAgentProfiles(rawProfiles);
}

interface LoadedRawProfile {
  readonly path: string;
  readonly profile: RawAgentProfile;
}

async function loadRawAgentProfiles(paths: readonly string[]): Promise<LoadedRawProfile[]> {
  const profiles: LoadedRawProfile[] = [];

  for (const profilePath of paths) {
    let content: string;
    try {
      content = await readFile(profilePath, 'utf-8');
    } catch (error) {
      if (isFileNotFound(error)) continue;
      throw readError('agent profile', profilePath, error);
    }
    profiles.push({
      path: profilePath,
      profile: await finalizeRawAgentProfile(content, profilePath),
    });
  }

  return profiles;
}

async function finalizeRawAgentProfile(
  content: string,
  profilePath: string,
): Promise<RawAgentProfile> {
  let raw = parseAgentProfileYaml(content, profilePath);
  raw = await resolveOmkSubagentPaths(raw, profilePath);
  if (raw.systemPromptPath === undefined) return raw;
  const templatePath = join(dirname(profilePath), raw.systemPromptPath);
  try {
    return { ...raw, systemPromptTemplate: await readFile(templatePath, 'utf-8') };
  } catch (error) {
    throw new Error(
      `Failed to read system prompt template for "${raw.name}" at ${templatePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function finalizeRawAgentProfileSource(
  content: string,
  profilePath: string,
  sources: Readonly<Record<string, string>>,
): RawAgentProfile {
  const raw = parseAgentProfileYaml(content, profilePath);
  if (raw.systemPromptPath === undefined) return raw;
  const templatePath = resolveProfileSourcePath(profilePath, raw.systemPromptPath);
  return { ...raw, systemPromptTemplate: readRequiredSource(sources, templatePath) };
}

function parseAgentProfileYaml(content: string, profilePath: string): RawAgentProfile {
  let parsed: unknown;
  try {
    parsed = loadYaml(content);
  } catch (error) {
    throw new Error(
      `Invalid agent profile YAML at ${profilePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  parsed = normalizeOmkProfile(parsed);
  const result = RawAgentProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid agent profile at ${profilePath}`);
  }
  return result.data;
}

/**
 * Detect and normalize oh-my-kimi (OMK) agent profile format to the
 * kimi-code native schema. OMK profiles nest everything under an `agent:`
 * key and use snake_case names. This function is a no-op for native
 * kimi-code profiles.
 *
 * Subagent `path` references are kept as `_omkPath` on the entry so
 * `resolveOmkSubagentPaths` can fix up the keys asynchronously later.
 */
function normalizeOmkProfile(parsed: unknown): unknown {
  if (!isRecord(parsed)) return parsed;
  const agent = parsed['agent'];
  if (!isRecord(agent)) return parsed;

  // Detect OMK format: must have `agent` key with profile data inside.
  const normalized: Record<string, unknown> = {};

  if (agent['extend'] !== undefined) {
    normalized['extends'] = agent['extend'];
  }
  if (agent['name'] !== undefined) {
    normalized['name'] = agent['name'];
  }
  if (agent['description'] !== undefined) {
    normalized['description'] = agent['description'];
  }
  if (agent['system_prompt_path'] !== undefined) {
    normalized['systemPromptPath'] = agent['system_prompt_path'];
  }
  if (agent['system_prompt_template'] !== undefined) {
    normalized['systemPromptTemplate'] = agent['system_prompt_template'];
  }
  if (agent['system_prompt_args'] !== undefined) {
    normalized['promptVars'] = agent['system_prompt_args'];
  }
  if (agent['tools'] !== undefined) {
    normalized['tools'] = agent['tools'];
  }
  if (agent['when_to_use'] !== undefined) {
    normalized['whenToUse'] = agent['when_to_use'];
  }
  if (agent['subagents'] !== undefined && isRecord(agent['subagents'])) {
    const subagents: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(agent['subagents'])) {
      if (!isRecord(value)) continue;

      const entry: Record<string, unknown> = {};
      if (value['description'] !== undefined) {
        entry['description'] = value['description'];
      }
      // Preserve the path for async resolution later.
      if (typeof value['path'] === 'string') {
        entry['_omkPath'] = value['path'];
      }
      subagents[key] = entry;
    }
    if (Object.keys(subagents).length > 0) {
      normalized['subagents'] = subagents;
    }
  }

  return normalized;
}

/**
 * For file-based profiles, resolve OMK subagent `_omkPath` references to
 * actual profile names by reading the referenced files. This mutates the
 * profile's subagent keys in place.
 */
async function resolveOmkSubagentPaths(
  profile: RawAgentProfile,
  profilePath: string,
): Promise<RawAgentProfile> {
  if (profile.subagents === undefined) return profile;

  const fixedSubagents: Record<string, { description?: string }> = {};
  for (const [key, entry] of Object.entries(profile.subagents)) {
    const pathRef = (entry as Record<string, unknown>)['_omkPath'];
    let targetKey = key;

    if (typeof pathRef === 'string') {
      const resolvedPath = resolve(dirname(profilePath), pathRef);
      try {
        const subagentContent = await readFile(resolvedPath, 'utf-8');
        const subagentParsed = loadYaml(subagentContent);
        if (isRecord(subagentParsed) && isRecord(subagentParsed['agent'])) {
          const subagentName = subagentParsed['agent']['name'];
          if (typeof subagentName === 'string') {
            targetKey = subagentName;
          }
        }
      } catch {
        // Best-effort: keep original key if file can't be read.
      }
    }

    fixedSubagents[targetKey] = { description: entry.description };
  }

  return { ...profile, subagents: fixedSubagents };
}

/**
 * OMK profiles reference other profiles by file path in `extend`.
 * kimi-code uses profile *names* in `extends`. This function resolves
 * path-based extends by looking up the target file's profile name.
 * It also maps OMK's built-in "default" to kimi-code's "agent".
 */
function resolvePathBasedExtends(loaded: readonly LoadedRawProfile[]): LoadedRawProfile[] {
  // Build a map of absolute file path -> profile name.
  const pathToName = new Map<string, string>();
  for (const { path, profile } of loaded) {
    pathToName.set(normalize(path), profile.name);
  }

  const result: LoadedRawProfile[] = [];
  for (const { path, profile } of loaded) {
    let extendsValue = profile.extends;
    if (extendsValue !== undefined) {
      // Map OMK built-in "default" to kimi-code's main default profile.
      if (extendsValue === 'default') {
        extendsValue = 'agent';
      } else if (looksLikeFilePath(extendsValue)) {
        const targetPath = resolve(dirname(path), extendsValue);
        const targetName = pathToName.get(normalize(targetPath));
        if (targetName !== undefined) {
          extendsValue = targetName;
        }
      }
    }

    result.push({
      path,
      profile: {
        ...profile,
        extends: extendsValue,
      },
    });
  }

  return result;
}

function looksLikeFilePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.startsWith('.');
}

function resolveProfileSourcePath(profilePath: string, relativePath: string): string {
  return normalizeSourcePath(
    join(dirname(normalizeSourcePath(profilePath)), relativePath),
  );
}

function readRequiredSource(sources: Readonly<Record<string, string>>, path: string): string {
  const normalized = normalizeSourcePath(path);
  const content = sources[normalized];
  if (content === undefined) {
    throw new Error(`Embedded agent profile source missing: ${normalized}`);
  }
  return content;
}

function normalizeSourcePath(path: string): string {
  return normalize(path.replaceAll('\\', '/')).replace(/^\.\//, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}

function readError(label: string, filePath: string, error: unknown): Error {
  return new Error(
    `Failed to read ${label} at ${filePath}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
