import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Downmixer, LAYOUTS, SQRT1_2 } from '../src/index.js';

const SR = 48000;

function sine(freq, frames, amp = 1, sr = SR) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function silence(frames) {
  return new Float32Array(frames);
}

// Builds a planar 5.1 buffer set with a sine on exactly one channel.
function fiveOneWith(channelName, frames, amp = 1) {
  const bufs = LAYOUTS['5.1'].map((name) =>
    name === channelName ? sine(440, frames, amp) : silence(frames),
  );
  return bufs;
}

function maxAbs(buf) {
  let m = 0;
  for (const v of buf) m = Math.max(m, Math.abs(v));
  return m;
}

function closeTo(actual, expected, eps = 1e-4) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} (eps ${eps})`,
  );
}

test('channel isolation: L sine reaches only stereo L, R sine only stereo R', () => {
  const frames = 2048;
  const dm = new Downmixer({ inputLayout: '5.1', outputLayout: 'stereo', sampleRate: SR });

  const resL = dm.process(fiveOneWith('L', frames));
  closeTo(maxAbs(resL.channels[0]), 1);
  assert.equal(maxAbs(resL.channels[1]), 0);

  dm.reset();
  const resR = dm.process(fiveOneWith('R', frames));
  assert.equal(maxAbs(resR.channels[0]), 0);
  closeTo(maxAbs(resR.channels[1]), 1);
});

test('center folds into both stereo sides at 1/sqrt(2)', () => {
  const dm = new Downmixer({ inputLayout: '5.1', outputLayout: 'stereo', sampleRate: SR });
  const res = dm.process(fiveOneWith('C', 2048));
  closeTo(maxAbs(res.channels[0]), SQRT1_2);
  closeTo(maxAbs(res.channels[1]), SQRT1_2);
});

test('surrounds fold only into their own side at 1/sqrt(2)', () => {
  const frames = 2048;
  const dm = new Downmixer({ inputLayout: '5.1', outputLayout: 'stereo', sampleRate: SR });

  const resLs = dm.process(fiveOneWith('Ls', frames));
  closeTo(maxAbs(resLs.channels[0]), SQRT1_2);
  assert.equal(maxAbs(resLs.channels[1]), 0);

  dm.reset();
  const resRs = dm.process(fiveOneWith('Rs', frames));
  assert.equal(maxAbs(resRs.channels[0]), 0);
  closeTo(maxAbs(resRs.channels[1]), SQRT1_2);
});

test('LFE is dropped by default and mixed at lfeGain when includeLfe is set', () => {
  const frames = 2048;
  const off = new Downmixer({ inputLayout: '5.1', outputLayout: 'stereo', sampleRate: SR });
  const resOff = off.process(fiveOneWith('LFE', frames));
  assert.equal(maxAbs(resOff.channels[0]), 0);
  assert.equal(maxAbs(resOff.channels[1]), 0);

  const on = new Downmixer({
    inputLayout: '5.1',
    outputLayout: 'stereo',
    sampleRate: SR,
    includeLfe: true,
    lfeGain: 0.5,
  });
  const resOn = on.process(fiveOneWith('LFE', frames));
  closeTo(maxAbs(resOn.channels[0]), 0.5);
  closeTo(maxAbs(resOn.channels[1]), 0.5);
});

test('per-channel gains scale the contribution of each source', () => {
  const frames = 2048;
  const dm = new Downmixer({
    inputLayout: '5.1',
    outputLayout: 'stereo',
    sampleRate: SR,
    channelGains: { C: 2, Ls: 0.5 },
  });
  const resC = dm.process(fiveOneWith('C', frames));
  closeTo(maxAbs(resC.channels[0]), 2 * SQRT1_2);

  dm.reset();
  const resLs = dm.process(fiveOneWith('Ls', frames));
  closeTo(maxAbs(resLs.channels[0]), 0.5 * SQRT1_2);
});

test('7.1 rear surrounds fold into stereo at 1/sqrt(2)', () => {
  const frames = 2048;
  const bufs = LAYOUTS['7.1'].map((name) =>
    name === 'Lrs' ? sine(440, frames) : silence(frames),
  );
  const dm = new Downmixer({ inputLayout: '7.1', outputLayout: 'stereo', sampleRate: SR });
  const res = dm.process(bufs);
  closeTo(maxAbs(res.channels[0]), SQRT1_2);
  assert.equal(maxAbs(res.channels[1]), 0);
});

test('7.1 -> 5.1 folds rears into sides, keeps LFE channel', () => {
  const frames = 1024;
  const bufs = LAYOUTS['7.1'].map((name) =>
    name === 'Lrs' || name === 'LFE' ? sine(220, frames) : silence(frames),
  );
  const dm = new Downmixer({ inputLayout: '7.1', outputLayout: '5.1', sampleRate: SR });
  const res = dm.process(bufs);
  assert.equal(res.channels.length, 6);
  closeTo(maxAbs(res.channels[4]), SQRT1_2); // Ls gets Lrs at -3 dB
  assert.equal(maxAbs(res.channels[5]), 0); // Rs untouched
  closeTo(maxAbs(res.channels[3]), 1); // LFE passes through
});

test('mono downmix weights: center unity, fronts -3 dB, surrounds -6 dB', () => {
  const frames = 1024;
  const mk = () => new Downmixer({ inputLayout: '5.1', outputLayout: 'mono', sampleRate: SR });

  closeTo(maxAbs(mk().process(fiveOneWith('C', frames)).channels[0]), 1);
  closeTo(maxAbs(mk().process(fiveOneWith('L', frames)).channels[0]), SQRT1_2);
  closeTo(maxAbs(mk().process(fiveOneWith('Rs', frames)).channels[0]), 0.5);
});

test('peak above targetPeak is reported with attenuation and positions, never clipped', () => {
  const frames = 512;
  const hot = sine(100, frames, 2.0);
  const dm = new Downmixer({
    inputLayout: 'stereo',
    outputLayout: 'stereo',
    sampleRate: SR,
    targetPeak: 0.5,
  });
  const res = dm.process([hot, silence(frames)]);

  assert.equal(res.limited, true);
  closeTo(res.peak, 2.0, 1e-6);
  closeTo(res.requiredAttenuationDb, 20 * Math.log10(2.0 / 0.5), 1e-6);
  // Reported positions must be exactly the samples exceeding targetPeak.
  const expected = [];
  for (let i = 0; i < frames; i++) {
    if (Math.abs(hot[i]) > 0.5) expected.push(i);
  }
  assert.deepEqual(
    res.clippedSamples.map((s) => s.index),
    expected,
  );
  assert.ok(res.clippedSamples.every((s) => s.channel === 0));
  // Output is left untouched (no silent clipping).
  assert.ok(maxAbs(res.channels[0]) > 0.5);
});

test('autoAttenuate scales output to targetPeak and still reports', () => {
  const frames = 512;
  const dm = new Downmixer({
    inputLayout: 'stereo',
    outputLayout: 'stereo',
    sampleRate: SR,
    targetPeak: 0.5,
    autoAttenuate: true,
  });
  const res = dm.process([sine(100, frames, 2.0), silence(frames)]);
  assert.equal(res.limited, true);
  closeTo(maxAbs(res.channels[0]), 0.5, 1e-6);
});

test('block processing is bit-identical to one-shot, including gain ramps', () => {
  const frames = 4096;
  const input = LAYOUTS['5.1'].map((name, i) => sine(110 * (i + 1), frames, 0.6));
  const mk = () =>
    new Downmixer({
      inputLayout: '5.1',
      outputLayout: 'stereo',
      sampleRate: SR,
      smoothingMs: 10,
      includeLfe: true,
    });

  const oneShot = mk();
  oneShot.setChannelGain('C', 2.5); // exercise the smoother
  const whole = oneShot.process(input);

  const chunked = mk();
  chunked.setChannelGain('C', 2.5);
  const sizes = [1000, 37, 1559, 1500];
  const parts = [];
  let offset = 0;
  for (const size of sizes) {
    parts.push(
      chunked.process(input.map((buf) => buf.subarray(offset, offset + size))),
    );
    offset += size;
  }
  assert.equal(offset, frames);

  for (let o = 0; o < whole.channels.length; o++) {
    const joined = new Float32Array(frames);
    let pos = 0;
    for (const part of parts) {
      joined.set(part.channels[o], pos);
      pos += part.frameCount;
    }
    assert.deepEqual(joined, whole.channels[o], `channel ${o} differs across block sizes`);
  }
});

test('silence in produces silence out with zero peak', () => {
  const dm = new Downmixer({ inputLayout: '5.1', outputLayout: 'stereo', sampleRate: SR });
  const res = dm.process(LAYOUTS['5.1'].map(() => silence(1024)));
  assert.equal(res.peak, 0);
  assert.equal(res.limited, false);
  assert.equal(res.requiredAttenuationDb, 0);
  assert.deepEqual(res.clippedSamples, []);
  assert.ok(res.channels.every((c) => maxAbs(c) === 0));
});

test('results are deterministic across identical runs', () => {
  const frames = 2048;
  const input = LAYOUTS['7.1'].map((_, i) => sine(97 * (i + 1), frames, 0.4));
  const mk = () =>
    new Downmixer({
      inputLayout: '7.1',
      outputLayout: 'stereo',
      sampleRate: SR,
      includeLfe: true,
      channelGains: { C: 1.3 },
    });
  const a = mk().process(input);
  const b = mk().process(input);
  assert.deepEqual(a.channels, b.channels);
  assert.equal(a.peak, b.peak);
});

test('empty frames return empty output without error', () => {
  const dm = new Downmixer({ inputLayout: '5.1', outputLayout: 'stereo', sampleRate: SR });
  const res = dm.process(LAYOUTS['5.1'].map(() => new Float32Array(0)));
  assert.equal(res.frameCount, 0);
  assert.equal(res.peak, 0);
  assert.equal(res.limited, false);
  assert.ok(res.channels.every((c) => c.length === 0));
});

test('wrong channel count throws', () => {
  const dm = new Downmixer({ inputLayout: '5.1', outputLayout: 'stereo', sampleRate: SR });
  assert.throws(() => dm.process([silence(16), silence(16)]), RangeError);
});

test('mismatched channel lengths throw', () => {
  const dm = new Downmixer({ inputLayout: 'stereo', outputLayout: 'stereo', sampleRate: SR });
  assert.throws(() => dm.process([silence(16), silence(8)]), RangeError);
});

test('NaN or Infinity samples throw with channel and frame info', () => {
  const dm = new Downmixer({ inputLayout: 'stereo', outputLayout: 'stereo', sampleRate: SR });
  const bad = silence(16);
  bad[7] = NaN;
  assert.throws(() => dm.process([silence(16), bad]), /channel "R".*frame 7/);
  bad[7] = Infinity;
  assert.throws(() => dm.process([silence(16), bad]), TypeError);
});

test('channelOrder must be an exact permutation of the layout', () => {
  assert.throws(
    () =>
      new Downmixer({
        inputLayout: '5.1',
        outputLayout: 'stereo',
        channelOrder: ['L', 'R', 'C', 'LFE', 'Ls', 'Ls'],
      }),
    /does not match/,
  );
  // A valid permutation is honored: sine placed in caller slot 0 = 'C'.
  const dm = new Downmixer({
    inputLayout: 'stereo',
    outputLayout: 'stereo',
    sampleRate: SR,
    channelOrder: ['R', 'L'],
  });
  const res = dm.process([sine(440, 512), silence(512)]);
  assert.equal(maxAbs(res.channels[0]), 0); // canonical L is caller slot 1
  closeTo(maxAbs(res.channels[1]), 1);
});

test('LFE-only output layout is rejected explicitly', () => {
  assert.throws(
    () => new Downmixer({ inputLayout: '5.1', outputLayout: 'lfe' }),
    /LFE cannot be rendered as a standalone/,
  );
});

test('unknown layouts and upmix requests throw', () => {
  assert.throws(() => new Downmixer({ inputLayout: 'quad', outputLayout: 'stereo' }), RangeError);
  assert.throws(() => new Downmixer({ inputLayout: 'stereo', outputLayout: '5.1' }), /upmix/);
});

test('invalid gains and targetPeak throw', () => {
  assert.throws(
    () => new Downmixer({ inputLayout: 'stereo', outputLayout: 'mono', channelGains: { L: NaN } }),
    RangeError,
  );
  assert.throws(
    () => new Downmixer({ inputLayout: 'stereo', outputLayout: 'mono', targetPeak: 0 }),
    RangeError,
  );
});
