import agentYaml from './default/agent.yaml';
import architectYaml from './default/architect.yaml';
import coderYaml from './default/coder.yaml';
import debugYaml from './default/debug.yaml';
import docsYaml from './default/docs.yaml';
import exploreYaml from './default/explore.yaml';
import initMd from './default/init.md';
import performanceYaml from './default/performance.yaml';
import planYaml from './default/plan.yaml';
import reviewerYaml from './default/reviewer.yaml';
import securityYaml from './default/security.yaml';
import systemMd from './default/system.md';
import testYaml from './default/test.yaml';
import { loadAgentProfilesFromSources } from './load';

// Keyed by the source path the profile loader expects: profile YAML files
// plus any file referenced through `systemPromptPath`.
const PROFILE_SOURCES: Record<string, string> = {
  'profile/default/agent.yaml': agentYaml,
  'profile/default/architect.yaml': architectYaml,
  'profile/default/coder.yaml': coderYaml,
  'profile/default/debug.yaml': debugYaml,
  'profile/default/docs.yaml': docsYaml,
  'profile/default/explore.yaml': exploreYaml,
  'profile/default/performance.yaml': performanceYaml,
  'profile/default/plan.yaml': planYaml,
  'profile/default/reviewer.yaml': reviewerYaml,
  'profile/default/security.yaml': securityYaml,
  'profile/default/system.md': systemMd,
  'profile/default/test.yaml': testYaml,
};

export const DEFAULT_INIT_PROMPT = initMd;

export const DEFAULT_AGENT_PROFILES = loadAgentProfilesFromSources(
  [
    'agent.yaml',
    'architect.yaml',
    'coder.yaml',
    'debug.yaml',
    'docs.yaml',
    'explore.yaml',
    'performance.yaml',
    'plan.yaml',
    'reviewer.yaml',
    'security.yaml',
    'test.yaml',
  ].map((file) => `profile/default/${file}`),
  PROFILE_SOURCES,
);
