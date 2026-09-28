'use client';

// Lista de números de WhatsApp de la cuenta (Fase 1). Vive arriba del
// formulario de conexión de un número: ese formulario da de alta uno
// nuevo, esta lista muestra y administra los que ya están.
//
// Lee de /api/whatsapp/numbers (no llama a Meta: es rápido). Renombrar,
// elegir primario y desconectar pegan a la misma ruta. La API exige
// admin para escribir; acá igual mostramos los controles y, si vuelve
// 403, sale un toast — el gate real es el server.

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Star, Pencil, Check, X, Loader2, Unplug } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

interface WaNumber {
  id: string;
  label: string | null;
  phone_number_id: string;
  status: string;
  is_primary: boolean;
}

export function WhatsAppNumbersList() {
  const t = useTranslations('Settings.whatsappNumbers');
  const [numbers, setNumbers] = useState<WaNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/numbers');
      if (!res.ok) {
        setNumbers([]);
        return;
      }
      const body = await res.json();
      setNumbers(body.numbers ?? []);
    } catch {
      setNumbers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(id: string, payload: Record<string, unknown>) {
    setBusy(id);
    try {
      const res = await fetch('/api/whatsapp/numbers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...payload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? t('errorGeneric'));
        return;
      }
      await load();
    } finally {
      setBusy(null);
      setEditing(null);
    }
  }

  async function disconnect(id: string) {
    if (!window.confirm(t('confirmDisconnect'))) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/whatsapp/numbers?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? t('errorGeneric'));
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  // Un solo número: la lista no aporta nada por encima del formulario.
  // Se muestra recién cuando la cuenta tiene dos o más (post-merge).
  if (loading || numbers.length < 2) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {numbers.map((n) => {
          const isBusy = busy === n.id;
          return (
            <div
              key={n.id}
              className="flex items-center gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0 flex-1">
                {editing === n.id ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={t('labelPlaceholder')}
                      className="h-8"
                      autoFocus
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      disabled={isBusy}
                      onClick={() => patch(n.id, { label: draft.trim() || null })}
                      aria-label={t('save')}
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => setEditing(null)}
                      aria-label={t('cancel')}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-foreground">
                      {n.label || t('unnamed')}
                    </span>
                    {n.is_primary && (
                      <Badge variant="secondary" className="gap-1">
                        <Star className="h-3 w-3" />
                        {t('primary')}
                      </Badge>
                    )}
                    <Badge variant={n.status === 'connected' ? 'default' : 'outline'}>
                      {t(n.status === 'connected' ? 'connected' : 'disconnected')}
                    </Badge>
                  </div>
                )}
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  ID {n.phone_number_id}
                </p>
              </div>

              {editing !== n.id && (
                <div className="flex items-center gap-1">
                  {isBusy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    disabled={isBusy}
                    onClick={() => {
                      setDraft(n.label ?? '');
                      setEditing(n.id);
                    }}
                    aria-label={t('rename')}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {!n.is_primary && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isBusy}
                      onClick={() => patch(n.id, { is_primary: true })}
                    >
                      {t('makePrimary')}
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive"
                    disabled={isBusy}
                    onClick={() => disconnect(n.id)}
                    aria-label={t('disconnect')}
                  >
                    <Unplug className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
