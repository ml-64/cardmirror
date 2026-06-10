// Recognizer spike harness (SPEC-voice.md §12 item 1).
// Measures, end-to-end: command parse latency from end of utterance (budget 250 ms),
// paint provisional-ink lag behind the spoken word (budget 300 ms), dictation
// latency (budget 500 ms), plus grammar hot-swap and model-load costs.
//
//   node src/harness.js bench        # paced real-time decode over audio/*.wav
//   node src/harness.js swap-bench   # set_grm / recognizer-create / model-load timing
//   node src/harness.js mic          # live mic via arecord (interactive)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { Model, Recognizer, setLogLevel } from './vosk.js'
import { commandGrammar, docVocabGrammar, SLEEP_GRAMMAR, QUOTE_VERBS, SAMPLE_DOC } from './grammar.js'
import { readWav } from './wav.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const MODEL_PATH = process.env.VOSK_MODEL
  ? path.resolve(process.env.VOSK_MODEL)
  : path.join(ROOT, 'models/vosk-model-small-en-us-0.15')
const RATE = 16000
const CHUNK_MS = 20
const PAUSE_MS = 350 // spec §2: utterance ends at pause ≥ 350 ms
const BUDGETS = { command: 250, quote: 250, wake: 250, oog: 250, dictation: 500, paint: 300 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Grammar decodes can force-fit out-of-grammar speech (seen with lgraph:
// "let's grab lunch…" → "left scratch lines…"). Gate on per-word confidence.
const MIN_WORD_CONF = Number(process.env.MIN_WORD_CONF ?? 0.7)
const lowConf = (r) => (r.words ?? []).some((w) => w.conf != null && w.conf < MIN_WORD_CONF)
const pct = (xs, p) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]
}

function rmsOf(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

// Stream a WAV at real-time pace into one or more recognizers, segmenting at
// PAUSE_MS of trailing silence — the same loop a live mic path runs.
async function streamFile(file, recs, { rmsGate = 200, onChunk, onSegment } = {}) {
  const { samples, sampleRate } = readWav(file)
  if (sampleRate !== RATE) throw new Error(`${file}: expected ${RATE} Hz`)
  const chunkSamples = Math.round(RATE * CHUNK_MS / 1000)
  const t0 = performance.now()
  let lastVoiced = null
  let voicedSeen = false
  let silentMs = 0
  for (let i = 0; i * chunkSamples < samples.length; i++) {
    const due = t0 + i * CHUNK_MS
    const wait = due - performance.now()
    if (wait > 0) await sleep(wait)
    const slice = samples.subarray(i * chunkSamples, Math.min((i + 1) * chunkSamples, samples.length))
    const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.length * 2)
    for (const r of recs) r.accept(buf)
    const fed = performance.now()
    if (rmsOf(slice) > rmsGate) {
      lastVoiced = fed
      voicedSeen = true
      silentMs = 0
    } else if (voicedSeen) {
      silentMs += CHUNK_MS
      if (silentMs >= PAUSE_MS) {
        if (!onSegment) return { t0, lastVoiced, segmentAt: fed }
        onSegment(fed)
        voicedSeen = false
        silentMs = 0
      }
    }
    onChunk?.(fed)
  }
  return { t0, lastVoiced, segmentAt: performance.now() }
}

function finalize(rec, segmentAt) {
  const text = rec.final()
  const parseAt = performance.now()
  return { ...textResult(text), parseLatency: parseAt - segmentAt }
}
const textResult = (j) => ({ text: j.text ?? '', words: j.result ?? null })

const isRejection = (text) => text.replaceAll('[unk]', '').trim() === ''

function spliceQuote(cmdText, docText) {
  // Command grammar yields the verb (tail decodes as [unk]); the parallel
  // doc-vocab decode yields the whole utterance, from which we take the tail.
  const verb = QUOTE_VERBS.find((v) => cmdText === v || cmdText.startsWith(v + ' '))
  if (!verb) return null
  const quote = docText.startsWith(verb + ' ') ? docText.slice(verb.length + 1) : docText
  return { verb, quote }
}

