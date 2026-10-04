-- Fase 1 / B2: dedup de conversaciones por numero.
--
-- La clave unica de conversaciones pasa de (account_id, contact_id) a
-- (account_id, contact_id, whatsapp_config_id). Asi un mismo contacto que escribe
-- a dos numeros distintos de la misma cuenta tiene DOS conversaciones separadas.
-- Pareado con el lookup config-aware en resolve-conversation.ts y el webhook.
--
-- Seguro: cada cuenta tiene hoy 1 solo numero, asi que (account, contact) y
-- (account, contact, config) son equivalentes y no hay filas en conflicto. El
-- comportamiento solo cambia cuando una cuenta tenga 2+ numeros (post-fusion).
-- El indice de contactos (022_contact_phone_dedup) se deja: el contacto es la
-- persona, no el canal.
--
-- Aplicada en prod via MCP el 2026-10-03 (043_conversation_dedup_por_numero).

DROP INDEX IF EXISTS public.idx_conversations_account_contact;

CREATE UNIQUE INDEX idx_conversations_account_contact_config
  ON public.conversations (account_id, contact_id, whatsapp_config_id);
