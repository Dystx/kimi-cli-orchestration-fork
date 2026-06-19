import type { SkillDefinition } from '../../skill/types';

export interface ScoredSkill {
  readonly skill: SkillDefinition;
  readonly score: number;
}

export interface SkillRouterOptions {
  readonly limit?: number;
  readonly threshold?: number;
  readonly maxMessageChars?: number;
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
  const threshold = options?.threshold ?? 0.2;
  const maxChars = options?.maxMessageChars ?? 2000;

  const trimmed = message.slice(0, maxChars);
  const messageTokens = tokenize(trimmed);
  if (messageTokens.length === 0) return [];

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
    const score = overlap / messageTokens.length;
    if (score >= threshold) {
      candidates.push({ skill, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}
