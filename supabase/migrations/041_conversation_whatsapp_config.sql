-- Fase 1B1 — cada conversacion sabe por que NUMERO entro.
--
-- Con un numero por cuenta, saber la cuenta alcanzaba. Con varios (migracion
-- 040), la misma persona escribiendo a dos numeros son DOS conversaciones. Esta
-- parte agrega la columna NULLABLE y backfillea el historico.
--
-- ⚠️ NO se pone NOT NULL ni se cambia el indice de dedup (036) todavia: el CRM
-- en produccion recien empieza a setear este campo con el deploy que acompana a
-- esta migracion. El NOT NULL y el swap del indice a
-- (account_id, contact_id, whatsapp_config_id) van en una migracion 042 posterior,
-- una vez que todo conversation nuevo traiga el campo.
--
-- FK con ON DELETE NO ACTION (el default) a proposito: al borrar una CUENTA su
-- cascade se lleva conversaciones y configs a la vez (no falla), pero borrar un
-- config suelto con conversaciones SI falla y protege el historial.
--
-- Aplicada en produccion via MCP el 2026-09-28 (fase1b1_conversations_config_id_nullable).

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES public.whatsapp_config(id);

-- Backfill: cada cuenta tiene un solo config, asi que el numero de cada
-- conversacion es el unico config de su cuenta. No ambiguo.
UPDATE public.conversations c
SET whatsapp_config_id = wc.id
FROM public.whatsapp_config wc
WHERE wc.account_id = c.account_id
  AND c.whatsapp_config_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON public.conversations (whatsapp_config_id);

-- DOWN:
--   ALTER TABLE public.conversations DROP COLUMN IF EXISTS whatsapp_config_id;
