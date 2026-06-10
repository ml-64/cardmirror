// Generate the test-utterance WAV set with piper TTS: 16 kHz mono, 700 ms
// trailing silence so the harness's 350 ms pause segmenter fires.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { readWav, writeWav, resample } from './src/wav.js'

const here = path.dirname(new URL(import.meta.url).pathname)
const PIPER = path.join(here, 'tts/piper/piper')
const VOICE = path.join(here, 'tts/en_US-lessac-medium.onnx')
const OUT = path.join(here, 'audio')
const TARGET_RATE = 16000

// kind: command → command grammar should parse it
//       quote   → command grammar gives the verb, doc-vocab decode gives the tail
//       oog     → out-of-grammar; must be rejected, not force-fit
//       dictation → open (no-grammar) decode, 500 ms budget
//       paint   → doc-vocab decode with per-word partial-lag tracking, 300 ms budget
//       wake    → decoded against the sleep grammar
const UTTERANCES = [
  { slug: 'pen-underline', text: 'pen underline', kind: 'command' },
  { slug: 'pen-highlight-green', text: 'pen highlight green', kind: 'command' },
  { slug: 'mark', text: 'mark', kind: 'command' },
  { slug: 'strip-all', text: 'strip all', kind: 'command' },
  { slug: 'next-card', text: 'next card', kind: 'command' },
  { slug: 'last-block', text: 'last block', kind: 'command' },
  { slug: 'take-card', text: 'take card', kind: 'command' },
  { slug: 'take-sentence', text: 'take sentence', kind: 'command' },
  { slug: 'card-four', text: 'card four', kind: 'command' },
  { slug: 'left-three-words', text: 'left three words', kind: 'command' },
  { slug: 'extend-right-two-words', text: 'extend right two words', kind: 'command' },
  { slug: 'pick-two', text: 'pick two', kind: 'command' },
  { slug: 'again-but-highlight', text: 'again but highlight', kind: 'command' },
  { slug: 'new-card', text: 'new card', kind: 'command' },
  { slug: 'set-tag', text: 'set tag', kind: 'command' },
  { slug: 'make-block', text: 'make block', kind: 'command' },
  { slug: 'condense', text: 'condense', kind: 'command' },
  { slug: 'expand', text: 'expand', kind: 'command' },
  { slug: 'shrink', text: 'shrink', kind: 'command' },
  { slug: 'regrow', text: 'regrow', kind: 'command' },
  { slug: 'paint', text: 'paint', kind: 'command' },
  { slug: 'start-typing', text: 'start typing', kind: 'command' },
  { slug: 'scratch-that', text: 'scratch that', kind: 'command' },
  { slug: 'voice-sleep', text: 'voice sleep', kind: 'command' },
  { slug: 'voice-wake', text: 'voice wake', kind: 'wake' },
  { slug: 'go-to-weapons-transfers', text: 'go to weapons transfers', kind: 'quote', verb: 'go to' },
  { slug: 'go-to-extended-deterrence', text: 'go to extended deterrence', kind: 'quote', verb: 'go to' },
  { slug: 'skip-to-the-ukraine-case', text: 'skip to the ukraine case', kind: 'quote', verb: 'skip to' },
  { slug: 'oog-hello', text: 'hello there how are you doing today', kind: 'oog' },
  { slug: 'oog-lunch', text: "let's grab lunch after the next round", kind: 'oog' },
  { slug: 'dictation-1', text: 'conventional arms transfers deter aggression and reassure allies', kind: 'dictation' },
  { slug: 'dictation-2', text: 'the affirmative misreads the consensus of the security literature', kind: 'dictation' },
  { slug: 'dictation-jargon-1', text: 'the counterplan solves the entirety of the aff while avoiding the politics disad', kind: 'dictation' },
  { slug: 'dictation-jargon-2', text: 'extend the uniqueness evidence their link turns assume a world without fiat', kind: 'dictation' },
  { slug: 'dictation-jargon-3', text: 'perm do both shields the link and the net benefit is nonunique', kind: 'dictation' },
  { slug: 'paint-pass', text: 'security cooperation has historically served as the backbone of deterrence', kind: 'paint' },
]

fs.mkdirSync(OUT, { recursive: true })
const manifest = []
for (const u of UTTERANCES) {
  const tmp = path.join(OUT, `_tmp.wav`)
  execFileSync(PIPER, ['--model', VOICE, '--output_file', tmp, '--length_scale', '0.95'], {
    input: u.text, stdio: ['pipe', 'ignore', 'ignore'],
  })
  const { sampleRate, samples } = readWav(tmp)
  const res = resample(samples, sampleRate, TARGET_RATE)
  const padded = new Int16Array(res.length + Math.floor(TARGET_RATE * 0.7))
  padded.set(res, 0)
  const file = `${u.slug}.wav`
  writeWav(path.join(OUT, file), padded, TARGET_RATE)
  fs.rmSync(tmp)
  manifest.push({ ...u, file, durationMs: Math.round(res.length / TARGET_RATE * 1000) })
  console.log(`${file}  ${(res.length / TARGET_RATE).toFixed(2)}s  "${u.text}"`)
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`\n${manifest.length} utterances → ${OUT}`)
