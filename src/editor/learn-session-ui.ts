/**
 * Review session overlay (SPEC-learn-system §6). A full-screen modal that
 * walks the due queue for a scope one card at a time: show front → reveal
 * back → binary grade (Forgot / Remembered). Grading is Orbit-style —
 * a forgotten card is retried later in the same session (the scheduler
 * tells us via `retryInSession`), but its schedule is already updated and
 * persisted on each grade, so closing mid-session loses nothing.
 *
 * Reads entirely from the local learn store; no file I/O.
 */

import { learnStore, localToday } from './learn-store-host.js';
import type { Scope } from './learn-store.js';

interface SessionOpts {
  title?: string;
}

export function openLearnSession(scope: Scope, opts: SessionOpts = {}): void {
  const today = localToday();
  const queue = learnStore.queue(scope, today); // cardIds, due-ordered
  // Working queue we mutate as we retry forgotten cards.
  const work = [...queue];
  let reviewed = 0;
  let remembered = 0;

  const overlay = document.createElement('div');
  overlay.className = 'pmd-learn-session-overlay';
  const panel = document.createElement('div');
  panel.className = 'pmd-learn-session';
  overlay.appendChild(panel);

  const cleanup = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };

  const onKey = (e: KeyboardEvent): void => {
    // Modal: swallow keydowns so they don't reach document-level
    // listeners behind the overlay — notably the Home screen's
    // 1/2/3/4 action keys, which sit under this session.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
      return;
    }
    if (state === 'front') {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        reveal();
      }
      return;
    }
    if (state === 'back') {
      if (e.key === '1') {
        e.preventDefault();
        grade('forgot');
      } else if (e.key === '2' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        grade('remembered');
      }
    }
  };

  let state: 'front' | 'back' | 'done' = 'front';

  function header(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'pmd-learn-session-bar';
    const title = document.createElement('span');
    title.className = 'pmd-learn-session-title';
    title.textContent = opts.title ?? 'Review';
    const progress = document.createElement('span');
    progress.className = 'pmd-learn-session-progress';
    // Always-accurate (retries push cards back onto `work`, so a simple
    // "n of total" would overshoot): reviewed so far · cards remaining.
    progress.textContent = state === 'done' ? '' : `${reviewed} reviewed · ${work.length} left`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pmd-learn-session-close';
    close.setAttribute('aria-label', 'Close review');
    close.textContent = '✕';
    close.addEventListener('click', cleanup);
    bar.append(title, progress, close);
    return bar;
  }

  function renderCard(): void {
    panel.replaceChildren();
    panel.appendChild(header());

    const cardId = work[0]!;
    const card = learnStore.getCard(cardId);
    if (!card) {
      // Card vanished (e.g. deleted in another window) — skip it.
      work.shift();
      next();
      return;
    }

    const body = document.createElement('div');
    body.className = 'pmd-learn-session-body';

    const face = document.createElement('div');
    face.className = 'pmd-learn-session-face';
    if (card.type === 'cloze') {
      face.append(renderCloze(card.front, state === 'back'));
    } else {
      const q = document.createElement('div');
      q.className = 'pmd-learn-session-q';
      q.textContent = card.front;
      face.appendChild(q);
      if (state === 'back') {
        const hr = document.createElement('div');
        hr.className = 'pmd-learn-session-divider';
        const a = document.createElement('div');
        a.className = 'pmd-learn-session-a';
        a.textContent = card.back;
        face.append(hr, a);
      }
    }
    body.appendChild(face);
    panel.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'pmd-learn-session-actions';
    if (state === 'front') {
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'pmd-learn-session-show';
      show.textContent = 'Show answer';
      show.addEventListener('click', reveal);
      actions.appendChild(show);
      const hint = document.createElement('span');
      hint.className = 'pmd-learn-session-hint';
      hint.textContent = 'Space';
      actions.appendChild(hint);
    } else {
      const forgot = document.createElement('button');
      forgot.type = 'button';
      forgot.className = 'pmd-learn-session-grade pmd-learn-session-forgot';
      forgot.innerHTML = 'Forgot <kbd>1</kbd>';
      forgot.addEventListener('click', () => grade('forgot'));
      const got = document.createElement('button');
      got.type = 'button';
      got.className = 'pmd-learn-session-grade pmd-learn-session-remembered';
      got.innerHTML = 'Remembered <kbd>2</kbd>';
      got.addEventListener('click', () => grade('remembered'));
      actions.append(forgot, got);
    }
    panel.appendChild(actions);
  }

  function reveal(): void {
    if (state !== 'front') return;
    state = 'back';
    renderCard();
  }

  function grade(g: 'forgot' | 'remembered'): void {
    if (state !== 'back') return;
    const cardId = work.shift()!;
    const retry = learnStore.grade(cardId, g, today, new Date().toISOString());
    reviewed += 1;
    if (g === 'remembered') remembered += 1;
    if (retry) work.push(cardId); // Orbit: retry later this session
    state = 'front';
    next();
  }

  function next(): void {
    if (work.length === 0) {
      state = 'done';
      renderDone();
      return;
    }
    renderCard();
  }

  function renderDone(): void {
    panel.replaceChildren();
    panel.appendChild(header());
    const done = document.createElement('div');
    done.className = 'pmd-learn-session-done';
    if (queue.length === 0) {
      done.innerHTML = '<div class="pmd-learn-session-done-emoji">✓</div><div>Nothing due right now.</div>';
    } else {
      done.innerHTML =
        `<div class="pmd-learn-session-done-emoji">✓</div>` +
        `<div>Reviewed ${reviewed} ${reviewed === 1 ? 'card' : 'cards'}.</div>` +
        `<div class="pmd-learn-session-done-sub">${remembered} remembered · ${reviewed - remembered} to revisit</div>`;
    }
    panel.appendChild(done);
    const actions = document.createElement('div');
    actions.className = 'pmd-learn-session-actions';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pmd-learn-session-show';
    close.textContent = 'Done';
    close.addEventListener('click', cleanup);
    actions.appendChild(close);
    panel.appendChild(actions);
  }

  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  if (work.length === 0) {
    state = 'done';
    renderDone();
  } else {
    renderCard();
  }
}

/** Render a cloze sentence. Question view blanks each {{deletion}} to […];
 *  answer view shows the full text with deletions highlighted. */
function renderCloze(sentence: string, revealed: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pmd-learn-session-q';
  const re = /\{\{(.+?)\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(sentence.slice(last, m.index)));
    if (revealed) {
      const span = document.createElement('span');
      span.className = 'pmd-learn-cloze-reveal';
      span.textContent = m[1]!;
      el.appendChild(span);
    } else {
      const span = document.createElement('span');
      span.className = 'pmd-learn-cloze-blank';
      span.textContent = '[ … ]';
      el.appendChild(span);
    }
    last = re.lastIndex;
  }
  if (last < sentence.length) el.appendChild(document.createTextNode(sentence.slice(last)));
  return el;
}