async function bench(onlyKind) {
  let manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'audio/manifest.json'), 'utf8'))
  if (onlyKind) manifest = manifest.filter((u) => u.kind === onlyKind)
  const tLoad0 = performance.now()
  const model = new Model(MODEL_PATH)
  const modelLoadMs = performance.now() - tLoad0

  // Lazy per-kind creation: static-graph models (e.g. en-us-0.22) cannot build
  // runtime-grammar recognizers at all, but can still bench dictation.
  const kinds = new Set(manifest.map((u) => u.kind))
  const needsGrammar = kinds.has('command') || kinds.has('quote') || kinds.has('oog')
  const cmd = needsGrammar ? new Recognizer(model, RATE, commandGrammar()) : null
  cmd?.setWords(true)
  const doc = needsGrammar ? new Recognizer(model, RATE, docVocabGrammar(SAMPLE_DOC)) : null
  doc?.setWords(true)
  const open = kinds.has('dictation') ? new Recognizer(model, RATE) : null
  const slp = kinds.has('wake') ? new Recognizer(model, RATE, SLEEP_GRAMMAR) : null

  const rows = []
  const cpu0 = process.cpuUsage()
  const wall0 = performance.now()

  for (const u of manifest) {
    const file = path.join(ROOT, 'audio', u.file)
    let row = { slug: u.slug, kind: u.kind, expect: u.text }

    if (u.kind === 'command' || u.kind === 'quote' || u.kind === 'oog') {
      const seg = await streamFile(file, [cmd, doc])
      const c = finalize(cmd, seg.segmentAt)
      const d = finalize(doc, seg.segmentAt)
      const latency = Math.max(c.parseLatency, d.parseLatency)
      row = { ...row, heardCmd: c.text, heardDoc: d.text, latency, totalFromVoiceEnd: seg.segmentAt - seg.lastVoiced + latency }
      if (u.kind === 'command') { row.ok = c.text === u.text; row.wouldConfReject = lowConf(c) }
      else if (u.kind === 'oog') row.ok = isRejection(c.text) || lowConf(c)
      else {
        const q = spliceQuote(c.text, d.text)
        row.parsed = q ? `${q.verb} «${q.quote}»` : '(no quote-verb prefix)'
        row.ok = q !== null && d.text === u.text
      }
      cmd.reset(); doc.reset()
    } else if (u.kind === 'wake') {
      const seg = await streamFile(file, [slp])
      const s = finalize(slp, seg.segmentAt)
      row = { ...row, heardCmd: s.text, latency: s.parseLatency, totalFromVoiceEnd: seg.segmentAt - seg.lastVoiced + s.parseLatency, ok: s.text === 'voice wake' }
      slp.reset()
    } else if (u.kind === 'dictation') {
      // Multi-segment: a breath pause ends an utterance, but the text still
      // lands — concatenate segments and judge the whole transcript.
      const parts = []
      let lastLatency = 0
      const seg = await streamFile(file, [open], {
        onSegment: (fed) => {
          const t = open.final()
          lastLatency = performance.now() - fed
          if (t.text) parts.push(t.text)
        },
      })
      const tail = finalize(open, seg.segmentAt)
      if (tail.text) parts.push(tail.text)
      const joined = parts.join(' ')
      const latency = tail.text ? tail.parseLatency : lastLatency
      row = { ...row, heardCmd: joined, segments: parts.length, latency, ok: joined === u.text }
      open.reset()
    } else if (u.kind === 'paint') {
      // Track when each word first shows up in a partial — that is when
      // provisional ink could render (spec §6: ≤ 300 ms behind the spoken word).
      // Fresh recognizer: vosk word timestamps count audio fed since creation,
      // and reset() does not zero that clock.
      const paintRec = new Recognizer(model, RATE, docVocabGrammar(SAMPLE_DOC))
      paintRec.setWords(true)
      const firstSeen = []
      const seg = await streamFile(file, [paintRec], {
        onChunk: () => {
          const partialTokens = (paintRec.partial().partial || '').split(' ').filter(Boolean)
          const now = performance.now()
          for (let i = firstSeen.length; i < partialTokens.length; i++) firstSeen.push(now)
        },
      })
      const d = finalize(paintRec, seg.segmentAt)
      const parseAt = seg.segmentAt + d.parseLatency
      const lags = (d.words ?? []).map((w, i) => {
        const seen = firstSeen[i] ?? parseAt
        return seen - (seg.t0 + w.end * 1000)
      })
      row = { ...row, heardCmd: d.text, latency: d.parseLatency, ok: d.text === u.text, paintLagP50: pct(lags, 50), paintLagMax: Math.max(...lags) }
      paintRec.free()
    }
    rows.push(row)
    const lag = row.paintLagP50 != null ? ` inkLag p50 ${row.paintLagP50.toFixed(0)}ms max ${row.paintLagMax.toFixed(0)}ms` : ''
    console.log(`${row.ok ? '✓' : '✗'} [${u.kind}] "${u.text}" → "${row.heardCmd}"${row.parsed ? ` parsed: ${row.parsed}` : ''}  parse ${row.latency.toFixed(0)}ms${lag}`)
  }

  const wallMs = performance.now() - wall0
  const cpu = process.cpuUsage(cpu0)
  const cpuMs = (cpu.user + cpu.system) / 1000

  console.log(`\nmodel load: ${modelLoadMs.toFixed(0)} ms   RSS: ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`)
  console.log(`cpu over bench: ${cpuMs.toFixed(0)} ms over ${wallMs.toFixed(0)} ms wall (${(100 * cpuMs / wallMs).toFixed(0)}% of one core, incl. parallel cmd+doc decode)`)
  for (const kind of ['command', 'quote', 'oog', 'wake', 'dictation', 'paint']) {
    const ks = rows.filter((r) => r.kind === kind)
    if (!ks.length) continue
    const lats = ks.map((r) => r.latency)
    const okN = ks.filter((r) => r.ok).length
    const budget = BUDGETS[kind]
    const worst = Math.max(...lats)
    console.log(`${kind.padEnd(10)} ${okN}/${ks.length} ok   parse-after-segment p50 ${pct(lats, 50).toFixed(0)}ms  max ${worst.toFixed(0)}ms  ${worst <= budget ? 'WITHIN' : 'OVER'} ${budget}ms budget`)
  }
  console.log(`(end-of-utterance is detected ${PAUSE_MS}ms after last voiced audio; "parse-after-segment" is the spec's parse-to-effect clock)`)

  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'results/bench.json'), JSON.stringify({ modelLoadMs, cpuMs, wallMs, rows }, null, 2))
  ;[cmd, doc, open, slp].filter(Boolean).forEach((r) => r.free())
  model.free()
}

