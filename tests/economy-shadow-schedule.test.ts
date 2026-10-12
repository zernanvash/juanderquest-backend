import { parseShadowRunArgs } from '../scripts/economy-legacy-audit';

describe('bounded read-only shadow schedule', () => {
  it('defaults to one sample and accepts a finite repeated run', () => {
    expect(parseShadowRunArgs([])).toEqual({ samples: 1, intervalMs: 60_000 });
    expect(parseShadowRunArgs(['--samples=3', '--interval-ms=1000']))
      .toEqual({ samples: 3, intervalMs: 1000 });
  });

  it.each([
    ['--samples=0'], ['--samples=289'], ['--samples=1.5'],
    ['--interval-ms=999'], ['--interval-ms=86400001'],
    ['--samples=2', '--samples=3'], ['--database=juanderquest_alpha'],
  ])('rejects unsafe or unbounded CLI argument %j', (...args) => {
    expect(() => parseShadowRunArgs(args)).toThrow('INVALID_SHADOW_SCHEDULE');
  });
});
