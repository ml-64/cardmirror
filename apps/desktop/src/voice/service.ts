/**
 * Main-process voice recognition service (SPEC-voice.md §10, §12 item 2).
 * Consumes 16 kHz mono s16le PCM; emits typed VoiceEvents. Holds the
 * mode machine (command / dictation / asleep — paint arrives with the
 * renderer integration step) and one recognizer set per session.
 *
 * No Electron imports: the service is driven by PCM buffers and a
 * clock, so it is testable headless with synthetic audio.
 */
import { performance } from 'node:perf_hooks';
import {
  buildLexicon,
  commandGrammar,
  docVocabGrammar,
  escapeGrammar,
  paintEscapeGrammar,
  assertLexiconInVocabulary,
  RESERVED_DICTATION,
  RESERVED_PAINT,
  SLEEP_GRAMMAR,
  PENS,
  type LexiconEntry,
} from './lexicon';
import { CommandParser, matchReserved, DEFAULT_MIN_WORD_CONF } from './parser';
import { Segmenter } from './segmenter';
import { loadLibVosk, Model, Recognizer } from './vosk';
import type { VoiceEvent, VoiceLevelEvent, VoiceMode } from './types';

export const SAMPLE_RATE = 16000;

const RESERVED_VERBS: Record<string, string> = {
  'stop typing': 'stopTyping',
  'voice sleep': 'voiceSleep',
  'scratch that': 'scratchThat',
  'new line': 'newLine',
  'new paragraph': 'newParagraph',
};

const LEVEL_EVERY_MS = 250;

export interface VoiceServiceOptions {
  libPath: string;
  modelDir: string;
  /** Optional second model used ONLY for open dictation (the opt-in
   *  large model). Grammar modes always run on the primary model. */
  dictationModelDir?: string;
  rmsGate?: number;
  minWordConf?: number;
  /** Idle seconds before auto-sleep (§2.1). 0 disables; default 60. */
  autoSleepSeconds?: number;
  onEvent: (event: VoiceEvent) => void;
  onLevel?: (level: VoiceLevelEvent) => void;
}

const AUTO_SLEEP_DEFAULT_S = 60;
const COUNTDOWN_WINDOW_MS = 10_000;

export class VoiceService {
  private model: Model | null = null;
  private dictationModel: Model | null = null;
  private cmd: Recognizer | null = null;
  private doc: Recognizer | null = null;
  private open: Recognizer | null = null;
  private escape: Recognizer | null = null;
  private paintEscape: Recognizer | null = null;
  private slp: Recognizer | null = null;

  private lexicon: LexiconEntry[] = [];
  private parser: CommandParser | null = null;
  private segmenter: Segmenter;
  private mode: VoiceMode = 'command';
  private utteranceId = 0;
  private lastLevelAt = 0;
  /** Audio accepted into the doc recognizer since its last reset.
   *  vosk's set_grm on a hot recognizer is a process-fatal Kaldi
   *  abort — vocabulary swaps must wait for an utterance boundary. */
  private docHot = false;
  private pendingVocabText: string | null = null;
  private debug = process.env['CARDMIRROR_VOICE_DEBUG'] === '1';
  private clockCheck = { audioMs: 0, startWall: 0, reported: false };
  private lastPartialAt = 0;
  private lastPartialText = '';
  /** Wall time of the last speech activity, for idle auto-sleep. */
  private lastActivityAt = 0;

  constructor(private opts: VoiceServiceOptions) {
    this.segmenter = new Segmenter({ rmsGate: opts.rmsGate });
  }

  get currentMode(): VoiceMode {
    return this.mode;
  }

