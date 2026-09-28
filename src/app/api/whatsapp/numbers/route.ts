// ============================================================
// GET/PATCH/DELETE /api/whatsapp/numbers
//
// La LISTA de números de WhatsApp de la cuenta (Fase 1). Aparte del
// `/api/whatsapp/config` de siempre a propósito: ese maneja el alta de
// UN número (formulario + verificación contra Meta) y sigue como está.
// Esta ruta es la que la pantalla de "números conectados" consume para
// ver, etiquetar, elegir primario y desconectar cada número.
//
// GET no llama a Meta: lee la base y es rápido, para pintar la lista.
// El estado real contra Meta lo sigue dando el `config` GET por número
// cuando hace falta.
// ============================================================

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

interface NumberRow {
  id: string;
  label: string | null;
  phone_number_id: string;
  waba_id: string | null;
  status: string;
  is_primary: boolean;
  created_at: string;
}

/** GET — lista los números de la cuenta, primario primero. */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');

    const { data, error } = await supabase
      .from('whatsapp_config')
      .select('id, label, phone_number_id, waba_id, status, is_primary, created_at')
      .eq('account_id', accountId)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[whatsapp/numbers GET]', error.message);
      return NextResponse.json({ error: 'Failed to load numbers' }, { status: 500 });
    }

    return NextResponse.json({ numbers: (data ?? []) as NumberRow[] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH — renombrar un número y/o marcarlo primario.
 * Body: { id: string, label?: string | null, is_primary?: true }
 *
 * Marcar primario desmarca al anterior primero: el índice único parcial
 * `uq_whatsapp_config_primary_por_cuenta` permite un solo primario por
 * cuenta, así que poner el nuevo sin bajar el viejo daría 23505.
 */
export async function PATCH(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const body = (await request.json().catch(() => null)) as {
      id?: string;
      label?: string | null;
      is_primary?: boolean;
    } | null;

    const id = body?.id;
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    // El número tiene que ser de esta cuenta (tenancy). RLS ya lo scopea,
    // pero lo chequeamos explícito para dar un 404 claro en vez de un
    // update de 0 filas silencioso.
    const { data: target, error: findErr } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (findErr) {
      console.error('[whatsapp/numbers PATCH] find:', findErr.message);
      return NextResponse.json({ error: 'Failed to update number' }, { status: 500 });
    }
    if (!target) {
      return NextResponse.json({ error: 'Number not found' }, { status: 404 });
    }

    if (body?.is_primary === true) {
      // Bajar el primario actual antes de subir el nuevo, si no el índice
      // único parcial rechaza el segundo primario.
      const { error: clearErr } = await supabase
        .from('whatsapp_config')
        .update({ is_primary: false })
        .eq('account_id', accountId)
        .eq('is_primary', true);
      if (clearErr) {
        console.error('[whatsapp/numbers PATCH] clear primary:', clearErr.message);
        return NextResponse.json({ error: 'Failed to set primary' }, { status: 500 });
      }
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body?.label !== undefined) patch.label = body.label;
    if (body?.is_primary === true) patch.is_primary = true;

    const { error: updErr } = await supabase
      .from('whatsapp_config')
      .update(patch)
      .eq('account_id', accountId)
      .eq('id', id);
    if (updErr) {
      console.error('[whatsapp/numbers PATCH] update:', updErr.message);
      return NextResponse.json({ error: 'Failed to update number' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/whatsapp/numbers?id=... — desconecta un número puntual.
 *
 * No se puede borrar el primario mientras haya otros números (hay que
 * elegir un nuevo primario antes) ni un número con conversaciones (el FK
 * `ON DELETE NO ACTION` lo frena; devolvemos un mensaje entendible en vez
 * del error crudo de Postgres).
 */
export async function DELETE(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const id = new URL(request.url).searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'id query param is required' }, { status: 400 });
    }

    const { data: rows, error: listErr } = await supabase
      .from('whatsapp_config')
      .select('id, is_primary')
      .eq('account_id', accountId);
    if (listErr) {
      console.error('[whatsapp/numbers DELETE] list:', listErr.message);
      return NextResponse.json({ error: 'Failed to delete number' }, { status: 500 });
    }

    const target = (rows ?? []).find((r) => r.id === id);
    if (!target) {
      return NextResponse.json({ error: 'Number not found' }, { status: 404 });
    }
    if (target.is_primary && (rows ?? []).length > 1) {
      return NextResponse.json(
        { error: 'Set another number as primary before disconnecting this one.' },
        { status: 409 },
      );
    }

    const { error: delErr } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id);
    if (delErr) {
      // 23503 = foreign_key_violation: hay conversaciones colgando de este número.
      if ((delErr as { code?: string }).code === '23503') {
        return NextResponse.json(
          {
            error:
              'This number has conversations and cannot be disconnected. Its history would be orphaned.',
          },
          { status: 409 },
        );
      }
      console.error('[whatsapp/numbers DELETE]', delErr.message);
      return NextResponse.json({ error: 'Failed to delete number' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
