import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveWhatsAppConfigId } from './resolve-config';

// ------------------------------------------------------------
// Fake Supabase scoped to whatsapp_config. The helper issues up to
// three shapes; the stub recognises each by which eq()/order() were
// chained and answers from the scripted rows.
//
//   A. configId given:  .eq('account_id').eq('id').maybeSingle()
//   B. primary:         .eq('account_id').eq('is_primary', true).limit(1)
//   C. fallback oldest: .eq('account_id').order('created_at').limit(1)
// ------------------------------------------------------------
interface Row { id: string; account_id: string; is_primary: boolean; created_at: string }

interface Script {
  rows: Row[];
  /** Force an error on a given shape, to prove it fails closed / falls through. */
  errorOn?: 'byId' | 'primary' | 'fallback';
}

function makeDb(script: Script) {
  const calls: string[] = [];
  function builder(accountId?: string) {
    const filters: Record<string, unknown> = {};
    let ordered = false;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return b;
      },
      order: () => {
        ordered = true;
        return b;
      },
      maybeSingle: () => {
        // shape A
        calls.push('byId');
        if (script.errorOn === 'byId')
          return Promise.resolve({ data: null, error: { message: 'boom' } });
        const hit = script.rows.find(
          (r) => r.account_id === filters['account_id'] && r.id === filters['id'],
        );
        return Promise.resolve({ data: hit ? { id: hit.id } : null, error: null });
      },
      limit: () => {
        const inAccount = script.rows.filter(
          (r) => r.account_id === filters['account_id'],
        );
        if (filters['is_primary'] === true) {
          // shape B
          calls.push('primary');
          if (script.errorOn === 'primary')
            return Promise.resolve({ data: null, error: { message: 'boom' } });
          const p = inAccount.filter((r) => r.is_primary);
          return Promise.resolve({ data: p.map((r) => ({ id: r.id })), error: null });
        }
        // shape C
        calls.push('fallback');
        if (script.errorOn === 'fallback')
          return Promise.resolve({ data: null, error: { message: 'boom' } });
        const sorted = ordered
          ? [...inAccount].sort((a, z) => a.created_at.localeCompare(z.created_at))
          : inAccount;
        return Promise.resolve({
          data: sorted.slice(0, 1).map((r) => ({ id: r.id })),
          error: null,
        });
      },
    };
    return b;
  }
  const db = { from: () => builder() } as unknown as SupabaseClient;
  return { db, calls };
}

const ACC = 'acc-1';
const OTHER = 'acc-2';
const base = (over: Partial<Row>): Row => ({
  id: 'x', account_id: ACC, is_primary: false, created_at: '2026-01-01', ...over,
});

describe('resolveWhatsAppConfigId', () => {
  it('returns the primary number by default', async () => {
    const { db } = makeDb({
      rows: [
        base({ id: 'prim', is_primary: true }),
        base({ id: 'secun', is_primary: false }),
      ],
    });
    expect(await resolveWhatsAppConfigId(db, ACC)).toBe('prim');
  });

  it('honours a specific configId when it belongs to the account', async () => {
    const { db } = makeDb({
      rows: [base({ id: 'prim', is_primary: true }), base({ id: 'secun' })],
    });
    expect(await resolveWhatsAppConfigId(db, ACC, { configId: 'secun' })).toBe('secun');
  });

  it("ignores a configId from ANOTHER account and falls back to this account's primary", async () => {
    // Tenancy: a caller must not be able to stamp a conversation with a
    // number that isn't theirs. The foreign id resolves to null on the
    // account-scoped lookup, and the default (primary) applies.
    const { db, calls } = makeDb({
      rows: [
        base({ id: 'mine', is_primary: true }),
        base({ id: 'theirs', account_id: OTHER, is_primary: true }),
      ],
    });
    expect(await resolveWhatsAppConfigId(db, ACC, { configId: 'theirs' })).toBe('mine');
    expect(calls).toContain('byId');   // tried the specific one
    expect(calls).toContain('primary'); // then fell back
  });

  it('falls back to the oldest config when no primary is flagged', async () => {
    const { db, calls } = makeDb({
      rows: [
        base({ id: 'nuevo', created_at: '2026-05-01' }),
        base({ id: 'viejo', created_at: '2026-01-01' }),
      ],
    });
    expect(await resolveWhatsAppConfigId(db, ACC)).toBe('viejo');
    expect(calls).toEqual(['primary', 'fallback']);
  });

  it('returns null when the account has no number', async () => {
    const { db } = makeDb({ rows: [] });
    expect(await resolveWhatsAppConfigId(db, ACC)).toBeNull();
  });

  it('a DB error on the primary lookup fails closed (null), does not throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb({ rows: [base({ id: 'prim', is_primary: true })], errorOn: 'primary' });
    expect(await resolveWhatsAppConfigId(db, ACC)).toBeNull();
    spy.mockRestore();
  });

  it('a configId lookup error degrades to primary rather than throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb({
      rows: [base({ id: 'prim', is_primary: true })],
      errorOn: 'byId',
    });
    expect(await resolveWhatsAppConfigId(db, ACC, { configId: 'whatever' })).toBe('prim');
    spy.mockRestore();
  });
});
