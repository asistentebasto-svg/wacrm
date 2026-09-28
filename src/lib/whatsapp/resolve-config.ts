// ============================================================
// Resolve WHICH WhatsApp number a row belongs to, within an account.
//
// Until Fase 1, an account had exactly one `whatsapp_config` row
// (UNIQUE(account_id)), so "the account's config" was unambiguous and
// call sites did `.eq('account_id', id).single()`. Fase 1 drops that
// unique constraint so a department can connect several numbers, which
// breaks every `.single()`: two rows now surface as an error.
//
// This helper is the single place that answers "which config?":
//   - a specific `configId` when the caller picked a number (an inbox
//     reply, a broadcast from a chosen sender), scoped to the account
//     so one tenant can't address another's number;
//   - otherwise the account's PRIMARY number (`is_primary = true`),
//     which is the "send from here unless told otherwise" default.
//
// It returns only the id, because its first job is to stamp
// `conversations.whatsapp_config_id` on the three paths that create a
// conversation (inbound webhook, outbound send, the public-API
// resolver). The send path itself still loads the full row (token,
// phone_number_id) separately; consolidating that is the rest of the
// Fase 1 refactor and is deliberately not done here.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The whatsapp_config row shape the send paths use. Not exhaustive —
 * just the columns callers read. `select('*')` returns the rest too.
 */
export interface WhatsAppConfigRow {
  id: string;
  account_id: string;
  user_id: string;
  phone_number_id: string;
  waba_id: string | null;
  access_token: string;
  status: string;
  is_primary: boolean;
  label: string | null;
  mirror_inbound_media: boolean;
  [key: string]: unknown;
}

export interface ResolveConfigOptions {
  /** A specific number the caller chose. Ignored if it isn't this
   *  account's — the fallback to primary then applies, so a bad id
   *  degrades to the default rather than addressing another tenant. */
  configId?: string | null;
}

/**
 * Return the `whatsapp_config.id` a new row in `accountId` should carry,
 * or `null` when the account has no connected number.
 *
 * Never throws: a missing config is a normal state (an account created
 * before WhatsApp was connected), and each caller already handles the
 * "no number" case its own way. Errors are logged and collapse to null.
 */
export async function resolveWhatsAppConfigId(
  db: SupabaseClient,
  accountId: string,
  opts: ResolveConfigOptions = {},
): Promise<string | null> {
  // Caller picked a number: honour it only if it belongs to this
  // account. The account scope is the tenancy check — without it a
  // caller could stamp a conversation with another tenant's config id.
  if (opts.configId) {
    const { data, error } = await db
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', opts.configId)
      .maybeSingle();
    if (error) {
      console.error('[resolve-config] configId lookup error:', error.message);
      // fall through to primary rather than failing the whole send
    } else if (data) {
      return data.id;
    }
    // configId given but not found in this account -> use the default.
  }

  // Default: the account's primary number. `.limit(1)` rather than
  // `.single()` on purpose — `.single()` is exactly what Fase 1 breaks,
  // and a partial unique index guarantees at most one primary anyway.
  const primary = await db
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .eq('is_primary', true)
    .limit(1);
  if (primary.error) {
    console.error('[resolve-config] primary lookup error:', primary.error.message);
    return null;
  }
  if (primary.data && primary.data.length > 0) {
    return primary.data[0].id;
  }

  // No primary flagged (shouldn't happen: every account gets one at
  // signup and the merge keeps one). Fall back to the oldest config so
  // the account still works instead of silently dropping to "no number".
  const any = await db
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1);
  if (any.error) {
    console.error('[resolve-config] fallback lookup error:', any.error.message);
    return null;
  }
  return any.data && any.data.length > 0 ? any.data[0].id : null;
}

/**
 * Like `resolveWhatsAppConfigId`, but returns the WHOLE config row
 * (access_token, phone_number_id, …) — what the send paths need to
 * actually call Meta. Same precedence: a valid account-scoped
 * `configId`, else the primary, else the oldest.
 *
 * The send core passes the conversation's `whatsapp_config_id` as
 * `configId`, so a reply goes out FROM the number the customer wrote
 * to. A legacy conversation with a null id (created before Fase 1)
 * falls through to the primary, which before the merge is the only
 * number anyway — so behaviour is unchanged until an account actually
 * has two.
 *
 * Returns `null` when the account has no connected number.
 */
export async function resolveWhatsAppConfig(
  db: SupabaseClient,
  accountId: string,
  opts: ResolveConfigOptions = {},
): Promise<WhatsAppConfigRow | null> {
  const id = await resolveWhatsAppConfigId(db, accountId, opts);
  if (!id) return null;

  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('[resolve-config] row load error:', error.message);
    return null;
  }
  return (data as WhatsAppConfigRow) ?? null;
}

/**
 * The full config to REPLY on within a conversation: the number the
 * conversation is on. Loads `conversations.whatsapp_config_id`
 * (account-scoped) and resolves the row, falling back to the account's
 * primary for a legacy conversation whose id is still null.
 *
 * This is the "answer from the number they wrote to" primitive shared by
 * the send core and the flow/automation engines. Returns null when the
 * conversation isn't found in this account or the account has no number.
 */
export async function resolveWhatsAppConfigForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<WhatsAppConfigRow | null> {
  const { data: conv, error } = await db
    .from('conversations')
    .select('whatsapp_config_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.error('[resolve-config] conversation config lookup error:', error.message);
    return null;
  }
  const configId = (conv?.whatsapp_config_id as string | null | undefined) ?? undefined;
  return resolveWhatsAppConfig(db, accountId, { configId });
}
