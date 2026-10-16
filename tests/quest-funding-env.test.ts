import { questFundingEnabledByDefault } from '../src/config/env.js';

describe('funded quest production default', () => {
  it.each([
    ['prod', 'development', false],
    ['production', 'development', false],
    ['alpha', 'development', false],
    ['public', 'development', false],
    ['dev', 'development', true],
    ['local', 'test', true],
    [undefined, 'development', true],
    ['dev', 'production', false],
  ])('profile=%s NODE_ENV=%s -> enabledByDefault=%s', (profile, nodeEnv, expected) => {
    expect(questFundingEnabledByDefault(profile, nodeEnv)).toBe(expected);
  });
});
