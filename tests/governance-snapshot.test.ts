import { GovernanceStore } from '../src/governance/store.js';
import type { MemoryDb } from '../src/db/index.js';

describe('Detached governance snapshots', () => {
  it('isolates nested ledger metadata and restore inputs', async () => {
    const store = new GovernanceStore({ users: [], findUserById: () => undefined } as unknown as MemoryDb);
    await store.creditQuestReward('u', 'q', 's', 10, 'admin');
    const snapshot = store.snapshot();
    const original = snapshot.ledger[0].metadata!.counterparty;
    snapshot.ledger[0].metadata!.counterparty = 'changed';
    expect(store.snapshot().ledger[0].metadata!.counterparty).toBe(original);
    store.restore(snapshot);
    snapshot.ledger[0].metadata!.counterparty = 'changed-again';
    expect(store.snapshot().ledger[0].metadata!.counterparty).toBe('changed');
  });
});
