#!/usr/bin/env node
/**
 * Headless smoke test for the compiled voice service: feeds the
 * recognizer-spike's WAV fixtures through dist/voice/service.js and
 * asserts the typed event stream — command parse, quote splice,
 * out-of-grammar rejection, dictation, reserved-phrase escape, and the
 * sleep/wake mode walk. Run after `npm run build:main`.
 */
const path = require('node:path');
const { VoiceService } = require('../dist/voice/service.js');

const SPIKE = path.join(__dirname, '..', '..', '..', 'spikes', 'voice-recognizer');
const AUDIO = (f) => path.join(SPIKE, 'audio', f);

const DOC_TEXT = `
Security cooperation has historically served as the backbone of deterrence.
Conventional arms transfers deter aggression by signaling commitment to partners.
The Ukraine case demonstrates that even non allied recipients can anchor extended
deterrence when weapons transfers are timely and sustained.
`;

async function main() {
  const { readWav } = await import(path.join(SPIKE, 'src', 'wav.js'));

  const events = [];
  const service = new VoiceService({
    libPath: path.join(SPIKE, 'lib', 'libvosk.so'),
    modelDir: path.join(SPIKE, 'models', 'vosk-model-en-us-0.22-lgraph'),
    rmsGate: 200, // fixtures have digital-silence padding; skip calibration
    onEvent: (e) => events.push(e),
  });
  const { modelLoadMs } = service.start();
  service.setVocabulary(DOC_TEXT);
  console.log(`model loaded in ${modelLoadMs.toFixed(0)}ms`);

  const feed = (file) => {
    const { samples, sampleRate } = readWav(AUDIO(file));
    if (sampleRate !== 16000) throw new Error(`${file}: expected 16kHz`);
    const chunk = 320; // 20ms
    for (let i = 0; i * chunk < samples.length; i++) {
      const slice = samples.subarray(i * chunk, Math.min((i + 1) * chunk, samples.length));
      service.pushAudio(Buffer.from(slice.buffer, slice.byteOffset, slice.length * 2));
    }
  };

  const checks = [];
  const expect = (label, fn) => {
    const got = events.splice(0, events.length);
    let pass = false;
    let detail = '';
    try {
      pass = fn(got);
      detail = JSON.stringify(
        got.map((e) => ({ kind: e.kind, verb: e.verb, to: e.to, reason: e.reason, text: e.text, raw: e.raw })),
      );
    } catch (err) {
      detail = String(err);
    }
    checks.push({ label, pass, detail });
    console.log(`${pass ? '✓' : '✗'} ${label}${pass ? '' : '  got: ' + detail}`);
  };

  feed('pen-underline.wav');
  expect('command: pen underline', (got) =>
    got.some((e) => e.kind === 'command' && e.verb === 'pen' && e.args.pen === 'underline'));

  feed('take-card.wav');
  expect('command: take card', (got) =>
    got.some((e) => e.kind === 'command' && e.verb === 'takeNode' && e.args.target === 'card'));

  feed('go-to-weapons-transfers.wav');
  expect('quote splice: go to «weapons transfers»', (got) =>
    got.some((e) => e.kind === 'command' && e.verb === 'goTo' && e.args.quote === 'weapons transfers'));

  feed('oog-hello.wav');
  expect('rejection: out-of-grammar speech', (got) =>
    got.length > 0 && got.every((e) => e.kind === 'rejection'));

  feed('start-typing.wav');
  expect('mode: start typing → dictation', (got) =>
    got.some((e) => e.kind === 'command' && e.verb === 'startTyping') &&
    got.some((e) => e.kind === 'mode' && e.to === 'dictation'));

  feed('dictation-1.wav');
  expect('dictation: transcribed text', (got) =>
    got.some((e) => e.kind === 'dictation' && e.text.includes('conventional arms transfers')));

  feed('voice-sleep.wav');
  expect('escape: voice sleep pierces dictation → asleep', (got) =>
    got.some((e) => e.kind === 'command' && e.verb === 'voiceSleep') &&
    got.some((e) => e.kind === 'mode' && e.to === 'asleep'));

  feed('oog-lunch.wav');
  expect('asleep: speech is discarded with no event', (got) => got.length === 0);

  feed('voice-wake.wav');
  expect('wake: voice wake → command mode', (got) =>
    got.some((e) => e.kind === 'mode' && e.to === 'command'));

  service.stop();
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
