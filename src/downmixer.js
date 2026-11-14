import { LAYOUTS, buildDownmixMatrix, resolveChannelOrder } from './layouts.js';

const DEFAULT_SMOOTHING_MS = 5;
const DEFAULT_TARGET_PEAK = 1.0;
const DEFAULT_LFE_GAIN = 0.5;

// Stateful multichannel downmixer. Gain changes are smoothed per sample with
// a one-pole filter whose state persists across process() calls, so splitting
// a stream into blocks never resets the smoother at block boundaries.
export class Downmixer {
  constructor({
    inputLayout,
    outputLayout,
    sampleRate = 48000,
    channelGains = {},
    includeLfe = false,
    lfeGain = DEFAULT_LFE_GAIN,
    targetPeak = DEFAULT_TARGET_PEAK,
    smoothingMs = DEFAULT_SMOOTHING_MS,
    channelOrder,
    autoAttenuate = false,
  } = {}) {
    if (!LAYOUTS[inputLayout]) throw new RangeError(`Unknown inputLayout "${inputLayout}"`);
    this.inputLayout = inputLayout;
    this.outputLayout = outputLayout;
    this.sampleRate = sampleRate;
    this.includeLfe = Boolean(includeLfe);
    this.lfeGain = lfeGain;
    this.targetPeak = targetPeak;
    this.autoAttenuate = Boolean(autoAttenuate);
    this.remap = resolveChannelOrder(inputLayout, channelOrder);

    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
      throw new RangeError(`sampleRate must be a positive finite number, got ${sampleRate}`);
    }
    if (!(targetPeak > 0) || !Number.isFinite(targetPeak)) {
      throw new RangeError(`targetPeak must be a positive finite number, got ${targetPeak}`);
    }
    if (!(smoothingMs >= 0) || !Number.isFinite(smoothingMs)) {
      throw new RangeError(`smoothingMs must be a non-negative finite number, got ${smoothingMs}`);
    }

    this.matrix = buildDownmixMatrix(inputLayout, outputLayout, {
      includeLfe: this.includeLfe,
      lfeGain,
    });

    this.channelNames = LAYOUTS[inputLayout];
    // One-pole smoothing coefficient; k = 1 means instant (no smoothing).
    this.smoothingK =
      smoothingMs === 0 ? 1 : 1 - Math.exp(-1 / ((sampleRate * smoothingMs) / 1000));

    this.targetGains = new Float64Array(this.channelNames.length).fill(1);
    for (const [name, gain] of Object.entries(channelGains)) {
      const idx = this.channelNames.indexOf(name);
      if (idx === -1) {
        throw new RangeError(
          `Unknown channel "${name}" for layout "${inputLayout}". Valid: ${this.channelNames.join(', ')}`,
        );
      }
      validateGain(name, gain);
      this.targetGains[idx] = gain;
    }
    // Smoother state starts at the target so a static configuration is
    // artifact-free from the very first sample; only later gain changes ramp.
    this.gainState = Float64Array.from(this.targetGains);
  }

  setChannelGain(name, gain) {
    const idx = this.channelNames.indexOf(name);
    if (idx === -1) {
      throw new RangeError(
        `Unknown channel "${name}" for layout "${this.inputLayout}". Valid: ${this.channelNames.join(', ')}`,
      );
    }
    validateGain(name, gain);
    this.targetGains[idx] = gain;
  }

  // Clears smoother state (e.g. when starting a new, unrelated stream).
  reset() {
    this.gainState = Float64Array.from(this.targetGains);
  }

  // channels: planar array of Float32Array (or number[]), one per input
  // channel, in the order declared by channelOrder (default: canonical
  // layout order). All channels must have equal frame counts.
  process(channels) {
    if (!Array.isArray(channels) || channels.length !== this.channelNames.length) {
      throw new RangeError(
        `Expected ${this.channelNames.length} channel buffers for layout "${this.inputLayout}", got ${channels?.length}`,
      );
    }
    const ordered = this.remap.map((srcPos) => channels[srcPos]);
    const frameCount = validateFrames(ordered, this.channelNames);

    const outCount = this.matrix.length;
    const output = Array.from({ length: outCount }, () => new Float32Array(frameCount));
    if (frameCount === 0) {
      return {
        channels: output,
        frameCount: 0,
        peak: 0,
        limited: false,
        requiredAttenuationDb: 0,
        clippedSamples: [],
      };
    }

    const { matrix, gainState, targetGains, smoothingK: k } = this;
    const inCount = ordered.length;

    // Apply smoothed per-channel gains. State carries across calls, so block
    // size has no effect on the result.
    const gained = new Array(inCount);
    for (let c = 0; c < inCount; c++) {
      const src = ordered[c];
      const dst = new Float64Array(frameCount);
      let g = gainState[c];
      const target = targetGains[c];
      for (let i = 0; i < frameCount; i++) {
        g += (target - g) * k;
        dst[i] = src[i] * g;
      }
      gainState[c] = g;
      gained[c] = dst;
    }

    // Matrix mix in float64, then narrow to float32 output.
    for (let o = 0; o < outCount; o++) {
      const row = matrix[o];
      const out = output[o];
      for (let i = 0; i < frameCount; i++) {
        let acc = 0;
        for (let c = 0; c < inCount; c++) {
          const coeff = row[c];
          if (coeff !== 0) acc += coeff * gained[c][i];
        }
        out[i] = acc;
      }
    }

    // Peak inspection: report, never silently clip.
    let peak = 0;
    const clippedSamples = [];
    for (let o = 0; o < outCount; o++) {
      const out = output[o];
      for (let i = 0; i < frameCount; i++) {
        const mag = Math.abs(out[i]);
        if (mag > peak) peak = mag;
        if (mag > this.targetPeak) {
          clippedSamples.push({ channel: o, index: i, value: out[i] });
        }
      }
    }

    const limited = peak > this.targetPeak;
    const requiredAttenuationDb = limited ? 20 * Math.log10(peak / this.targetPeak) : 0;

    if (limited && this.autoAttenuate) {
      const scale = this.targetPeak / peak;
      for (const out of output) {
        for (let i = 0; i < frameCount; i++) out[i] *= scale;
      }
    }

    return {
      channels: output,
      frameCount,
      peak,
      limited,
      requiredAttenuationDb,
      clippedSamples,
    };
  }
}

function validateGain(name, gain) {
  if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0) {
    throw new RangeError(`Gain for channel "${name}" must be a finite number >= 0, got ${gain}`);
  }
}

function validateFrames(ordered, channelNames) {
  let frameCount = -1;
  for (let c = 0; c < ordered.length; c++) {
    const buf = ordered[c];
    if (!buf || typeof buf.length !== 'number') {
      throw new TypeError(`Channel "${channelNames[c]}" is not a sample array`);
    }
    if (frameCount === -1) frameCount = buf.length;
    else if (buf.length !== frameCount) {
      throw new RangeError(
        `Channel "${channelNames[c]}" has ${buf.length} frames, expected ${frameCount} (all channels must match)`,
      );
    }
    for (let i = 0; i < buf.length; i++) {
      if (!Number.isFinite(buf[i])) {
        throw new TypeError(
          `Non-finite sample (${buf[i]}) in channel "${channelNames[c]}" at frame ${i}`,
        );
      }
    }
  }
  return frameCount === -1 ? 0 : frameCount;
}
