# Voice recognizer spike

Throwaway harness for SPEC-voice.md §12 item 1: does Vosk with a runtime grammar
hit the §10 latency budgets with the real command lexicon? Run on the dev machine
(Zephyrus G14, Linux, Node 24), 2026-06-09.

## Verdict: yes, with ~6–10× margin

| Metric | Budget | Measured (p50 / max) |
|---|---|---|
| Command parse-to-effect after end-of-utterance | ≤ 250 ms | 22 / 40 ms |
| Quote utterances (`go to <quote>`, parallel doc-vocab decode) | ≤ 250 ms | 23 / 40 ms |
| Paint provisional-ink lag behind the spoken word | ≤ 300 ms | 32 / 331 ms¹ |
| Dictation (open model) | ≤ 500 ms | 57 ms |
| Grammar hot-swap (`vosk_recognizer_set_grm`) | — | 0.75 ms |
| Model load (once, at startup) | — | ~390 ms |
| CPU while awake (command + doc recognizers in parallel) | — | ~13 % of one core |
| Process RSS with model loaded | — | ~240 MB |

¹ The 331 ms max is the utterance-final word, which by construction can't confirm
until the 350 ms pause window closes. Words during continuous reading — the paint
use case — confirm in ~30 ms.

The end-of-utterance clock: utterance end is *detected* 350 ms after the last
voiced audio (spec §2 segmentation), then parse lands ≤ 40 ms later. Decode
headroom is large enough that the pause threshold, not the engine, dominates
perceived latency.

## Model comparison (2026-06-09)

| | small-en-us-0.15 (40 MB) | en-us-0.22-lgraph (128 MB) | en-us-0.22 (1.8 GB) |
|---|---|---|---|
| Runtime grammar (command/paint/sleep modes) | yes | yes | **no — static graph** |
| Command parse p50/max (TTS bench) | 22 / 40 ms | 188 / 254 ms | n/a |
| Live command accuracy (first-try) | ~14/20 | ~15/17, incl. fixes for prior misses | n/a |
| Dictation parse p50/max | 23 / 53 ms | 147 / 228 ms | **680 / 923 ms — over 500 ms budget** |
| Debate jargon (aff/disad/perm/fiat) | wrong | wrong (identical errors) | wrong (identical errors) |
| Model load / RSS | 0.2 s / 240 MB | 0.9 s / 560 MB | **8.4 s / 5.3 GB** |
| Lexicon vocab gaps | retype, uncondense, unshrink | uncondense, unshrink | n/a |

**Loadout verdict:** ship **lgraph** as the only model. The 1.8 GB model can't run
any grammar mode, blows the dictation latency budget, needs 5 GB of RAM on a
tournament laptop, and still gets every debate-jargon word wrong — model size
does not fix vocabulary. The dictation-quality lever is the corpus-seeded
vocabulary (spec §13 item 5), which works on lgraph.

## Findings beyond the budgets

1. **OOV verbs fail dangerously, not loudly.** `retype`, `uncondense`, `unshrink`
   are missing from the small model's vocabulary. Vosk drops them from the grammar
   with only a stderr warning — and spoken "uncondense" then force-fits to
   **"condense"**, its antonym. The grammar builder must vocab-check every lexicon
   word at startup and treat a miss as a build error. Those three verbs need
   rewording or a custom-vocab model.
2. **The quote slot works as parallel decode, no mid-utterance swap needed.** Two
   recognizers (command grammar + doc-vocab grammar) eat the same audio; when the
   command result is a quote-verb prefix (`go to [unk]`), the doc recognizer's text
   supplies the tail. Cost is the 13 % CPU above; latency cost is zero. This is
   simpler and safer than hot-swapping the grammar mid-utterance.
3. **Out-of-grammar rejection is clean.** Conversational speech decodes to `[unk]`
   against the command grammar — exactly the "stray speech is cheap to discard"
   property the spec wants.
4. **Dictation splits at natural pauses.** A 360 ms breath pause mid-sentence ends
   the utterance; the text arrives as two segments. Benign for insertion, but
   utterance-atomicity (undo grouping) must expect multi-segment dictation, or
   dictation mode should use a longer pause threshold than command mode.
5. **The official `vosk` npm package is unusable** (built on dead `ffi-napi`, fails
   on Node ≥ 18). Binding `libvosk.so` directly with `koffi` (~60 lines, `src/vosk.js`)
   works on Node 24 and works in Electron main — the production integration path.
6. Word timestamps count audio fed since recognizer *creation*; `reset()` does not
   zero that clock. Paint-head tracking needs per-session recognizers or offset
   bookkeeping.
7. **Fixed voice-activity gates fail silently.** The dev machine's ambient noise
   floor (RMS ~760) sat above the harness's original fixed gate (500), so the
   segmenter never saw "silence" and never ended an utterance — the recognizer
   heard everything and reported nothing. Mic mode now calibrates the gate from
   ambient audio at startup — and that calibration must itself discard the
   capture-start transient (this device pegs full-scale for the first few hundred
   ms) and clipped chunks, or the floor is garbage. Production needs the same
   calibration plus an input-device picker with a live level meter (spec §10,
   added 2026-06-09).
8. **Reserved dictation phrases need out-of-band spotting — all of them.** Live
   session 2026-06-09: the open LM transcribed "end typing" as "the typing" /
   "and typing" across three attempts and "voice sleep" as "why sleep", trapping
   the session in dictation while room audio transcribed into (what would be) the
   document. The spec's §10 parallel keyword check is load-bearing and must cover
   every reserved phrase, not just the sleep bigram. Mic mode now runs a small
   escape-grammar recognizer alongside the open model in dictation; spec amended.
9. **Live command accuracy (laptop mic, small model): 14/20 first-try, 0 wrong
   executions.** Multi-word commands and all three quote targets were essentially
   perfect; failures clustered on short/quiet utterances (`mark`, `card four`,
   `take sentence`) and were all clean rejections, retried successfully. The
   first-try rate needs to come up for the trust loop; candidate levers are the
   0.22-lgraph model (128 MB, runtime-grammar capable), real VAD instead of an
   RMS gate, and mic quality.
10. Caveat: synthesized-speech results flatter accuracy vs. a real mic (latency
    is unaffected). `node src/harness.js mic` gives a live hands-on session.

## Layout / running it

Binary assets are gitignored; to reconstruct: vosk-model-small-en-us-0.15 +
vosk-linux-x86_64-0.3.45 (alphacephei.com), piper 2023.11.14-2 + en_US-lessac-medium
voice, `npm install`.

```
node gen-audio.mjs              # synthesize the 32-utterance test set
node src/harness.js bench       # paced real-time latency bench (results/bench.json)
node src/harness.js swap-bench  # set_grm / create / model-load timing
node src/harness.js mic         # live mic, mode machine incl. sleep/wake
```

`src/grammar.js` is the spec §5 lexicon compiled to vosk phrase lists — keep it in
sync with the spec if the lexicon changes.
