// lib/clickSound.ts
//
// Click-sound engine (Requirement 22).
//
// Ports the retired Legacy_Frontend's Web-Audio click-sound synthesis
// "Sound profiles") into a small, reusable module. It owns:
//
//   - the predefined click-sound profiles ({@link SOUND_PROFILES}), each of
//     which synthesizes a short mechanical-keyboard-style click entirely from
//     the Web Audio API (no external asset files);
//   - the lazily-created shared `AudioContext` ({@link getAudioContext});
//   - playback of a decoded custom audio buffer ({@link playBuffer}) and
//     decoding of an uploaded file ({@link decodeAudioFile});
//   - the small pure helpers the `soundStore` needs to validate persisted
//     values ({@link isValidProfileId}, {@link clampVolume}).
//
// The synthesis logic and volume/gain scaling mirror the legacy implementation
// so the React_Frontend produces the same click feedback. Everything degrades
// gracefully when there is no Web Audio support (e.g. jsdom in tests): the
// context helper returns `null` and playback becomes a no-op.

/** The predefined click-sound profile ids, in display order. */
export const SOUND_PROFILE_IDS = [
  'clicky',
  'thocky',
  'creamy',
  'poppy',
  'typewriter',
  'off',
] as const;

/** A predefined click-sound profile id. */
export type SoundProfileId = (typeof SOUND_PROFILE_IDS)[number];

/** The profile selected when nothing valid is persisted (Requirement 22.1). */
export const DEFAULT_PROFILE_ID: SoundProfileId = 'clicky';

/** Volume bounds (linear gain multiplier, matching the Legacy_Frontend). */
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;
/** Volume applied when nothing valid is persisted (Requirement 22.3). */
export const DEFAULT_VOLUME = 0.35;

/** Metadata + synthesis for one predefined profile. */
export interface SoundProfile {
  /** Stable id used for selection and persistence. */
  readonly id: SoundProfileId;
  /** Human-readable label shown on the profile card. */
  readonly label: string;
  /** Material icon name shown on the profile card. */
  readonly icon: string;
  /** Short description shown under the label. */
  readonly desc: string;
  /**
   * Synthesize and play this profile once at linear gain `vol`. A no-op when
   * `ctx` is `null` (no Web Audio support) or for the silent "off" profile.
   */
  play(ctx: AudioContext | null, vol: number): void;
}

/**
 * Type guard: `true` iff `value` names one of the predefined profiles.
 * Exported so the store can validate a persisted selection.
 */
export function isValidProfileId(value: unknown): value is SoundProfileId {
  return (
    typeof value === 'string' &&
    (SOUND_PROFILE_IDS as readonly string[]).includes(value)
  );
}

/**
 * Clamp an arbitrary value to the valid volume range `[0, 1]`.
 *
 * Non-finite input (NaN, Infinity, non-numbers) resolves to
 * {@link DEFAULT_VOLUME} so a corrupted persisted value never yields a broken
 * or silent slider. Pure; exported for testing.
 */
export function clampVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_VOLUME;
  }
  if (value < VOLUME_MIN) return VOLUME_MIN;
  if (value > VOLUME_MAX) return VOLUME_MAX;
  return value;
}

// ── Shared AudioContext ─────────────────────────────────────────────────────

let audioCtx: AudioContext | null = null;

/**
 * Return the lazily-created shared `AudioContext`, or `null` when the Web Audio
 * API is unavailable (e.g. jsdom). Never throws.
 */
export function getAudioContext(): AudioContext | null {
  if (audioCtx) {
    return audioCtx;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    return null;
  }
  try {
    audioCtx = new Ctor();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

// ── Synthesis helpers (ported from the Legacy_Frontend) ─────────────────────

/** One sample of white noise in `[-1, 1)`. */
function noise(): number {
  return Math.random() * 2 - 1;
}

/** Build a single-channel buffer of `durationSec` filled by `fill`. */
function makeBuf(
  ctx: AudioContext,
  durationSec: number,
  fill: (data: Float32Array, sampleRate: number) => void,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.ceil(sr * durationSec));
  const buf = ctx.createBuffer(1, len, sr);
  fill(buf.getChannelData(0), sr);
  return buf;
}

/** Create a biquad filter node. */
function filt(
  ctx: AudioContext,
  type: BiquadFilterType,
  freq: number,
  q?: number,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  if (q !== undefined) {
    f.Q.value = q;
  }
  return f;
}

/** Play a filled buffer through a gain stage into the destination. */
function playSynthBuffer(
  ctx: AudioContext,
  buf: AudioBuffer,
  node: AudioNode,
  gain: GainNode,
  start: number,
  stop: number,
): void {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(node);
  node.connect(gain);
  gain.connect(ctx.destination);
  src.start(start);
  src.stop(stop);
}

/**
 * Play an already-decoded audio buffer (a custom uploaded sound) at linear gain
 * `vol`. No-op when `ctx` is `null`. Never throws.
 */
export function playBuffer(
  ctx: AudioContext | null,
  buffer: AudioBuffer,
  vol: number,
): void {
  if (!ctx) {
    return;
  }
  try {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(ctx.destination);
    src.start();
    src.stop(ctx.currentTime + buffer.duration);
  } catch {
    // Web Audio failures must never break the click that triggered them.
  }
}

/**
 * Decode an uploaded audio file into an `AudioBuffer` using the shared context.
 * Rejects when there is no Web Audio support or the file cannot be decoded.
 */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  if (!ctx) {
    throw new Error('Web Audio API is not available.');
  }
  const arrayBuffer = await file.arrayBuffer();
  return ctx.decodeAudioData(arrayBuffer);
}