  /** Load libvosk + model, vocab-check the lexicon, build recognizers. */
  start(): { modelLoadMs: number } {
    loadLibVosk(this.opts.libPath);
    this.lexicon = buildLexicon();
    assertLexiconInVocabulary(this.lexicon, this.opts.modelDir);

    const t0 = performance.now();
    this.model = new Model(this.opts.modelDir);
    const modelLoadMs = performance.now() - t0;

    if (this.opts.dictationModelDir) {
      try {
        const tDict = performance.now();
        this.dictationModel = new Model(this.opts.dictationModelDir);
        console.log(`voice: large dictation model loaded in ${(performance.now() - tDict).toFixed(0)}ms`);
      } catch (err) {
        console.error(`voice: large dictation model failed to load, using standard: ${String(err)}`);
        this.dictationModel = null;
      }
    }

    this.cmd = new Recognizer(this.model, SAMPLE_RATE, commandGrammar(this.lexicon));
    this.cmd.setWords(true);
    this.doc = new Recognizer(this.model, SAMPLE_RATE, docVocabGrammar(this.lexicon, ''));
    this.doc.setWords(true);
    this.open = new Recognizer(this.dictationModel ?? this.model, SAMPLE_RATE);
    this.escape = new Recognizer(this.model, SAMPLE_RATE, escapeGrammar());
    this.paintEscape = new Recognizer(this.model, SAMPLE_RATE, paintEscapeGrammar());
    this.slp = new Recognizer(this.model, SAMPLE_RATE, SLEEP_GRAMMAR);
    this.parser = new CommandParser(
      this.lexicon,
      this.opts.minWordConf ?? DEFAULT_MIN_WORD_CONF,
    );
    return { modelLoadMs };
  }

  stop(): void {
    for (const r of [this.cmd, this.doc, this.open, this.escape, this.paintEscape, this.slp]) r?.free();
    this.cmd = this.doc = this.open = this.escape = this.paintEscape = this.slp = null;
    this.model?.free();
    this.model = null;
    this.dictationModel?.free();
    this.dictationModel = null;
  }

  /** Viewport/document vocabulary for quote decoding (§12 item 4).
   *  Applied immediately when the doc recognizer is idle, otherwise
   *  deferred to the next utterance boundary (see docHot). */
  setVocabulary(docText: string): void {
    this.pendingVocabText = docText;
    this.applyVocabularyIfIdle();
  }

  private applyVocabularyIfIdle(): void {
    if (!this.doc || this.pendingVocabText === null || this.docHot) return;
    this.doc.setGrammar(docVocabGrammar(this.lexicon, this.pendingVocabText));
    this.pendingVocabText = null;
  }

