/**
 * Collaboration-session feature gate. DORMANT BY DEFAULT.
 *
 * Enablement is deliberately unreachable for packaged release builds:
 *   - dev/build: `VITE_COLLAB=1` in the environment at vite time, or
 *   - a manual `localStorage['pmd-collab'] = '1'` console flip for
 *     quick web testing.
 * Flipping the feature on for a release is a code change here (the
 * same posture as the pairing entitlement flag: an env var cannot
 * reach a packaged app).
 *
 * Zero heavy imports — this module is consulted from the main editor
 * path; everything Loro/collab loads lazily only after the gate opens.
 */

export function collabEnabled(): boolean {
  try {
    if ((import.meta as { env?: Record<string, string> }).env?.['VITE_COLLAB'] === '1') return true;
  } catch {
    /* no import.meta.env outside vite */
  }
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('pmd-collab') === '1';
  } catch {
    return false;
  }
}
