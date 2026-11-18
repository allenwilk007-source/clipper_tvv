"""Where the streamer's webcam is in a clip, for the camera-on-top layout.

    python src/facecam.py <video> [model]

Prints one line of JSON:
    {"found": true, "x", "y", "w", "h", "frameW", "frameH", "seen", "frames"}
or  {"found": false, "reason": "..."}

A webcam overlay is a face that stays in the same place for the whole clip.
That is what separates it from the faces the game draws, which move with the
camera and come and go with cutscenes. So faces are found on frames spread
across the clip, grouped by position, and only a group present in most frames
and barely moving counts. Its box is then grown from the face to the head and
shoulders a webcam frames, and clamped to the picture.

Uses OpenCV's YuNet detector (models/face_detection_yunet_2023mar.onnx). If
it is missing or nothing qualifies, the answer is "not found" and the short
keeps its ordinary layout — never a guessed crop of random gameplay.
"""

import json
import os
import sys

SAMPLES = 12
MIN_SCORE = 0.75
# A webcam is in most of the clip. Game faces are not.
MIN_PRESENCE = 0.6
# How far a webcam face may wander, as a fraction of the frame width.
MAX_DRIFT = 0.05


def tight_box(scx, scy, sfw, sfh, cols, rows):
    """Head and shoulders, centred on the face, 4:3. Small enough to stay
    inside nearly any webcam overlay, so it never shows the game around it."""
    w = min(cols, sfw * 2.6)
    h = min(rows, max(w * 0.75, sfh * 2.2))
    left = max(0.0, min(scx - w / 2, cols - w))
    top = max(0.0, min(scy - h * 0.45, rows - h))
    return left, top, left + w, top + h


