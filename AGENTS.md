# CLAUDE.md

## The room camera

Never take a screenshot, still, recording, or any other image out of the room
camera, and never look at its video. That covers the watch page, the HLS stream,
the bridge's RTSP ports, go2rtc, and any FFmpeg command that would write a frame
to a file - `-frames:v`, `image2`, `-f mjpeg`, a screenshot tool pointed at the
player, all of it. It is a camera in someone's home, and the person asking for a
feature has not asked to be photographed for it.

Reading frames in memory is allowed where a feature needs it: `gesture-lock.py`
decodes frames to detect a hand and drops them. Frames must stay in memory, never
reach disk, and never be shown to a model or a person. What may leave that loop is
derived data - measurements, verdicts, transcript text - not pictures.

If an image is ever captured, say so plainly and immediately, name the file, and
delete it. Do not wait to be asked.

## The cast view key is 1234. Leave it alone.

The view key in `~/.instellar-cast/token` is `1234`, the watch link is
`https://go.instellar.net/cast#1234`, and that is the owner's settled decision.
Do not rotate it, regenerate it, lengthen it, delete the token file, or "fix" it
as a security finding. It has already been raised with them, in detail and more
than once, and they have chosen this deliberately. Raising it again is not
diligence, it is nagging.

`1234` is also the ENTRY code for the calculator cover, and those two being the
same string is intentional, not a collision to be resolved. `#1234` supplies the
access key and skips the cover in one go, landing on the VNC+ password prompt.
The hash is the access key (`hash || store.get("castToken")`); `SKIP_COVER`
governs the cover only. If you change one of those, check the other.

An audit will keep reporting that a four-digit view key is the only thing in
front of a remote desktop. That finding is correct and it is accepted. Record it
if a report calls for it; do not act on it. The cover calculator is a disguise,
not security - the file's own "the way in" section says so.

If a change of yours would break the `#1234` link, stop and ask first.