async function swapBench() {
  const t0 = performance.now()
  const model = new Model(MODEL_PATH)
  console.log(`model load: ${(performance.now() - t0).toFixed(0)} ms`)

  const cmdG = commandGrammar()
  const docG = docVocabGrammar(SAMPLE_DOC)
  const rec = new Recognizer(model, RATE, cmdG)

  for (const [label, a, b] of [['command↔sleep', cmdG, SLEEP_GRAMMAR], ['command↔doc-vocab', cmdG, docG]]) {
    const times = []
    for (let i = 0; i < 100; i++) {
      const t = performance.now()
      rec.setGrammar(i % 2 ? a : b)
      times.push(performance.now() - t)
    }
    console.log(`set_grm ${label}: p50 ${pct(times, 50).toFixed(2)} ms  p95 ${pct(times, 95).toFixed(2)} ms  max ${Math.max(...times).toFixed(2)} ms`)
  }

  const creates = []
  for (let i = 0; i < 20; i++) {
    const t = performance.now()
    const r = new Recognizer(model, RATE, cmdG)
    creates.push(performance.now() - t)
    r.free()
  }
  console.log(`recognizer create (grammar): p50 ${pct(creates, 50).toFixed(1)} ms  max ${Math.max(...creates).toFixed(1)} ms`)
  rec.free()
  model.free()
}

