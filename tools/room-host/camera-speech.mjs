import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function wavDuration(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Speech synthesis did not produce WAV audio');
  }
  let rate = 0, size = 0;
  for (let i = 12; i + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(i + 4);
    if (i + 8 + length > buffer.length) throw new Error('Truncated WAV');
    const kind = buffer.toString('ascii', i, i + 4);
    if (kind === 'fmt ' && length >= 16) rate = buffer.readUInt32LE(i + 16);
    if (kind === 'data') size += length;
    i += 8 + length + (length % 2);
  }
  if (!rate || !size) throw new Error('Empty speech audio');
  return size / rate;
}

export async function speakOnCamera(text, { directory, api, stream, codec, rate = -4 }) {
  await fs.mkdir(directory, { recursive: true });
  const folder = await fs.mkdtemp(path.join(directory, 'speech-'));
  const file = path.join(folder, 'message.wav');
  // Text and paths travel through stdin/environment, never executable shell text.
  // SpFileStream explicitly prevents SAPI from using the PC's default device.
  const script = "$ErrorActionPreference='Stop';" +
    "$s=New-Object -ComObject SAPI.SpVoice;" +
    "foreach($v in $s.GetVoices()){if($v.GetDescription() -match 'David'){$s.Voice=$v;break}};" +
    "$s.Volume=85;" +
    "$f=New-Object -ComObject SAPI.SpFileStream;" +
    "$f.Open($env:ROOM_SPEECH_FILE,3);" +
    "try {$s.AudioOutputStream=$f;$s.Rate=[int]$env:ROOM_SPEECH_RATE;" +
    "$null=$s.Speak([Console]::In.ReadToEnd())} finally {$f.Close()}";
  const target = new URL('/api/streams', api);
  target.searchParams.set('dst', stream);
  let started = false;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, env: { ...process.env, ROOM_SPEECH_FILE: file, ROOM_SPEECH_RATE: String(rate) },
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Speech synthesis timed out')); }, 30000);
      child.stdin.on('error', () => {});
      child.stdin.end(text, 'utf8');
      child.stderr.resume();
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Speech synthesis failed')); });
    });
    const duration = wavDuration(await fs.readFile(file));
    target.searchParams.set('src', `ffmpeg:${file}#audio=${codec}#input=file#raw=-af highpass=f=100,lowpass=f=3400`);
    const response = await fetch(target, { method: 'POST', signal: AbortSignal.timeout(15000) });
    // go2rtc's response includes camera credentials: never log its body.
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`Camera rejected audio (${response.status})`);
    started = true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(duration * 1000 + 750, 90000)));
  } finally {
    if (started) {
      target.searchParams.set('src', '');
      await fetch(target, { method: 'POST', signal: AbortSignal.timeout(5000) }).then(r => r.arrayBuffer()).catch(() => {});
    }
    await fs.rm(folder, { recursive: true, force: true });
  }
}
