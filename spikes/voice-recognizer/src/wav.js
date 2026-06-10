// Tiny WAV read/write + linear resampler — enough for 16-bit mono PCM test files.
import fs from 'node:fs'

export function readWav(file) {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: not a RIFF/WAVE file`)
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      }
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size)
    }
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error(`${file}: missing fmt/data chunk`)
  if (fmt.format !== 1 || fmt.bitsPerSample !== 16 || fmt.channels !== 1) {
    throw new Error(`${file}: expected 16-bit mono PCM, got ${JSON.stringify(fmt)}`)
  }
  const samples = new Int16Array(data.buffer, data.byteOffset, data.length / 2)
  return { sampleRate: fmt.sampleRate, samples: samples.slice() }
}

export function writeWav(file, samples, sampleRate) {
  const dataLen = samples.length * 2
  const buf = Buffer.alloc(44 + dataLen)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataLen, 40)
  Buffer.from(samples.buffer, samples.byteOffset, dataLen).copy(buf, 44)
  fs.writeFileSync(file, buf)
}

export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples
  const outLen = Math.floor(samples.length * toRate / fromRate)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i * fromRate / toRate
    const lo = Math.floor(src)
    const hi = Math.min(lo + 1, samples.length - 1)
    const frac = src - lo
    out[i] = Math.round(samples[lo] * (1 - frac) + samples[hi] * frac)
  }
  return out
}