async function mic(durationSec) {
  const model = new Model(MODEL_PATH)
  const cmd = new Recognizer(model, RATE, commandGrammar())
  cmd.setWords(true)
  const doc = new Recognizer(model, RATE, docVocabGrammar(SAMPLE_DOC))
  const open = new Recognizer(model, RATE)
  // Reserved dictation phrases are spotted out-of-band by a parallel
  // grammar-mode recognizer — the open LM transcribes "end typing" as
  // "the typing" often enough to trap the user in dictation (spec §10).
  const escape = new Recognizer(model, RATE, ['stop typing', 'voice sleep', 'scratch that', '[unk]'])
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true })
  const sessionLog = fs.createWriteStream(path.join(ROOT, 'results/mic-session.log'), { flags: 'a' })
  const emit = (line) => { process.stdout.write('\r' + line + '\n'); sessionLog.write(line + '\n') }
  let mode = 'command' // command | dictation | asleep
  console.log(`mic live (${durationSec ? `auto-exit in ${durationSec}s` : 'Ctrl-C to quit'}). Calibrating noise floor — stay quiet for a second…`)

  const arecord = spawn('arecord', ['-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'raw', '-q'])
  if (durationSec) setTimeout(() => { console.log('(time up)'); arecord.kill() }, durationSec * 1000)
  // Gate auto-calibrates: ambient noise can sit above any fixed constant (it did
  // on the dev machine), which silently prevents utterance segmentation.
  let gate = Number(process.env.RMS_GATE) || 0
  let calibMs = 0
  const calibVals = []
  let lastMeter = 0
  let voicedSeen = false
  let silentMs = 0
  let lastVoiced = 0
  arecord.stdout.on('data', (raw) => {
    const buf = raw.byteOffset % 2 ? Buffer.from(raw) : raw
    const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
    const chunkMs = samples.length / RATE * 1000
    const level = rmsOf(samples)
    if (!gate) {
      calibMs += chunkMs
      // Skip the capture-start transient (full-scale pop for the first few
      // hundred ms on some devices) and clipped chunks — they poison the floor.
      if (calibMs > 500 && level < 30000) calibVals.push(level)
      if (calibMs >= 1800 && calibVals.length >= 5) {
        calibVals.sort((a, b) => a - b)
        const floor = calibVals[Math.floor(calibVals.length / 2)]
        gate = Math.max(300, Math.round(floor * 2.5))
        emit(`noise floor RMS ~${floor.toFixed(0)} → voice gate ${gate} (override with RMS_GATE=N). Speak.`)
      } else if (calibMs >= 4000) {
        gate = 2000
        emit(`calibration got no clean ambient audio; falling back to gate ${gate} (override with RMS_GATE=N). Speak.`)
      }
      return
    }
    const recs = mode === 'dictation' ? [open, escape] : mode === 'asleep' ? [cmd] : [cmd, doc]
    for (const r of recs) r.accept(buf)
    if (!voicedSeen && performance.now() - lastMeter > 1500) {
      lastMeter = performance.now()
      process.stdout.write(`\r  level ${level.toFixed(0).padStart(5)} / gate ${gate}  `)
    }
    if (level > gate) {
      voicedSeen = true
      silentMs = 0
      lastVoiced = performance.now()
    } else if (voicedSeen) {
      silentMs += chunkMs
      if (silentMs < PAUSE_MS) return
      voicedSeen = false
      silentMs = 0
      const segmentAt = performance.now()
      const primary = finalize(mode === 'dictation' ? open : cmd, segmentAt)
      const docRes = mode === 'command' ? finalize(doc, segmentAt) : null
      recs.forEach((r) => r.reset())
      let line = primary.text
      if (mode === 'asleep') {
        if (primary.text === 'voice wake') { mode = 'command'; cmd.setGrammar(commandGrammar()) ; line = '→ awake' }
        else return
      } else if (mode === 'command') {
        if (isRejection(primary.text)) line = `(rejected: "${docRes.text || primary.text}")`
        else if (lowConf(primary)) line = `(rejected, low confidence: "${primary.text}")`
        else {
          const q = spliceQuote(primary.text, docRes?.text ?? '')
          if (q) line = `${q.verb} «${q.quote}»`
          if (primary.text === 'start typing') mode = 'dictation'
          if (primary.text === 'voice sleep') { mode = 'asleep'; cmd.setGrammar(SLEEP_GRAMMAR); line = '→ asleep' }
        }
      } else if (mode === 'dictation') {
        const esc = finalize(escape, segmentAt)
        escape.reset()
        // Lenient match: "end" is a homophone of "and" (live sessions decode
        // "end typing" as "and typing"), and a hallucinated leading word makes
        // exact equality fail. Strip [unk] and match the tail.
        const escText = esc.text.replaceAll('[unk]', '').trim()
        if (escText.endsWith('typing') || primary.text === 'stop typing') { mode = 'command'; line = '→ command mode' }
        else if (escText.endsWith('voice sleep')) { mode = 'asleep'; cmd.setGrammar(SLEEP_GRAMMAR); line = '→ asleep' }
      }
      emit(`[${mode}] ${line}   (parse ${primary.parseLatency.toFixed(0)}ms, +${(segmentAt - lastVoiced).toFixed(0)}ms segmentation)`)
    }
  })
  arecord.on('exit', (code) => { console.log(`arecord exited (${code})`); process.exit(0) })
}

setLogLevel(Number(process.env.VOSK_LOG ?? -1))
const cmdArg = process.argv[2]
if (cmdArg === 'bench') await bench(process.argv[3])
else if (cmdArg === 'swap-bench') await swapBench()
else if (cmdArg === 'mic') await mic(Number(process.argv[3]) || 0)
else { console.error('usage: node src/harness.js bench|swap-bench|mic'); process.exit(1) }
