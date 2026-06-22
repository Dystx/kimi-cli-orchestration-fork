import type { SkillDefinition } from '../../skill/types';

export interface ScoredSkill {
  readonly skill: SkillDefinition;
  readonly score: number;
}

export interface SkillRouterOptions {
  readonly limit?: number;
  readonly threshold?: number;
  readonly maxMessageChars?: number;
  /** Minimum message-token count to consider scoring; shorter prompts bail. */
  readonly minMessageTokens?: number;
  /** Minimum distinct token overlap between message and skill corpus. */
  readonly minOverlap?: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function candidateCorpus(skill: SkillDefinition): string[] {
  const meta = skill.metadata;
  const parts: string[] = [meta.name ?? '', meta.description ?? ''];
  if (typeof meta.whenToUse === 'string') parts.push(meta.whenToUse);
  if (Array.isArray((meta as { tags?: unknown }).tags)) {
    parts.push(((meta as { tags: string[] }).tags).join(' '));
  }
  return tokenize(parts.join(' '));
}

export function scoreSkills(
  message: string,
  skills: readonly SkillDefinition[],
  options?: SkillRouterOptions,
): readonly ScoredSkill[] {
  const limit = options?.limit ?? 2;
  // Default threshold kept conservative; minOverlap (default 2) is the
  // primary guard against single-token spurious matches. minMessageTokens
  // (default 6) prevents activating on tiny prompts like "yes" or "go".
  const threshold = options?.threshold ?? 0.25;
  const maxChars = options?.maxMessageChars ?? 2000;
  // Minimum message length to consider activating a skill. Shorter prompts
  // (e.g. "yes", "go", "thanks") are too ambiguous and historically fired
  // spurious skills — bail out before scoring.
  const minMessageTokens = options?.minMessageTokens ?? 6;
  // Minimum number of overlapping tokens between the message and the skill
  // corpus. A single shared token can match on a coincidental overlap
  // (e.g. "run" matching every skill whose corpus mentions "run"); require
  // at least two distinct tokens for a meaningful match.
  const minOverlap = options?.minOverlap ?? 2;

  const trimmed = message.slice(0, maxChars);
  const messageTokens = tokenize(trimmed);
  if (messageTokens.length < minMessageTokens) return [];

  const messageSet = new Set(messageTokens);

  const candidates: ScoredSkill[] = [];
  for (const skill of skills) {
    const meta = skill.metadata;
    if (meta.disableModelInvocation === true) continue;
    const type = meta.type;
    if (type !== undefined && type !== 'prompt' && type !== 'inline') continue;

    const corpus = candidateCorpus(skill);
    if (corpus.length === 0) continue;

    let overlap = 0;
    for (const token of corpus) {
      if (messageSet.has(token)) overlap += 1;
    }
    if (overlap < minOverlap) continue;
    const score = overlap / messageTokens.length;
    if (score >= threshold) {
      candidates.push({ skill, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}
