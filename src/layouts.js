// Canonical channel layouts. The array index is the position of the channel
// in the planar input/output buffers passed to Downmixer.
export const LAYOUTS = Object.freeze({
  mono: Object.freeze(['M']),
  stereo: Object.freeze(['L', 'R']),
  '5.1': Object.freeze(['L', 'R', 'C', 'LFE', 'Ls', 'Rs']),
  '7.1': Object.freeze(['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lrs', 'Rrs']),
});

export const SQRT1_2 = Math.SQRT1_2; // 0.7071..., -3.01 dB

export function channelCount(layoutName) {
  const layout = LAYOUTS[layoutName];
  if (!layout) {
    if (layoutName === 'lfe' || layoutName === 'LFE') {
      throw new RangeError(
        `Invalid output layout "${layoutName}": LFE cannot be rendered as a standalone output layout`,
      );
    }
    throw new RangeError(
      `Unknown layout "${layoutName}". Supported layouts: ${Object.keys(LAYOUTS).join(', ')}`,
    );
  }
  return layout.length;
}

// Builds the downmix matrix as matrix[outIndex][inIndex] of linear gains.
// Only downmixing (or identity) is supported: output must not have more
// channels than input.
export function buildDownmixMatrix(inputLayoutName, outputLayoutName, { includeLfe = false, lfeGain = 0.5 } = {}) {
  const input = LAYOUTS[inputLayoutName] ?? failLayout(inputLayoutName);
  const output = LAYOUTS[outputLayoutName] ?? failLayout(outputLayoutName);

  if (output.length > input.length) {
    throw new RangeError(
      `Cannot upmix from ${inputLayoutName} (${input.length}ch) to ${outputLayoutName} (${output.length}ch); only downmix or passthrough is supported`,
    );
  }

  const inIdx = new Map(input.map((name, i) => [name, i]));
  const matrix = output.map(() => new Float64Array(input.length));

  const put = (outName, inName, gain) => {
    const oi = output.indexOf(outName);
    const ii = inIdx.get(inName);
    if (oi >= 0 && ii !== undefined) matrix[oi][ii] += gain;
  };

  if (inputLayoutName === outputLayoutName) {
    for (let i = 0; i < input.length; i++) matrix[i][i] = 1;
    return matrix;
  }

  if (outputLayoutName === 'mono') {
    // Mono fold-down: fronts at -3 dB, center at unity, surrounds at -6 dB.
    put('M', 'M', 1);
    put('M', 'L', SQRT1_2);
    put('M', 'R', SQRT1_2);
    put('M', 'C', 1);
    put('M', 'Ls', 0.5);
    put('M', 'Rs', 0.5);
    put('M', 'Lrs', 0.5);
    put('M', 'Rrs', 0.5);
    if (includeLfe) put('M', 'LFE', lfeGain);
    return matrix;
  }

  if (outputLayoutName === 'stereo') {
    // Lo/Ro style: center and each surround fold into the same-side front
    // at -3 dB. Mono input mirrors to both sides.
    put('L', 'M', 1);
    put('R', 'M', 1);
    put('L', 'L', 1);
    put('R', 'R', 1);
    put('L', 'C', SQRT1_2);
    put('R', 'C', SQRT1_2);
    put('L', 'Ls', SQRT1_2);
    put('R', 'Rs', SQRT1_2);
    put('L', 'Lrs', SQRT1_2);
    put('R', 'Rrs', SQRT1_2);
    if (includeLfe) {
      put('L', 'LFE', lfeGain);
      put('R', 'LFE', lfeGain);
    }
    return matrix;
  }

  if (outputLayoutName === '5.1') {
    // Only reachable from 7.1: rear surrounds fold into side surrounds at -3 dB.
    put('L', 'L', 1);
    put('R', 'R', 1);
    put('C', 'C', 1);
    put('LFE', 'LFE', 1);
    put('Ls', 'Ls', 1);
    put('Rs', 'Rs', 1);
    put('Ls', 'Lrs', SQRT1_2);
    put('Rs', 'Rrs', SQRT1_2);
    return matrix;
  }

  // outputLayoutName === '7.1' with fewer input channels was rejected above.
  throw new RangeError(`No downmix path from ${inputLayoutName} to ${outputLayoutName}`);
}

function failLayout(name) {
  return channelCount(name); // always throws
}

// Validates an optional caller-declared channel order. When provided it must
// be an exact permutation of the layout's canonical order; the returned
// index map lets the caller's buffers be reordered into canonical order.
export function resolveChannelOrder(layoutName, declaredOrder) {
  const canonical = LAYOUTS[layoutName];
  if (declaredOrder === undefined || declaredOrder === null) {
    return canonical.map((_, i) => i);
  }
  if (!Array.isArray(declaredOrder) || declaredOrder.length !== canonical.length) {
    throw new RangeError(
      `channelOrder for layout "${layoutName}" must list exactly ${canonical.length} channels: [${canonical.join(', ')}]`,
    );
  }
  const seen = new Set(declaredOrder);
  if (seen.size !== canonical.length || !canonical.every((c) => seen.has(c))) {
    throw new RangeError(
      `channelOrder [${declaredOrder.join(', ')}] does not match layout "${layoutName}" order [${canonical.join(', ')}]`,
    );
  }
  // remap[i] = position of canonical channel i inside the caller's buffers
  return canonical.map((c) => declaredOrder.indexOf(c));
}
