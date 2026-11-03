import { describe, it, expect } from '@jest/globals';
import { questTaskInputSchema } from '../src/quests/taskValidation.js';
import { normalizeTasks, publicTask } from '../src/quests/taskNormalize.js';

// Plan 76: an AR task records how the creator placed the object.
const arTask = (placement?: unknown) => ({
  title: 'Find the gem',
  description: 'It sits by the lighthouse door.',
  checkpoint_type: 'ar',
  verification: {
    type: 'ar',
    fence: { lat: 16.1, lng: 120.3, radius_meters: 50 },
    object: 'gem',
    color: '#2D6A4F',
    ...(placement === undefined ? {} : { placement }),
  },
});

describe('AR placement (Plan 76)', () => {
  it('keeps a live placement through validation, normalisation and the public view', () => {
    const parsed = questTaskInputSchema.parse(arTask({ mode: 'ar_live', gps_accuracy_m: 4.2 }));
    const [task] = normalizeTasks([parsed]);
    expect((task.verification as any).placement).toEqual({ mode: 'ar_live', gps_accuracy_m: 4.2 });
    expect((publicTask(task).verification as any).placement).toEqual({ mode: 'ar_live', gps_accuracy_m: 4.2 });
  });

  it('leaves placement out when the client sends none (existing quests = map)', () => {
    const parsed = questTaskInputSchema.parse(arTask());
    expect((parsed.verification as any).placement).toBeUndefined();
  });

  it('rejects an unknown mode or a bad accuracy', () => {
    expect(questTaskInputSchema.safeParse(arTask({ mode: 'guess' })).success).toBe(false);
    expect(questTaskInputSchema.safeParse(arTask({ mode: 'ar_live', gps_accuracy_m: -1 })).success).toBe(false);
  });
});
