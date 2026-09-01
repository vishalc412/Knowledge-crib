#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const output = process.argv[2];
if (!output) throw new Error('Usage: node soundtrack.mjs output.wav');
const rate = 48_000;
const seconds = 30;
const samples = rate * seconds;
const bpm = 132;
const beatSeconds = 60 / bpm;
const pcm = Buffer.alloc(samples * 4);
const clamp = (n) => Math.max(-1, Math.min(1, n));
const noise = (n) => {
  const value = Math.sin(n * 12.9898) * 43_758.5453;
  return (value - Math.floor(value)) * 2 - 1;
};

for (let i = 0; i < samples; i += 1) {
  const t = i / rate;
  const beat = t / beatSeconds;
  const withinBeat = beat - Math.floor(beat);
  const wholeBeat = Math.floor(beat);
  const barBeat = wholeBeat % 16;
  const bassHz = [55, 55, 61.74, 65.41, 73.42, 65.41, 61.74, 55][Math.floor(beat / 2) % 8];
  const kick = Math.sin(2 * Math.PI * (128 - 94 * Math.min(1, withinBeat * 17)) * t) * Math.exp(-withinBeat * 18) * .48;
  const bassEnvelope = Math.exp(-withinBeat * 3.8);
  const bass = (Math.sin(2 * Math.PI * bassHz * t) + Math.sin(2 * Math.PI * bassHz * 2 * t) * .22) * bassEnvelope * .17;
  const sixteenth = beat * 4;
  const arpPosition = sixteenth - Math.floor(sixteenth);
  const arpHz = [220, 261.63, 293.66, 329.63, 392, 329.63, 293.66, 261.63][Math.floor(sixteenth) % 8];
  const arp = Math.sin(2 * Math.PI * arpHz * t) * Math.exp(-arpPosition * 11) * .055;
  const offbeatPosition = (withinBeat + .5) % 1;
  const offbeatHat = noise(i) * Math.exp(-offbeatPosition * 42) * .037;
  const sixteenthPosition = (beat * 4) - Math.floor(beat * 4);
  const closedHat = noise(i + 37) * Math.exp(-sixteenthPosition * 72) * .011;
  const isBackbeat = wholeBeat % 4 === 1 || wholeBeat % 4 === 3;
  const clap = isBackbeat ? (noise(i + 83) * .65 + Math.sin(2 * Math.PI * 180 * t) * .35) * Math.exp(-withinBeat * 29) * .105 : 0;
  const transition = (t % 4) / 4;
  const riser = transition > .72 ? noise(i + 191) * (transition - .72) * .05 : 0;
  const pulse = Math.sin(2 * Math.PI * .25 * t) * .016;
  const sample = clamp(kick + bass + arp + offbeatHat + closedHat + clap + riser + pulse);
  const left = clamp(sample * (0.92 + Math.sin(t * .67) * .08));
  const right = clamp(sample * (0.92 - Math.sin(t * .67) * .08));
  pcm.writeInt16LE(Math.round(left * 32767), i * 4);
  pcm.writeInt16LE(Math.round(right * 32767), i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
writeFileSync(output, Buffer.concat([header, pcm]));
