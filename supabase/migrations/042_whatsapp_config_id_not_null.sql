-- Fase 1 (042): conversations.whatsapp_config_id -> NOT NULL
--
-- La 041 agrego la columna NULLABLE y backfilleo las 134 conversaciones. Con los
-- PR #4/#5 desplegados, toda conversacion nueva nace ya estampada con su numero, y
-- el conteo en prod da 0 NULL sobre 183. La marcamos NOT NULL para garantizar la
-- invariante "toda conversacion pertenece a un numero".
--
-- NOTA: el swap del indice de dedup (idx_conversations_account_contact, hoy UNIQUE
-- (account_id, contact_id)) a incluir whatsapp_config_id va APARTE (paso B2), porque
-- esta acoplado al cambio de lookup del codigo (resolve-conversation / webhook) y solo
-- cambia comportamiento cuando una cuenta tiene 2+ numeros (post-fusion de las cuentas).
--
-- Aplicada en prod via MCP el 2026-10-03 (apply_migration 042a_whatsapp_config_id_not_null).

ALTER TABLE public.conversations
  ALTER COLUMN whatsapp_config_id SET NOT NULL;
