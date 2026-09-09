import { rankedFeedPage } from '../src/feed-pagination.js';

describe('live ranked feed pagination', () => {
  it('includes newly ranked posts without repeating previously served posts', () => {
    const first = rankedFeedPage([{ id: 'a' }, { id: 'b' }], 'guest', undefined, 1);
    const second = rankedFeedPage([{ id: 'new' }, { id: 'a' }, { id: 'b' }], 'guest', first.cursor, 1);
    expect(second.items).toEqual([{ id: 'new' }]);
    const third = rankedFeedPage([{ id: 'new' }, { id: 'a' }, { id: 'b' }], 'guest', second.cursor, 1);
    expect(third.items).toEqual([{ id: 'b' }]);
    expect(third.has_more).toBe(false);
    expect(rankedFeedPage([{ id: 'later' }, { id: 'b' }], 'guest', third.cursor, 1).items)
      .toEqual([{ id: 'later' }]);
  });
  it('replays an already served page and rejects another account cursor', () => {
    const ranked = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const first = rankedFeedPage(ranked, 'u1', undefined, 1);
    rankedFeedPage(ranked, 'u1', first.cursor, 1);
    expect(rankedFeedPage([...ranked].reverse(), 'u1', first.cursor, 1).items).toEqual([{ id: 'b' }]);
    expect(() => rankedFeedPage(ranked, 'u2', first.cursor, 1)).toThrow('INVALID_CURSOR');
    expect(() => rankedFeedPage(ranked, 'u1', 'invalid', 1)).toThrow('INVALID_CURSOR');
  });

  it('handles empty feed lists gracefully', () => {
    const res = rankedFeedPage([], 'guest', undefined, 10);
    expect(res.items).toEqual([]);
    expect(res.has_more).toBe(false);
    expect(res.total).toBe(0);
  });

  it('returns empty array and has_more false when requesting with caught up cursor and no new items', () => {
    const list = [{ id: '1' }, { id: '2' }];
    const page1 = rankedFeedPage(list, 'guest', undefined, 2);
    expect(page1.items.length).toBe(2);
    expect(page1.has_more).toBe(false);

    // Call again with cursor when no new items have appeared
    const page2 = rankedFeedPage(list, 'guest', page1.cursor, 2);
    expect(page2.items).toEqual([]);
    expect(page2.has_more).toBe(false);

    // Now a new item appears in the pool
    const updatedList = [{ id: '3' }, { id: '1' }, { id: '2' }];
    const page3 = rankedFeedPage(updatedList, 'guest', page2.cursor, 2);
    expect(page3.items).toEqual([{ id: '3' }]);
  });

  it('rejects malformed cursor payloads', () => {
    // Non-JSON base64url
    const badBase64 = Buffer.from('hello world').toString('base64url');
    expect(() => rankedFeedPage([{ id: '1' }], 'guest', badBase64, 10)).toThrow('INVALID_CURSOR');

    // Negative offset
    const negativeOffset = Buffer.from(JSON.stringify({ id: 'some-id', offset: -5 })).toString('base64url');
    expect(() => rankedFeedPage([{ id: '1' }], 'guest', negativeOffset, 10)).toThrow('INVALID_CURSOR');
  });
});