  /** Feed one chunk of 16 kHz mono s16le PCM. */
  pushAudio(pcm: Buffer): void {
    if (!this.model) return;
    const samples = new Int16Array(
      pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2)),
    );
    const now = performance.now();

    const active = this.activeRecognizers();
    for (const rec of active) rec.accept(pcm);
    if (active.includes(this.doc as Recognizer)) this.docHot = true;

    // Audio-clock vs wall-clock sanity check: if the ratio is far from
    // 1.0, the renderer is sending a different sample rate than
    // declared and recognition hears slowed/sped speech.
    if (this.clockCheck.startWall === 0) this.clockCheck.startWall = now;
    this.clockCheck.audioMs += (samples.length / SAMPLE_RATE) * 1000;
    if (!this.clockCheck.reported && this.clockCheck.audioMs >= 5000) {
      this.clockCheck.reported = true;
      const wallMs = now - this.clockCheck.startWall;
      const ratio = this.clockCheck.audioMs / Math.max(1, wallMs);
      console.log(
        `voice: clock check — ${this.clockCheck.audioMs.toFixed(0)}ms audio in ${wallMs.toFixed(0)}ms wall (ratio ${ratio.toFixed(2)}${
          Math.abs(ratio - 1) > 0.15 ? ' — SAMPLE RATE MISMATCH' : ' — ok'
        })`,
      );
    }

    // Dictation and paint stream their in-progress transcripts (§10
    // latency: neither text nor ink waits for the end-of-utterance
    // pause).
    const partialSource =
      this.mode === 'dictation' ? this.open : this.mode === 'paint' ? this.doc : null;
    if (partialSource && now - this.lastPartialAt >= 200) {
      this.lastPartialAt = now;
      const partial = partialSource.partial();
      if (partial !== this.lastPartialText) {
        this.lastPartialText = partial;
        this.opts.onEvent({
          utteranceId: this.utteranceId + 1,
          mode: this.mode,
          raw: partial,
          tEndOfSpeech: 0,
          tParse: now,
          kind: this.mode === 'dictation' ? 'dictation-partial' : 'paint-partial',
          text: partial,
        });
      }
    }

    const seg = this.segmenter.push(samples, SAMPLE_RATE, now);
    if (seg.type === 'calibrated') {
      console.log(
        `voice: calibrated — noise floor ${seg.noiseFloor === null ? 'n/a (fallback)' : seg.noiseFloor.toFixed(0)}, gate ${seg.gate}`,
      );
      this.lastActivityAt = now;
    }
    if (seg.type === 'speech') this.lastActivityAt = now;

    // Idle auto-sleep (§2.1): a forgotten mic must not eat a
    // conversation. Waking always lands in command mode, as ever.
    const autoSleepMs = (this.opts.autoSleepSeconds ?? AUTO_SLEEP_DEFAULT_S) * 1000;
    let autoSleepRemainingMs: number | undefined;
    if (autoSleepMs > 0 && this.mode !== 'asleep' && this.lastActivityAt > 0) {
      const remaining = autoSleepMs - (now - this.lastActivityAt);
      if (remaining <= 0) {
        this.setMode('asleep', 'auto-sleep', {
          utteranceId: this.utteranceId,
          tEndOfSpeech: now,
          tParse: now,
        });
      } else if (remaining <= COUNTDOWN_WINDOW_MS) {
        autoSleepRemainingMs = remaining;
      }
    }
    if (
      this.opts.onLevel &&
      now - this.lastLevelAt >= LEVEL_EVERY_MS &&
      (seg.type === 'speech' || seg.type === 'silence' || seg.type === 'calibrating')
    ) {
      this.lastLevelAt = now;
      this.opts.onLevel({
        rms: 'rms' in seg ? seg.rms : 0,
        gate: this.segmenter.currentGate,
        calibrating: this.segmenter.isCalibrating,
        autoSleepRemainingMs,
      });
    }
    if (seg.type === 'blip') {
      // Breath/click — flush it out of the decoders so it can't prepend
      // noise words to the next real utterance, but emit nothing.
      const active = this.activeRecognizers();
      active.forEach((r) => {
        r.final();
        r.reset();
      });
      if (active.includes(this.doc as Recognizer)) {
        this.docHot = false;
        this.applyVocabularyIfIdle();
      }
      return;
    }
    if (seg.type === 'utterance-end') this.finishUtterance(seg.tLastVoiced, seg.voicedMs);
  }

  private activeRecognizers(): Recognizer[] {
    if (this.mode === 'dictation') return [this.open as Recognizer, this.escape as Recognizer];
    if (this.mode === 'paint') return [this.doc as Recognizer, this.paintEscape as Recognizer];
    if (this.mode === 'asleep') return [this.slp as Recognizer];
    return [this.cmd as Recognizer, this.doc as Recognizer];
  }

  private finishUtterance(tEndOfSpeech: number, voicedMs = 0): void {
    const id = ++this.utteranceId;
    const recs = this.activeRecognizers();
    const finals = recs.map((r) => r.final());
    recs.forEach((r) => r.reset());
    if (recs.includes(this.doc as Recognizer)) {
      this.docHot = false;
      this.applyVocabularyIfIdle();
    }
    if (this.debug) {
      console.log(
        `voice: utterance ${id} [${this.mode}] finals: ${finals
          .map((f) => JSON.stringify(f.text))
          .join(' | ')}`,
      );
    }
    const tParse = performance.now();
    const base = { utteranceId: id, mode: this.mode, tEndOfSpeech, tParse };

    if (this.mode === 'asleep') {
      const text = (finals[0]?.text ?? '').replaceAll('[unk]', ' ').replace(/\s+/g, ' ').trim();
      // The only phrase that exists while asleep; everything else is
      // discarded with no event (§2.1 — near-zero false positives).
      // Repeatable (§2.1, talonhub convention): users panic-repeat the
      // wake phrase within one utterance when they think it missed.
      if (/^voice wake( voice wake)*$/.test(text)) {
        this.setMode('command', 'voice wake', base);
      }
      return;
    }

    if (this.mode === 'dictation') {
      // The utterance is closing — clear any streamed ghost text before
      // the final text (or a reserved-phrase command) lands.
      this.lastPartialText = '';
      this.opts.onEvent({ ...base, kind: 'dictation-partial', text: '', raw: '' });
      const openResult = finals[0];
      const escapeResult = finals[1];
      const openText = openResult?.text ?? '';
      // `literal <words>` (§7): verbatim insertion, bypassing every
      // reserved phrase — the escape hatch for dictating "stop typing"
      // or any command word. Checked first; one leading noise word
      // tolerated like everywhere else.
      const litWords = openText.split(' ').filter(Boolean);
      const litAt = litWords[0] === 'literal' ? 1 : litWords[1] === 'literal' ? 2 : 0;
      if (litAt > 0 && litWords.length > litAt) {
        const text = litWords.slice(litAt).join(' ');
        this.opts.onEvent({ ...base, kind: 'dictation', text, raw: openText });
        return;
      }
      const reserved = matchReserved(escapeResult?.text ?? '', RESERVED_DICTATION);
      // Guard against reserved words appearing inside flowing dictation
      // ("the new line of attack" must transcribe): the utterance must
      // be the phrase alone (± one noise word) to count as reserved.
      const phraseAlone =
        reserved !== null &&
        openText.split(' ').filter(Boolean).length <= reserved.split(' ').length + 1;
      if (reserved && phraseAlone) {
        this.opts.onEvent({
          ...base,
          kind: 'command',
          verb: RESERVED_VERBS[reserved] as string,
          args: {},
          raw: reserved,
        });
        if (reserved === 'stop typing') this.setMode('command', reserved, base);
        if (reserved === 'voice sleep') this.setMode('asleep', reserved, base);
        return;
      }
      if (openText) this.opts.onEvent({ ...base, kind: 'dictation', text: openText, raw: openText });
      return;
    }

    if (this.mode === 'paint') {
      // Utterance closing — clear the streamed provisional state before
      // the commit (or escape command) lands.
      this.lastPartialText = '';
      this.opts.onEvent({ ...base, kind: 'paint-partial', text: '', raw: '' });
      const docResult = finals[0];
      const escText = finals[1]?.text ?? '';
      const reserved = matchReserved(escText, RESERVED_PAINT);
      if (reserved) {
        this.opts.onEvent({
          ...base,
          kind: 'command',
          verb: reserved === 'stop paint' ? 'stopPaint' : (RESERVED_VERBS[reserved] as string),
          args: {},
          raw: reserved,
        });
        if (reserved === 'stop paint') this.setMode('command', reserved, base);
        if (reserved === 'voice sleep') this.setMode('asleep', reserved, base);
        return;
      }
      const escClean = escText.replaceAll('[unk]', ' ').replace(/\s+/g, ' ').trim();
      const penSwitch = PENS.find((p) => escClean === `pen ${p}` || escClean.endsWith(` pen ${p}`));
      if (penSwitch) {
        this.opts.onEvent({ ...base, kind: 'command', verb: 'pen', args: { pen: penSwitch }, raw: `pen ${penSwitch}` });
        return;
      }
      const quote = (docResult?.text ?? '').replaceAll('[unk]', ' ').replace(/\s+/g, ' ').trim();
      if (quote) {
        this.opts.onEvent({ ...base, kind: 'command', verb: 'paintQuote', args: { quote }, raw: quote });
      }
      return;
    }

    // Command mode
    const parse = (this.parser as CommandParser).parse(
      finals[0] ?? { text: '', words: null },
      finals[1] ?? null,
    );
    if (parse.kind === 'rejection') {
      // A short gate blip with nothing decodable isn't an utterance —
      // stay silent rather than spamming out-of-grammar rejections.
      // Sustained speech (≥600 ms voiced) still echoes its rejection,
      // even when the decode is all [unk] ("what did it think I said?").
      if (
        parse.reason === 'out-of-grammar' &&
        voicedMs < 600 &&
        !parse.raw.replaceAll('[unk]', '').trim()
      ) {
        return;
      }
      this.opts.onEvent({ ...base, kind: 'rejection', reason: parse.reason, raw: parse.raw });
      return;
    }
    this.opts.onEvent({ ...base, kind: 'command', verb: parse.verb, args: parse.args, raw: parse.raw });
    if (parse.verb === 'startTyping' || parse.verb === 'retype' || parse.verb === 'setTag' || parse.verb === 'setCite') {
      this.setMode('dictation', parse.raw, base);
    } else if (parse.verb === 'paint') {
      this.setMode('paint', parse.raw, base);
    } else if (parse.verb === 'voiceSleep') {
      this.setMode('asleep', parse.raw, base);
    }
  }

  private setMode(
    to: VoiceMode,
    trigger: string,
    base: { utteranceId: number; tEndOfSpeech: number; tParse: number },
  ): void {
    const from = this.mode;
    if (from === to) return;
    this.mode = to;
    this.opts.onEvent({ ...base, mode: to, kind: 'mode', from, to, trigger, raw: trigger });
  }
}
