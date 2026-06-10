// Check candidate lexicon words against a vosk model's vocabulary (words.txt).
// Prototype of the production rule: grammar build hard-fails on OOV words.
//   node check-vocab.mjs word [word...]          # check explicit candidates
//   node check-vocab.mjs --lexicon               # check the full spec lexicon
import fs from 'node:fs'
import path from 'node:path'
import { commandGrammar } from './src/grammar.js'

const here = path.dirname(new URL(import.meta.url).pathname)
const MODEL = process.env.VOSK_MODEL ?? path.join(here, 'models/vosk-model-en-us-0.22-lgraph')
const wordsFile = path.join(MODEL, 'graph/words.txt')
const vocab = new Set(
  fs.readFileSync(wordsFile, 'utf8').split('\n').map((l) => l.split(' ')[0]),
)

const args = process.argv.slice(2)
const candidates = args[0] === '--lexicon'
  ? [...new Set(commandGrammar().flatMap((p) => p.split(' ')).filter((w) => w !== '[unk]'))]
  : args

let missing = 0
for (const w of candidates) {
  const ok = vocab.has(w.toLowerCase())
  if (!ok) missing++
  if (!ok || args[0] !== '--lexicon') console.log(`${ok ? '✓' : '✗ MISSING'}  ${w}`)
}
console.log(`\n${candidates.length - missing}/${candidates.length} in vocabulary (${path.basename(MODEL)})`)
process.exit(missing ? 1 : 0)
