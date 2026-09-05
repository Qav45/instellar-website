"""Local camera transcription. JSON lines on stdout, diagnostics on stderr."""
import argparse
import json
import queue
import subprocess
import sys
import threading
import time

import numpy as np
from faster_whisper import WhisperModel


def emit(**event):
    print(json.dumps(event), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--rtsp', required=True)
    parser.add_argument('--model', default='base.en')
    args = parser.parse_args()
    model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=4)
    # Keep capture moving while inference runs; never accumulate minutes of audio.
    blocks = queue.Queue(maxsize=2)
    child = subprocess.Popen([
        args.ffmpeg, '-nostdin', '-loglevel', 'error', '-rtsp_transport', 'tcp',
        '-timeout', '15000000', '-i', args.rtsp, '-vn', '-ac', '1', '-ar', '16000',
        '-f', 's16le', '-',
    ], stdout=subprocess.PIPE, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))

    def capture():
        offset = 0
        while True:
            data = child.stdout.read(16000 * 2 * 2)
            if not data:
                break
            if blocks.full():
                try:
                    blocks.get_nowait()
                except queue.Empty:
                    pass
            blocks.put((offset, data))
            offset += len(data) / 32000
        blocks.put(None)

    threading.Thread(target=capture, daemon=True).start()
    previous = np.zeros(0, dtype=np.float32)
    previous_end = 0
    delivered_end = 0
    try:
        while True:
            item = blocks.get(timeout=30)
            if item is None:
                raise RuntimeError('camera audio disconnected')
            offset, data = item
            current = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768
            if offset != previous_end:
                previous = np.zeros(0, dtype=np.float32)
            audio = np.concatenate((previous, current))
            start = offset - len(previous) / 16000
            emit(status='listening')
            segments, _ = model.transcribe(
                audio, language='en', beam_size=1, vad_filter=True,
                vad_parameters={'min_silence_duration_ms': 400},
                condition_on_previous_text=False, word_timestamps=True,
            )
            words = []
            for segment in segments:
                if segment.no_speech_prob > 0.6:
                    continue
                for word in segment.words or []:
                    end = start + word.end
                    if end > delivered_end + 0.1:
                        words.append(word.word)
                        delivered_end = end
            text = ''.join(words).strip()
            if text:
                emit(text=text)
            previous = current[-16000:]
            previous_end = offset + len(current) / 16000
    finally:
        child.kill()
        child.wait()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