def overlay_bounds(cv2, grays, scale, cx, cy, fw, fh, width, height):
    """The webcam overlay's own rectangle, from how little it changes.

    Growing a box from the face alone gets the size wrong — overlays measured
    three to seven face-widths across — and looking for the overlay's border
    fails too, because the room behind a streamer is just as still as the
    border, so its edges stop the search inside the overlay. What does tell
    them apart is change over time: across thirty seconds the game moves and
    the webcam's room does not. So the overlay is the still region around the
    face. When the whole picture is still (a menu, a held shot) that says
    nothing, and the answer is a tight head-and-shoulders crop instead —
    smaller than the overlay, but never spilling into the game. Everything is
    in the 640-wide sample's pixels until the very end.
    """
    import numpy as np

    stack = np.stack([g.astype(np.float32) for g in grays])
    spread = stack.std(axis=0)
    rows, cols = spread.shape
    scx, scy, sfw, sfh = cx * scale, cy * scale, fw * scale, fh * scale
    fallback = tight_box(scx, scy, sfw, sfh, cols, rows)

    calm = (spread < 14).astype(np.uint8)
    if calm.mean() > 0.6:
        left, top, right, bottom = fallback
        return left / scale, top / scale, right / scale, bottom / scale

    # The streamer moves; count their face (and a margin) as part of the calm.
    fx0, fx1 = int(max(0, scx - sfw * 0.8)), int(min(cols, scx + sfw * 0.8))
    fy0, fy1 = int(max(0, scy - sfh * 0.9)), int(min(rows, scy + sfh * 1.4))
    calm[fy0:fy1, fx0:fx1] = 1
    calm = cv2.morphologyEx(calm, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    calm = cv2.morphologyEx(calm, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    _, labels, stats, _ = cv2.connectedComponentsWithStats(calm, connectivity=4)
    label = labels[int(min(rows - 1, scy)), int(min(cols - 1, scx))]
    x, y, w, h, area = (int(v) for v in stats[label])

    # Overlay-sized: bigger than the head, a small part of the picture, and
    # shaped like a webcam rather than a strip of HUD.
    plausible = (
        label != 0
        and w >= sfw * 2
        and h >= sfh * 1.8
        and w * h <= rows * cols * 0.2
        and 0.6 <= w / max(h, 1) <= 2.4
    )
    left, top, right, bottom = (x, y, x + w, y + h) if plausible else fallback
    return left / scale, top / scale, right / scale, bottom / scale


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"found": False, "reason": "usage: facecam.py <video> [model]"}))
        return 0
    path = sys.argv[1]
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    model = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, "models", "face_detection_yunet_2023mar.onnx")

    try:
        import cv2
    except ImportError:
        print(json.dumps({"found": False, "reason": "OpenCV is not installed"}))
        return 0
    if not os.path.exists(model):
        print(json.dumps({"found": False, "reason": f"face model missing: {model}"}))
        return 0

    capture = cv2.VideoCapture(path)
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if total <= 0 or width <= 0 or height <= 0:
        print(json.dumps({"found": False, "reason": "could not read the video"}))
        return 0

    # Detection runs on a 640-wide copy: plenty for a webcam, and fast.
    scale = 640 / width
    small = (640, max(1, int(round(height * scale))))
    detector = cv2.FaceDetectorYN.create(model, "", small, MIN_SCORE, 0.3, 50)

    faces_per_frame = []
    grays = []
    for i in range(SAMPLES):
        capture.set(cv2.CAP_PROP_POS_FRAMES, int((i + 0.5) * total / SAMPLES))
        ok, frame = capture.read()
        if not ok:
            continue
        resized = cv2.resize(frame, small)
        grays.append(cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY))
        _, found = detector.detect(resized)
        boxes = []
        for face in found if found is not None else []:
            x, y, w, h = (float(v) / scale for v in face[:4])
            boxes.append((x, y, w, h, float(face[-1])))
        faces_per_frame.append(boxes)
    capture.release()

    frames = len(faces_per_frame)
    if not frames:
        print(json.dumps({"found": False, "reason": "no frames read"}))
        return 0

    # Group faces by where they are.
    groups = []
    for boxes in faces_per_frame:
        for box in boxes:
            cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
            for group in groups:
                gx, gy = group["cx"], group["cy"]
                if abs(cx - gx) < width * MAX_DRIFT and abs(cy - gy) < width * MAX_DRIFT:
                    group["boxes"].append(box)
                    n = len(group["boxes"])
                    group["cx"] += (cx - gx) / n
                    group["cy"] += (cy - gy) / n
                    break
            else:
                groups.append({"cx": cx, "cy": cy, "boxes": [box]})

    best = None
    for group in groups:
        presence = len(group["boxes"]) / frames
        if presence < MIN_PRESENCE:
            continue
        if best is None or presence > best[0] or (presence == best[0] and len(group["boxes"]) > len(best[1]["boxes"])):
            best = (presence, group)
    if best is None:
        print(json.dumps({"found": False, "reason": "no face stays in one place long enough to be a webcam", "frames": frames}))
        return 0

    presence, group = best
    boxes = group["boxes"]
    fw = sorted(b[2] for b in boxes)[len(boxes) // 2]
    fh = sorted(b[3] for b in boxes)[len(boxes) // 2]
    cx, cy = group["cx"], group["cy"]

    # A face that fills a large part of the picture is a full-screen camera
    # (a "just chatting" shot), not an overlay: there is no gameplay to stack.
    if fw > width * 0.22:
        print(json.dumps({"found": False, "reason": "the camera is the whole picture", "frames": frames}))
        return 0

    # Webcam overlays sit toward the sides, or the top or bottom; the middle
    # of the picture is the game. Measured: seven real webcams all had their
    # centre in the outer 30% left or right, while the one false hit — a GTA
    # character standing still in a shop conversation — was dead centre.
    toward_side = cx < width * 0.3 or cx > width * 0.7
    toward_edge = cy < height * 0.25 or cy > height * 0.75
    if not (toward_side or toward_edge):
        print(json.dumps({"found": False, "reason": "the steady face is mid-picture: a game character, not a webcam", "frames": frames}))
        return 0

    left, top, right, bottom = overlay_bounds(cv2, grays, scale, cx, cy, fw, fh, width, height)
    x, y, w, h = left, top, right - left, bottom - top

    even = lambda v: int(v) // 2 * 2  # noqa: E731 - ffmpeg crops on even numbers
    print(
        json.dumps(
            {
                "found": True,
                "x": even(x),
                "y": even(y),
                "w": even(w),
                "h": even(h),
                "frameW": width,
                "frameH": height,
                "seen": round(presence, 2),
                "frames": frames,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
