/**
 * Rooms-relay endpoint resolution, factored out of collab-ui so LIGHT
 * consumers (the invite seed prefetcher, fired from the always-loaded
 * Receive pill) can build a RoomsClient without pulling the Loro wasm
 * chunk. Resolution order: settings → dev env → baked desktop default
 * (same base + shared token card sharing uses).
 */

import { settings } from '../settings.js';
import { getElectronHost } from '../host/index.js';
import { collabDevRelay } from './collab-gate.js';
import { RoomsClient, RoomsError } from './room-client.js';

/** Baked relay endpoint from the desktop main process — resolved once,
 *  used as the LAST fallback so packaged builds work with zero setup.
 *  '' fields mean web edition / old preload / nothing baked. */
let bakedRelay: { url: string; token: string } | null = null;

export async function ensureBakedRelay(): Promise<void> {
  if (bakedRelay) return;
  try {
    bakedRelay = (await getElectronHost()?.collabRelayDefaults()) ?? { url: '', token: '' };
  } catch {
    bakedRelay = { url: '', token: '' };
  }
}

export function relayClient(): RoomsClient | null {
  const dev = collabDevRelay();
  const url = (
    settings.get('pairingRelayUrl').trim() ||
    dev?.url ||
    bakedRelay?.url ||
    ''
  ).replace(/\/+$/, '');
  const token = settings.get('pairingRelayToken').trim() || dev?.token || bakedRelay?.token || '';
  if (!url || !token) return null;
  return new RoomsClient({ baseUrl: () => url, token: () => token });
}

/** Tombstone a room on the relay — the home-screen Sessions list's host-side
 *  "End Session" (no live session object exists there, so this speaks to the
 *  relay directly). A room that is already ended (410) or expired/GC'd (404)
 *  counts as success: the goal — nobody can rejoin — already holds. Throws on
 *  anything else (offline, auth) so the caller can KEEP the record and let
 *  the host retry; deleting it without the tombstone would strand a live room
 *  that invited participants can silently rejoin. */
export async function endRoomOnRelay(roomId: string): Promise<void> {
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) throw new Error('no relay configured');
  try {
    await client.deleteRoom(roomId);
  } catch (err) {
    if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) return;
    throw err;
  }
}
