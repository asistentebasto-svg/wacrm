import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  resolveWhatsAppConfigId,
  resolveWhatsAppConfig,
  resolveWhatsAppConfigForConversation,
} from './resolve-config';

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

interface Conv { id: string; account_id: string; whatsapp_config_id: string | null }
interface Script {
  rows: Row[];
  conversations?: Conv[];
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
  // Full-row load (resolveWhatsAppConfig) y lookup de conversations
  // (resolveWhatsAppConfigForConversation) sobre las mismas filas.
  function fullBuilder(tabla: string) {
    const filters: Record<string, unknown> = {};
    return {
      select: () => fullBuilder(tabla),
      eq: (c: string, v: unknown) => {
        filters[c] = v;
        return fullBuilder(tabla);
      },
      maybeSingle: () => {
        if (tabla === 'whatsapp_config') {
          const hit = script.rows.find((r) => r.id === filters['id']);
          return Promise.resolve({ data: hit ?? null, error: null });
        }
        if (tabla === 'conversations') {
          const conv = (script.conversations ?? []).find(
            (c) => c.id === filters['id'] && c.account_id === filters['account_id'],
          );
          return Promise.resolve({ data: conv ? { whatsapp_config_id: conv.whatsapp_config_id } : null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  const db = {
    from: (t: string) => (t === 'whatsapp_config' || t === 'conversations')
      ? // el id-load y el lookup de conversation usan maybeSingle directo;
        // el resto del flujo (primary/fallback) usa el builder original.
        makeRouter(t)
      : builder(),
  } as unknown as SupabaseClient;

  // Router: decide entre el builder "por shape" (id lookups / conversations)
  // y el builder de precedencia (primary/fallback por account) segun los
  // metodos que se encadenen. Simplificacion: si se llama .maybeSingle es
  // full/conversation; si se llama .limit es precedencia.
  function makeRouter(tabla: string) {
    const filters: Record<string, unknown> = {};
    const self: Record<string, unknown> = {
      select: () => self,
      eq: (c: string, v: unknown) => { filters[c] = v; return self; },
      order: () => self,
      maybeSingle: () => {
        if (tabla === 'whatsapp_config') {
          // byId (resolveWhatsAppConfig full-row) o byId+account (opts.configId)
          const hit = script.rows.find((r) =>
            (filters['id'] === undefined || r.id === filters['id']) &&
            (filters['account_id'] === undefined || r.account_id === filters['account_id']));
          calls.push('byId');
          if (script.errorOn === 'byId') return Promise.resolve({ data: null, error: { message: 'boom' } });
          return Promise.resolve({ data: hit ? { ...hit } : null, error: null });
        }
        // conversations
        const conv = (script.conversations ?? []).find(
          (c) => c.id === filters['id'] && c.account_id === filters['account_id']);
        return Promise.resolve({ data: conv ? { whatsapp_config_id: conv.whatsapp_config_id } : null, error: null });
      },
      limit: () => {
        const inAccount = script.rows.filter((r) => r.account_id === filters['account_id']);
        if (filters['is_primary'] === true) {
          calls.push('primary');
          if (script.errorOn === 'primary') return Promise.resolve({ data: null, error: { message: 'boom' } });
          return Promise.resolve({ data: inAccount.filter((r) => r.is_primary).map((r) => ({ ...r })), error: null });
        }
        calls.push('fallback');
        if (script.errorOn === 'fallback') return Promise.resolve({ data: null, error: { message: 'boom' } });
        const sorted = [...inAccount].sort((a, z) => a.created_at.localeCompare(z.created_at));
        return Promise.resolve({ data: sorted.slice(0, 1).map((r) => ({ ...r })), error: null });
      },
    };
    return self;
  }
  void fullBuilder;
  void builder;

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

  it('resolveWhatsAppConfig returns the full row of the primary', async () => {
    const { db } = makeDb({
      rows: [
        base({ id: 'prim', is_primary: true }),
        base({ id: 'secun' }),
      ],
    });
    const row = await resolveWhatsAppConfig(db, ACC);
    expect(row?.id).toBe('prim');
    expect(row?.account_id).toBe(ACC);
  });

  it('resolveWhatsAppConfig returns null when there is no number', async () => {
    const { db } = makeDb({ rows: [] });
    expect(await resolveWhatsAppConfig(db, ACC)).toBeNull();
  });

  it('forConversation returns the number the conversation is ON, not the primary', async () => {
    // El corazon de la Fase 1: responder por el numero al que escribieron.
    const { db } = makeDb({
      rows: [
        base({ id: 'prim', is_primary: true }),
        base({ id: 'secun', is_primary: false }),
      ],
      conversations: [{ id: 'cv-1', account_id: ACC, whatsapp_config_id: 'secun' }],
    });
    const row = await resolveWhatsAppConfigForConversation(db, ACC, 'cv-1');
    expect(row?.id).toBe('secun');
  });

  it('forConversation con whatsapp_config_id null cae al primario (conversacion vieja)', async () => {
    const { db } = makeDb({
      rows: [base({ id: 'prim', is_primary: true })],
      conversations: [{ id: 'cv-old', account_id: ACC, whatsapp_config_id: null }],
    });
    const row = await resolveWhatsAppConfigForConversation(db, ACC, 'cv-old');
    expect(row?.id).toBe('prim');
  });

  it('forConversation de otra cuenta no resuelve (tenancy)', async () => {
    const { db } = makeDb({
      rows: [base({ id: 'prim', is_primary: true })],
      conversations: [{ id: 'cv-x', account_id: OTHER, whatsapp_config_id: 'prim' }],
    });
    // La conversacion no es de ACC -> no se encuentra -> sin config_id ->
    // cae al primario de ACC igual (la tenancy real la da el .eq account_id
    // del lookup, que aca no matchea y devuelve null).
    const row = await resolveWhatsAppConfigForConversation(db, ACC, 'cv-x');
    expect(row?.id).toBe('prim');
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
