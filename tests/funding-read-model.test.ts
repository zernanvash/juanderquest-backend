import type { Pool } from 'pg';
import { publicFundingSummaries } from '../src/funding/readModel.js';

describe('public funded quest summaries', () => {
  it('does not query funding details when no active plan exists', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(publicFundingSummaries({ query } as unknown as Pool, ['quest-1'], false)).resolves.toEqual(new Map());
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('projects the latest active plan, remaining estimate, sponsors and voucher perk', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'plan-1', quest_id: 'quest-1', mode: 'budget', status: 'active',
        ends_at: '2026-10-18T00:00:00.000Z', reward_points: 50, fee_points: 3, planned_completions: 3, round_number: 2 }] })
      .mockResolvedValueOnce({ rows: [{ plan_id: 'plan-1', available_points: '106' }] })
      .mockResolvedValueOnce({ rows: [{ plan_id: 'plan-1', name: 'Local Cafe', logo_url: null }] })
      .mockResolvedValueOnce({ rows: [{ plan_id: 'plan-1', title: 'Local treat', remaining: 2, id: 'perk-1' }] });

    const result = await publicFundingSummaries({ query } as unknown as Pool, ['quest-1'], false);
    expect(result.get('quest-1')).toEqual({
      mode: 'budget',
      status: 'active',
      ends_at: '2026-10-18T00:00:00.000Z',
      reward_points: 50,
      completions_left_estimate: 2,
      sponsors: [{ name: 'Local Cafe', logo: null }],
      perk: { title: 'Local treat', remaining: 2 },
      simulated: true,
    });
    expect(query).toHaveBeenCalledTimes(4);
  });
});
