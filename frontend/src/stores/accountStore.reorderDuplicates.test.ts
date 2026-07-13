import { describe, expect, it } from 'vitest';
import type { Account } from '../types/models';
import { orderAccountsByIds } from './accountStore';

function account(id: string, username: string): Account {
  return {
    id,
    username,
    userId: `${id}-${username}`,
    nickname: '',
    cookie: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastUsed: null,
    donutProfileId: null,
    donutProfilePendingDelete: false,
  };
}

describe('orderAccountsByIds duplicate occurrence safety', () => {
  it('consumes repeated ids by occurrence without dropping or cloning records', () => {
    const firstDuplicate = account('same-id', 'first');
    const middle = account('other-id', 'middle');
    const secondDuplicate = account('same-id', 'second');
    const tail = account('tail-id', 'tail');
    const source = [firstDuplicate, middle, secondDuplicate, tail];

    const reordered = orderAccountsByIds(source, [
      'same-id',
      'same-id',
      'other-id',
      'same-id', // Excess occurrences must not clone the first match.
    ]);

    expect(reordered).toEqual([firstDuplicate, secondDuplicate, middle, tail]);
    expect(reordered).toHaveLength(source.length);
    expect(new Set(reordered)).toEqual(new Set(source));
  });

  it('appends omitted occurrences in their original relative order', () => {
    const firstDuplicate = account('same-id', 'first');
    const middle = account('other-id', 'middle');
    const secondDuplicate = account('same-id', 'second');
    const tail = account('tail-id', 'tail');

    expect(
      orderAccountsByIds(
        [firstDuplicate, middle, secondDuplicate, tail],
        ['other-id'],
      ),
    ).toEqual([middle, firstDuplicate, secondDuplicate, tail]);
  });
});
