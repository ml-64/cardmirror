/**
 * Idle-callback scheduler with a setTimeout fallback for browsers
 * that don't support `requestIdleCallback`.
 *
 * Used by the editor and multi-pane shell to push per-pause "heavy"
 * work (nav rebuild, word count, comments GC, comments column
 * render) to a frame where the browser actually has idle time. That
 * way the burst of O(doc) work doesn't cause a single-frame spike
 * mid-typing the moment the user pauses for 200ms — the browser
 * waits until a frame has spare budget before invoking the callback.
 *
 * The `timeout` argument caps how long the work can be deferred past
 * the scheduled moment. requestIdleCallback honors it natively; the
 * setTimeout fallback uses it as the run delay.
 */

export type IdleHandle =
  | { kind: 'idle'; id: number }
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };

export function scheduleIdle(
  callback: () => void,
  timeout = 200,
): IdleHandle {
  if (typeof requestIdleCallback === 'function') {
    return {
      kind: 'idle',
      // The IdleDeadline arg is unused — our heavy callbacks run to
      // completion regardless of how much budget the browser advertised.
      id: requestIdleCallback(() => callback(), { timeout }),
    };
  }
  return { kind: 'timeout', id: setTimeout(callback, timeout) };
}

export function cancelIdle(handle: IdleHandle): void {
  if (handle.kind === 'idle') {
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle.id);
  } else {
    clearTimeout(handle.id);
  }
}
