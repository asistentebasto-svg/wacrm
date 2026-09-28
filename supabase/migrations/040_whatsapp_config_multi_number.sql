-- Fase 1A — varios numeros de WhatsApp por cuenta.
--
-- Hoy whatsapp_config tiene UNIQUE(account_id): una cuenta = un numero. Esta
-- migracion saca ese candado para que un departamento pueda conectar varios
-- numeros, y agrega con que distinguirlos (is_primary) y nombrarlos (label).
--
-- Se CONSERVA UNIQUE(phone_number_id): es lo que rutea cada numero entrante a
-- su config. Es aditiva y no mueve filas entre cuentas (eso es el merge, aparte).
--
-- Aplicada en produccion via MCP el 2026-09-28 (fase1a_whatsapp_config_n_numeros).
-- Este archivo la deja en la historia del repo, que la CI replaya en limpio.

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;

-- Cada cuenta tiene hoy exactamente un config: ese es el primario.
UPDATE public.whatsapp_config SET is_primary = true;

ALTER TABLE public.whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- A lo sumo un primario por cuenta (reemplaza al candado viejo).
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_config_primary_por_cuenta
  ON public.whatsapp_config (account_id)
  WHERE is_primary;

-- DOWN:
--   DROP INDEX IF EXISTS public.uq_whatsapp_config_primary_por_cuenta;
--   ALTER TABLE public.whatsapp_config DROP COLUMN IF EXISTS is_primary, DROP COLUMN IF EXISTS label;
--   ALTER TABLE public.whatsapp_config ADD CONSTRAINT whatsapp_config_account_id_key UNIQUE (account_id);
