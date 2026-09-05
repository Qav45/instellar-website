"""Configure native talkback from the running bridge's local camera cache."""
import json
import pathlib
import subprocess
import urllib.parse

root = pathlib.Path(__file__).resolve().parent
runtime = root / '.runtime'
runtime.mkdir(exist_ok=True)
camera = json.loads(subprocess.check_output([
    'docker', 'exec', 'room-wyze-bridge', 'python', '-c',
    'import pickle,json; c=pickle.load(open("/tokens/cameras.pickle","rb")); '
    'print(json.dumps([x.dict() for x in c]))',
], text=True))
settings = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines()
                if '=' in line and not line.lstrip().startswith('#'))
name = settings.get('CAM_NAME', '').replace('-', ' ').lower()
matches = [c for c in camera if c['nickname'].lower() == name]
if len(matches) != 1:
    raise SystemExit('CAM_NAME must identify exactly one camera in the bridge cache')
cam = matches[0]
# Older firmware uses a different port from go2rtc's default. Read only UDP
# headers of the already authorized camera's active bridge stream.
probe = '''import socket,time,struct,json,collections
s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(3));s.settimeout(1)
end=time.time()+3;counts=collections.Counter()
while time.time()<end:
 try: b=s.recv(65535)
 except TimeoutError: continue
 if len(b)<42 or b[12:14]!=b'\\x08\\x00' or b[23]!=17: continue
 if socket.inet_ntoa(b[26:30])!=CAM_IP: continue
 offset=14+(b[14]&15)*4
 counts[struct.unpack('!H',b[offset:offset+2])[0]]+=1
print(json.dumps(counts.most_common(1)))
'''.replace('CAM_IP', repr(cam['ip']))
ports = json.loads(subprocess.check_output([
    'docker', 'exec', 'room-wyze-bridge', 'python', '-c', probe,
], text=True))
if not ports:
    raise SystemExit('No active camera packets. Open the watch page, then retry.')
port = ports[0][0]
source = f"wyze://{cam['ip']}:{port}?" + urllib.parse.urlencode({
    'uid': cam['p2p_id'], 'enr': cam['enr'], 'mac': cam['mac'],
    'model': cam['product_model'], 'dtls': 'true',
})
ff = next(pathlib.Path.home().glob('AppData/Local/Microsoft/WinGet/Packages/*FFmpeg*/*/bin/ffmpeg.exe'), None)
config = {
    'api': {'listen': '127.0.0.1:1984'}, 'rtsp': {'listen': '127.0.0.1:8556'},
    'webrtc': {'listen': ''}, 'streams': {'camera': source},
    'ffmpeg': {'bin': str(ff) if ff else 'ffmpeg'},
}
(runtime / 'go2rtc.yaml').write_text(json.dumps(config, indent=2))
print(f"Configured {cam['nickname']} on UDP port {port}; restart room-host/go2rtc to apply.")
