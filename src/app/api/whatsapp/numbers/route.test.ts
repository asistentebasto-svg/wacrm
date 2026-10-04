import { describe, expect, it, vi, beforeEach } from 'vitest';

// requireRole se mockea: devuelve un contexto con el cliente falso y el
// rol pedido, o tira Unauthorized/Forbidden como el real.
const state: {
  role: 'owner' | 'admin' | 'agent' | 'viewer' | null;
  rows: Array<{ id: string; account_id: string; is_primary: boolean; label: string | null }>;
  deleteError?: { code?: string } | null;
} = { role: 'admin', rows: [], deleteError: null };

const ACC = 'acc-1';
const updates: Array<Record<string, unknown>> = [];
const deletes: string[] = [];

function fakeDb() {
  return {
    from() {
      const filters: Record<string, unknown> = {};
      let mode: 'select' | 'update' | 'delete' = 'select';
      let payload: Record<string, unknown> = {};
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: Record<string, unknown>) => { mode = 'update'; payload = p; return b; },
        delete: () => { mode = 'delete'; return b; },
        eq: (c: string, v: unknown) => { filters[c] = v; return b; },
        order: () => b,
        maybeSingle: async () => {
          const hit = state.rows.find(
            (r) => r.account_id === filters['account_id'] && r.id === filters['id'],
          );
          return { data: hit ? { id: hit.id } : null, error: null };
        },
        // await directo del builder (list / update / delete terminales)
        then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
          if (mode === 'update') {
            updates.push({ ...filters, ...payload });
            return resolve({ data: null, error: null });
          }
          if (mode === 'delete') {
            deletes.push(String(filters['id']));
            return resolve({ data: null, error: state.deleteError ?? null });
          }
          const inAccount = state.rows.filter((r) => r.account_id === filters['account_id']);
          return resolve({ data: inAccount, error: null });
        },
      };
      return b;
    },
  };
}

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>(
    '@/lib/auth/account',
  );
  return {
    ...actual,
    requireRole: vi.fn(async (min: string) => {
      if (state.role === null) throw new actual.UnauthorizedError();
      const rank: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 };
      if (rank[state.role] < rank[min]) throw new actual.ForbiddenError();
      return {
        supabase: fakeDb(),
        userId: 'u-1',
        accountId: ACC,
        role: state.role,
        account: { id: ACC, name: 'Acme' },
      };
    }),
  };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

import { GET, PATCH, DELETE } from './route';

beforeEach(() => {
  state.role = 'admin';
  state.rows = [
    { id: 'n1', account_id: ACC, is_primary: true, label: 'Ventas' },
    { id: 'n2', account_id: ACC, is_primary: false, label: null },
  ];
  state.deleteError = null;
  updates.length = 0;
  deletes.length = 0;
});

const patch = (body: unknown) =>
  PATCH(new Request('http://x/api/whatsapp/numbers', { method: 'PATCH', body: JSON.stringify(body) }));
const del = (id?: string) =>
  DELETE(new Request(`http://x/api/whatsapp/numbers${id ? `?id=${id}` : ''}`, { method: 'DELETE' }));

describe('GET /api/whatsapp/numbers', () => {
  it('lists the account numbers', async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.numbers.map((n: { id: string }) => n.id)).toEqual(['n1', 'n2']);
  });

  it('a viewer can list', async () => {
    state.role = 'viewer';
    expect((await GET()).status).toBe(200);
  });

  it('no session -> 401', async () => {
    state.role = null;
    expect((await GET()).status).toBe(401);
  });
});

describe('PATCH /api/whatsapp/numbers', () => {
  it('renames a number', async () => {
    const res = await patch({ id: 'n2', label: 'Soporte' });
    expect(res.status).toBe(200);
    expect(updates.some((u) => u.id === 'n2' && u.label === 'Soporte')).toBe(true);
  });

  it('setting primary clears the previous primary FIRST', async () => {
    const res = await patch({ id: 'n2', is_primary: true });
    expect(res.status).toBe(200);
    // un update baja todos los is_primary=true, otro sube n2
    const clear = updates.find((u) => u.is_primary === false && u.account_id === ACC);
    const set = updates.find((u) => u.id === 'n2' && u.is_primary === true);
    expect(clear).toBeTruthy();
    expect(set).toBeTruthy();
    expect(updates.indexOf(clear!)).toBeLessThan(updates.indexOf(set!));
  });

  it('an agent cannot edit (admin only) -> 403', async () => {
    state.role = 'agent';
    expect((await patch({ id: 'n2', label: 'x' })).status).toBe(403);
  });

  it('a number from another account -> 404', async () => {
    const res = await patch({ id: 'nope', label: 'x' });
    expect(res.status).toBe(404);
  });

  it('missing id -> 400', async () => {
    expect((await patch({ label: 'x' })).status).toBe(400);
  });
});

describe('DELETE /api/whatsapp/numbers', () => {
  it('disconnects a non-primary number', async () => {
    const res = await del('n2');
    expect(res.status).toBe(200);
    expect(deletes).toContain('n2');
  });

  it('refuses to delete the primary while other numbers exist -> 409', async () => {
    const res = await del('n1');
    expect(res.status).toBe(409);
    expect(deletes).not.toContain('n1');
  });

  it('allows deleting the primary when it is the only number', async () => {
    state.rows = [{ id: 'n1', account_id: ACC, is_primary: true, label: null }];
    expect((await del('n1')).status).toBe(200);
  });

  it('a number with conversations (FK 23503) -> 409 with a clear message', async () => {
    state.rows = [{ id: 'n1', account_id: ACC, is_primary: true, label: null }];
    state.deleteError = { code: '23503' };
    const res = await del('n1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/conversations/i);
  });

  it('missing id -> 400', async () => {
    expect((await del()).status).toBe(400);
  });
});