// ── Predefined profiles ─────────────────────────────────────────────────────

/**
 * The predefined click-sound profiles, keyed by id. Each `play` synthesizes a
 * short click at linear gain `vol`; the synthesis is a direct port of the
 * Legacy_Frontend so the feel matches. Guarded so a missing context is a no-op.
 */
export const SOUND_PROFILES: Readonly<Record<SoundProfileId, SoundProfile>> = {
  clicky: {
    id: 'clicky',
    label: 'Clicky',
    icon: 'keyboard',
    desc: 'Cherry MX Blue - sharp tactile snap',
    play(ctx, vol) {
      if (!ctx) return;
      const t = ctx.currentTime;
      // 1) Sharp high-freq click transient.
      const clickBuf = makeBuf(ctx, 0.008, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          const x = i / sr;
          d[i] =
            (noise() * 0.7 + Math.sin(2 * Math.PI * 3200 * x) * 0.3) *
            Math.exp(-x * 1800);
        }
      });
      const g1 = ctx.createGain();
      g1.gain.setValueAtTime(vol * 2.5, t);
      g1.gain.exponentialRampToValueAtTime(0.001, t + 0.008);
      playSynthBuffer(ctx, clickBuf, filt(ctx, 'highpass', 3500), g1, t, t + 0.01);

      // 2) Mid-range body snap.
      const snapBuf = makeBuf(ctx, 0.025, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          const x = i / sr;
          d[i] =
            (noise() * 0.5 +
              Math.sin(2 * Math.PI * 1100 * x) * 0.4 +
              Math.sin(2 * Math.PI * 2200 * x) * 0.1) *
            Math.exp(-x * 350);
        }
      });
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(vol * 1.8, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
      playSynthBuffer(ctx, snapBuf, filt(ctx, 'bandpass', 1400, 1.2), g2, t, t + 0.03);

      // 3) Low-end bottom-out thud.
      const thudBuf = makeBuf(ctx, 0.035, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          const x = i / sr;
          d[i] =
            (noise() * 0.3 + Math.sin(2 * Math.PI * 180 * x) * 0.7) *
            Math.exp(-x * 180);
        }
      });
      const g3 = ctx.createGain();
      g3.gain.setValueAtTime(vol * 0.6, t + 0.004);
      g3.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      playSynthBuffer(ctx, thudBuf, filt(ctx, 'lowpass', 600), g3, t + 0.004, t + 0.045);
    },
  },

  thocky: {
    id: 'thocky',
    label: 'Thocky',
    icon: 'piano',
    desc: 'NK Cream - deep marbly thud',
    play(ctx, vol) {
      if (!ctx) return;
      const t = ctx.currentTime;
      // 1) Deep pitched thud.
      const thudBuf = makeBuf(ctx, 0.12, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          const x = i / sr;
          const freq = 95 + 280 * Math.exp(-x * 60);
          d[i] =
            (Math.sin(2 * Math.PI * freq * x) * 0.65 +
              Math.sin(2 * Math.PI * freq * 1.6 * x) * 0.2 +
              noise() * 0.15) *
            Math.exp(-x * 65);
        }
      });
      const g1 = ctx.createGain();
      g1.gain.setValueAtTime(vol * 1.8, t);
      g1.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      playSynthBuffer(ctx, thudBuf, filt(ctx, 'lowpass', 700), g1, t, t + 0.13);

      // 2) Soft high transient.
      const transBuf = makeBuf(ctx, 0.015, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          d[i] = noise() * Math.exp(-(i / sr) * 900);
        }
      });
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(vol * 0.7, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
      playSynthBuffer(ctx, transBuf, filt(ctx, 'bandpass', 900, 0.7), g2, t, t + 0.02);

      // 3) Low-frequency body resonance.
      const resBuf = makeBuf(ctx, 0.08, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          const x = i / sr;
          d[i] = Math.sin(2 * Math.PI * 55 * x) * Math.exp(-x * 90) * 0.9;
        }
      });
      const g3 = ctx.createGain();
      g3.gain.setValueAtTime(vol * 0.9, t);
      g3.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      playSynthBuffer(ctx, resBuf, filt(ctx, 'lowpass', 200), g3, t, t + 0.09);
    },
  },

  creamy: {
    id: 'creamy',
    label: 'Creamy',
    icon: 'water_drop',
    desc: 'Gateron Yellow - buttery smooth glide',
    play(ctx, vol) {
      if (!ctx) return;
      const t = ctx.currentTime;
      // 1) Very soft initial contact.
      const softBuf = makeBuf(ctx, 0.07, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          const x = i / sr;
          const freq = 130 + 100 * Math.exp(-x * 40);
          d[i] =
            (Math.sin(2 * Math.PI * freq * x) * 0.55 +
              Math.sin(2 * Math.PI * freq * 2.1 * x) * 0.25 +
              Math.sin(2 * Math.PI * freq * 3.3 * x) * 0.12 +
              noise() * 0.08) *
            Math.exp(-x * 110);
        }
      });
      const g1 = ctx.createGain();
      g1.gain.setValueAtTime(vol * 1.6, t);
      g1.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      playSynthBuffer(ctx, softBuf, filt(ctx, 'bandpass', 280, 0.6), g1, t, t + 0.075);

      // 2) Subtle air/brush noise.
      const brushBuf = makeBuf(ctx, 0.05, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          d[i] = noise() * Math.exp(-(i / sr) * 200) * 0.5;
        }
      });
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(vol * 0.3, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      playSynthBuffer(ctx, brushBuf, filt(ctx, 'bandpass', 500, 1.5), g2, t, t + 0.06);

      // 3) Warm low-end resonance.
      const warmBuf = makeBuf(ctx, 0.06, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          const x = i / sr;
          d[i] =
            (Math.sin(2 * Math.PI * 70 * x) * 0.6 +
              Math.sin(2 * Math.PI * 140 * x) * 0.4) *
            Math.exp(-x * 140);
        }
      });
      const g3 = ctx.createGain();
      g3.gain.setValueAtTime(vol * 1.0, t);
      g3.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      playSynthBuffer(ctx, warmBuf, filt(ctx, 'lowpass', 350), g3, t, t + 0.07);
    },
  },

  poppy: {
    id: 'poppy',
    label: 'Poppy',
    icon: 'bubble_chart',
    desc: 'Light airy pop',
    play(ctx, vol) {
      if (!ctx) return;
      const t = ctx.currentTime;
      const buf = makeBuf(ctx, 0.025, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          d[i] = noise() * Math.exp(-(i / sr) * 1100);
        }
      });
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol * 1.8, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
      playSynthBuffer(ctx, buf, filt(ctx, 'bandpass', 1800, 1.2), g, t, t + 0.025);
    },
  },

  typewriter: {
    id: 'typewriter',
    label: 'Typewriter',
    icon: 'article',
    desc: 'Vintage key rattle',
    play(ctx, vol) {
      if (!ctx) return;
      const t = ctx.currentTime;
      // Main strike.
      const buf = makeBuf(ctx, 0.035, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          const x = i / sr;
          d[i] =
            noise() * Math.exp(-x * 350) +
            Math.sin(2 * Math.PI * 280 * x) * Math.exp(-x * 500) * 0.5;
        }
      });
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol * 1.6, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
      playSynthBuffer(ctx, buf, filt(ctx, 'highpass', 1500), g, t, t + 0.035);

      // Rattle tail.
      const buf2 = makeBuf(ctx, 0.02, (d, sr) => {
        for (let i = 0; i < d.length; i++) {
          d[i] = noise() * Math.exp(-(i / sr) * 500);
        }
      });
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(vol * 0.5, t + 0.018);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.038);
      playSynthBuffer(ctx, buf2, filt(ctx, 'highpass', 2500), g2, t + 0.018, t + 0.04);
    },
  },

  off: {
    id: 'off',
    label: 'Off',
    icon: 'volume_off',
    desc: 'No sound',
    play() {
      // Intentionally silent.
    },
  },
};
