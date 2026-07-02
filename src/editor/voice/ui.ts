/**
 * Voice feedback surface (SPEC-voice.md §9, §12 item 6 — feedback lands
 * with the first command, not after): a status pill showing attention/
 * mode + the last parse echo, a live input-level meter, and earcons.
 * Every state change is visible AND audible; every rejection shows what
 * was heard. Styled in the dropzone pill's visual language (styles in
 * style.css under "Voice pill"); the full tray panel is a later
 * increment.
 */
import { settings } from '../settings.js';
import type { VoiceLevel, VoiceMode } from './types';

export class VoicePill {
  private el: HTMLElement;
  private echoEl: HTMLElement;
  private meterFill: HTMLElement;
  private audio: AudioContext | null = null;
  private menu: HTMLElement | null = null;
  private dismissMenu: (() => void) | null = null;

  private penEl: HTMLElement;
  private modeEl: HTMLElement;

  constructor(private onStop?: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'pmd-voice-pill';
    // The accessibility flagship must itself be accessible (audit
    // 2026-06-10): keyboard-operable button, labelled, with the echo
    // text announced to screen readers — the same feedback contract
    // sighted users get from the pill.
    this.el.setAttribute('role', 'button');
    this.el.setAttribute('tabindex', '0');
    this.el.setAttribute('aria-label', 'Voice control session — opens microphone menu');
    const dot = document.createElement('span');
    dot.className = 'pmd-voice-dot';
    dot.setAttribute('aria-hidden', 'true');
    // Persistent mode badge — unlike the transition hint in the echo
    // slot (overwritten by the next recognized word), this always shows
    // the current mode as text, so mode never rests on dot hue alone
    // (color-vision audit). Only setMode() writes it.
    this.modeEl = document.createElement('span');
    this.modeEl.className = 'pmd-voice-mode-badge';
    // The badge is the announcement channel for mode changes now that
    // the echo no longer narrates them (it was redundant on screen).
    this.modeEl.setAttribute('aria-live', 'polite');
    this.penEl = document.createElement('span');
    this.penEl.className = 'pmd-voice-pen';
    this.echoEl = document.createElement('span');
    this.echoEl.className = 'pmd-voice-echo';
    this.echoEl.setAttribute('aria-live', 'polite');
    const meter = document.createElement('span');
    meter.className = 'pmd-voice-meter';
    meter.setAttribute('aria-hidden', 'true');
    this.meterFill = document.createElement('div');
    meter.appendChild(this.meterFill);
    this.el.append(dot, this.modeEl, this.penEl, this.echoEl, meter);
    // Click/Enter/Space opens the session menu (mic picker + stop) —
    // an accidental activation must not kill the session.
    this.el.addEventListener('click', () => this.toggleMenu());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggleMenu();
      }
    });
    document.body.appendChild(this.el);
  }

  // ---- session menu (mic picker + stop) ----

  private toggleMenu(): void {
    if (this.menu) {
      this.closeMenu();
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'pmd-voice-menu';
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', 'Voice session: microphone and stop');

    const title = document.createElement('div');
    title.className = 'pmd-voice-menu-title';
    title.textContent = 'Microphone';
    menu.appendChild(title);

    const current = settings.get('voiceInputDeviceId');
    const group = `pmd-voice-mic-${Math.random().toString(36).slice(2, 8)}`;
    const addDevice = (value: string, label: string): void => {
      const row = document.createElement('label');
      row.className = 'pmd-voice-menu-row';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = group;
      input.checked = value === current;
      input.addEventListener('change', () => {
        if (input.checked) settings.set('voiceInputDeviceId', value);
      });
      const text = document.createElement('span');
      text.textContent = label;
      row.append(input, text);
      menu.appendChild(row);
    };
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'pmd-voice-menu-stop';
    stop.textContent = 'Stop voice control';
    stop.addEventListener('click', () => {
      this.closeMenu();
      this.onStop?.();
    });

    addDevice('', 'System default');
    menu.appendChild(stop);
    if (navigator.mediaDevices?.enumerateDevices) {
      void navigator.mediaDevices.enumerateDevices().then((devices) => {
        if (this.menu !== menu) return; // closed while enumerating
        let n = 0;
        for (const d of devices) {
          if (d.kind !== 'audioinput' || d.deviceId === 'default') continue;
          n += 1;
          addDevice(d.deviceId, d.label || `Microphone ${n}`);
        }
        menu.appendChild(stop); // keep the stop button last
      });
    }

    document.body.appendChild(menu);
    this.menu = menu;

    const onDown = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node) && !this.el.contains(e.target as Node)) {
        this.closeMenu();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.closeMenu();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    this.dismissMenu = () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  private closeMenu(): void {
    this.dismissMenu?.();
    this.dismissMenu = null;
    this.menu?.remove();
    this.menu = null;
  }

  setListening(on: boolean): void {
    this.el.classList.toggle('pmd-voice-on', on);
    if (!on) {
      this.setEcho('', true);
      this.closeMenu();
    }
  }

  setMode(mode: VoiceMode): void {
    this.el.classList.remove(
      'pmd-voice-mode-command',
      'pmd-voice-mode-dictation',
      'pmd-voice-mode-paint',
      'pmd-voice-mode-asleep',
    );
    this.el.classList.add(`pmd-voice-mode-${mode}`);
    this.modeEl.textContent = mode;
    // The badge names the mode; the echo carries only guidance the
    // badge can't (how to leave the mode). Command/dictation need
    // none — clear instead of restating the badge.
    const hint =
      mode === 'asleep'
        ? 'say "voice wake" to resume'
        : mode === 'paint'
          ? 'speak words to ink them'
          : '';
    this.setEcho(hint, true);
  }

  /** Active-pen badge (sticky state, §3.1 — always visible). */
  setPen(name: string, color?: string): void {
    this.penEl.textContent = color ? `${name} ${color}` : name;
  }

  setEcho(text: string, ok: boolean): void {
    this.echoEl.textContent = text;
    this.echoEl.classList.toggle('pmd-voice-rejected', !ok);
  }

  /** Countdown dimming in the final 10 s before auto-sleep (§2.1). */
  setAutoSleepCountdown(remainingMs: number | null): void {
    this.el.classList.toggle('pmd-voice-drowsy', remainingMs !== null);
    this.el.style.setProperty(
      '--voice-drowsy',
      remainingMs === null ? '1' : String(Math.max(0.35, remainingMs / 10000)),
    );
  }

  setLevel(level: VoiceLevel): void {
    const pct = level.calibrating
      ? 0
      : Math.min(100, Math.round((level.rms / Math.max(1, level.gate * 3)) * 100));
    this.meterFill.style.width = `${pct}%`;
  }

  // ---- earcons (§9: every state change audible) ----

  private beep(freq: number, ms: number, type: OscillatorType = 'sine', delayMs = 0): void {
    this.audio ??= new AudioContext();
    const t0 = this.audio.currentTime + delayMs / 1000;
    const osc = this.audio.createOscillator();
    const gain = this.audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.04, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + ms / 1000);
    osc.connect(gain).connect(this.audio.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000);
  }

  earconAccept(): void {
    this.beep(880, 70);
  }

  earconReject(): void {
    this.beep(220, 130, 'square');
  }

  earconMode(to: VoiceMode): void {
    if (to === 'asleep') {
      this.beep(520, 80);
      this.beep(330, 110, 'sine', 90);
    } else {
      this.beep(330, 80);
      this.beep(660, 90, 'sine', 90);
    }
  }

  destroy(): void {
    this.closeMenu();
    this.el.remove();
    void this.audio?.close();
  }
}
