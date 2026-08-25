#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const work = join(here, 'work');
const out = join(root, 'dist', 'media');
const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const html = join(here, 'knowledge-crib-teaser.html');
const sceneCount = 7;
const fade = 0.45;
const duration = (30 + fade * (sceneCount - 1)) / sceneCount;
const frames = Math.ceil(duration * 30);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

function capture(scene) {
  return new Promise((resolve, reject) => {
    const target = join(work, `scene-${scene}.png`);
    const profile = join(work, 'chrome-profiles', `scene-${scene}`);
    rmSync(target, { force: true });
    const child = spawn(chrome, [
      '--headless', '--hide-scrollbars', '--disable-gpu', '--force-device-scale-factor=1',
      '--window-size=1920,1080', '--allow-file-access-from-files', '--no-first-run',
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--no-default-browser-check', '--disable-features=OptimizationGuideModelDownloading,MediaRouter',
      `--user-data-dir=${profile}`, `--screenshot=${target}`,
      `${new URL(`file://${html.replaceAll(' ', '%20')}`).href}?scene=${scene}`,
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    const stop = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* capture process already exited */ }
    };
    const started = Date.now();
    const check = () => {
      if (existsSync(target) && statSync(target).size > 1_000) {
        stop();
        resolve();
        return;
      }
      if (Date.now() - started > 20_000) {
        stop();
        reject(new Error(`Timed out capturing scene ${scene}`));
        return;
      }
      setTimeout(check, 100);
    };
    child.once('error', reject);
    check();
  });
}

if (!existsSync(chrome)) throw new Error(`Chrome not found: ${chrome}`);
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });
rmSync(join(work, 'chrome-profiles'), { recursive: true, force: true });

for (let scene = 1; scene <= sceneCount; scene += 1) {
  console.log(`Capture scene ${scene}/${sceneCount}`);
  await capture(scene);
}

console.log('Generate original audio bed');
run(process.execPath, [join(here, 'soundtrack.mjs'), join(work, 'knowledge-crib-bed.wav')]);

const inputArgs = [];
for (let scene = 1; scene <= sceneCount; scene += 1) inputArgs.push('-loop', '1', '-framerate', '30', '-t', String(duration), '-i', join(work, `scene-${scene}.png`));
const filters = [];
for (let scene = 0; scene < sceneCount; scene += 1) {
  const direction = scene % 2 === 0 ? '1.035' : '1.02';
  filters.push(`[${scene}:v]scale=1920:1080,setsar=1,zoompan=z='min(zoom+0.00045,${direction})':d=${frames}:s=1920x1080:fps=30,format=yuv420p[v${scene}]`);
}
let previous = '[v0]';
for (let scene = 1; scene < sceneCount; scene += 1) {
  const label = scene === sceneCount - 1 ? 'vout' : `x${scene}`;
  const offset = ((duration - fade) * scene).toFixed(3);
  filters.push(`${previous}[v${scene}]xfade=transition=fade:duration=${fade}:offset=${offset}[${label}]`);
  previous = `[${label}]`;
}
const target = join(out, 'knowledge-crib-teaser-30s.mp4');
console.log('Compose 30-second MP4');
run(ffmpeg, [
  '-y', ...inputArgs, '-i', join(work, 'knowledge-crib-bed.wav'), '-filter_complex', filters.join(';'),
  '-map', '[vout]', '-map', `${sceneCount}:a`, '-t', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
  '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', target,
]);

run(ffmpeg, ['-y', '-ss', '00:00:23', '-i', target, '-frames:v', '1', join(out, 'knowledge-crib-teaser-thumbnail.png')]);
console.log(`Created ${target}`);
