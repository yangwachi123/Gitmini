#!/usr/bin/env python3
"""Generate the built-in alert sounds (WAV) for the extension.

Pure Python stdlib (wave/math/struct) and fully deterministic, so CI can
regenerate and byte-compare against the checked-in assets with --check.

Usage:
    python3 tools/generate_sounds.py           # write assets/sounds/*.wav
    python3 tools/generate_sounds.py --check   # verify checked-in files match
"""

import math
import struct
import sys
import wave
from pathlib import Path

SAMPLE_RATE = 22050
OUT_DIR = Path(__file__).resolve().parent.parent / "assets" / "sounds"


def silence(seconds):
    return [0.0] * int(SAMPLE_RATE * seconds)


def tone(freq, seconds, *, volume=0.8, harmonic3=0.0, attack=0.005, decay=None):
    """A sine tone with a short attack and exponential decay envelope.

    harmonic3 adds a third harmonic (square-ish timbre) at the given relative
    amplitude. decay is the exponential half-life in seconds (None = sustain).
    """
    n = int(SAMPLE_RATE * seconds)
    attack_n = max(1, int(SAMPLE_RATE * attack))
    samples = []
    for i in range(n):
        t = i / SAMPLE_RATE
        s = math.sin(2 * math.pi * freq * t)
        if harmonic3:
            s += harmonic3 * math.sin(2 * math.pi * freq * 3 * t)
            s /= 1 + harmonic3
        env = min(1.0, i / attack_n)
        if decay is not None:
            env *= 0.5 ** (t / decay)
        samples.append(volume * env * s)
    return samples


def overlay(base, addition, offset_seconds):
    """Mix `addition` into `base` starting at offset_seconds, extending base."""
    offset = int(SAMPLE_RATE * offset_seconds)
    end = offset + len(addition)
    if end > len(base):
        base = base + [0.0] * (end - len(base))
    for i, s in enumerate(addition):
        base[offset + i] += s
    return base


def build_beep():
    """Three 880 Hz beeps, 150 ms each with 100 ms gaps."""
    out = []
    for i in range(3):
        out += tone(880, 0.15, volume=0.75, decay=0.4)
        if i < 2:
            out += silence(0.10)
    out += silence(0.10)
    return out


def build_chime():
    """Ascending arpeggio C5-E5-G5-C6 with overlapping decay tails."""
    out = []
    for i, freq in enumerate([523.25, 659.25, 783.99, 1046.50]):
        out = overlay(out, tone(freq, 0.55, volume=0.55, decay=0.18), i * 0.2)
    out += silence(0.1)
    return out


def build_alarm():
    """Urgent alternating 700/900 Hz with a square-ish 3rd harmonic."""
    out = []
    for i in range(4):
        freq = 700 if i % 2 == 0 else 900
        out += tone(freq, 0.25, volume=0.7, harmonic3=0.33)
    out += silence(0.1)
    return out


def build_ding():
    """Single E6 strike with a quiet octave overtone, long decay."""
    out = tone(1318.51, 0.8, volume=0.7, decay=0.22)
    out = overlay(out, tone(2637.02, 0.5, volume=0.18, decay=0.12), 0.0)
    out += silence(0.1)
    return out


SOUNDS = {
    "beep.wav": build_beep,
    "chime.wav": build_chime,
    "alarm.wav": build_alarm,
    "ding.wav": build_ding,
}


def render(samples):
    frames = bytearray()
    for s in samples:
        clamped = max(-1.0, min(1.0, s))
        frames += struct.pack("<h", int(clamped * 32767))
    return bytes(frames)


def wav_bytes(samples):
    import io

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(render(samples))
    return buf.getvalue()


def main():
    check = "--check" in sys.argv
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    failures = []
    for name, builder in SOUNDS.items():
        data = wav_bytes(builder())
        path = OUT_DIR / name
        if check:
            if not path.exists() or path.read_bytes() != data:
                failures.append(name)
            continue
        path.write_bytes(data)
        print(f"wrote {path} ({len(data)} bytes)")
    if check:
        if failures:
            print(f"MISMATCH: {', '.join(failures)} — rerun tools/generate_sounds.py")
            sys.exit(1)
        print("sounds OK")


if __name__ == "__main__":
    main()
