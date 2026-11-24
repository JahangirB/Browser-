#!/usr/bin/env python3
"""
X11 input + clipboard helper for the RBI server.

Reads one JSON command per line on stdin and injects real X11 input events
through the XTEST extension (the same path a physical keyboard/mouse takes),
so every popup Chromium draws (dropdowns, dialogs, context menus) works too.

Commands:
  {"t":"mm","x":10,"y":20}                    mouse move
  {"t":"md","x":10,"y":20,"b":1}              mouse button down (1 left, 2 middle, 3 right)
  {"t":"mu","x":10,"y":20,"b":1}              mouse button up
  {"t":"wh","x":10,"y":20,"dx":0,"dy":120}    wheel (pixels, accumulated into notches)
  {"t":"kd","key":"a","code":"KeyA"}          key down (key = KeyboardEvent.key)
  {"t":"ku","code":"KeyA"}                    key up
  {"t":"combo","keys":["Control_L","c"]}      press + release a shortcut
  {"t":"reset"}                               release every held key/button
  {"t":"clip"}                                read the CLIPBOARD selection

Writes JSON lines on stdout:
  {"t":"miss","text":"é"}   character has no keycode in the X keymap (server types it via CDP)
  {"t":"clip","text":"..."} clipboard contents
"""
import json
import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest

WHEEL_STEP = 60  # pixels of browser wheel delta per X wheel notch

SPECIAL = {
    "Enter": "Return", "Backspace": "BackSpace", "Tab": "Tab", "Escape": "Escape",
    "Delete": "Delete", "Insert": "Insert", "Home": "Home", "End": "End",
    "PageUp": "Prior", "PageDown": "Next",
    "ArrowLeft": "Left", "ArrowRight": "Right", "ArrowUp": "Up", "ArrowDown": "Down",
    "Shift": "Shift_L", "Control": "Control_L", "Alt": "Alt_L", "AltGraph": "ISO_Level3_Shift",
    "Meta": "Super_L", "CapsLock": "Caps_Lock", "ContextMenu": "Menu",
    " ": "space", "Spacebar": "space",
}
for _i in range(1, 13):
    SPECIAL["F%d" % _i] = "F%d" % _i

d = display.Display()
root = d.screen().root
clip_win = root.create_window(0, 0, 1, 1, 0, X.CopyFromParent)
A_CLIPBOARD = d.intern_atom("CLIPBOARD")
A_UTF8 = d.intern_atom("UTF8_STRING")
A_PROP = d.intern_atom("RBI_CLIP")
SHIFT_KC = d.keysym_to_keycode(XK.string_to_keysym("Shift_L"))

pressed = {}        # client key code -> list of X keycodes we pressed for it
buttons_down = set()
wheel_acc = {"x": 0.0, "y": 0.0}
shift_down = False


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def keysym_for(key):
    if key in SPECIAL:
        return XK.string_to_keysym(SPECIAL[key])
    if len(key) == 1:
        cp = ord(key)
        # Latin-1 keysyms equal their code point; everything else is 0x01000000 + cp
        return cp if cp < 0x100 else 0x01000000 + cp
    return XK.string_to_keysym(key) or 0


def keycode_and_level(keysym):
    """Return (keycode, needs_shift) for a keysym, or (0, False) if unmapped."""
    for kc, index in d.keysym_to_keycodes(keysym):
        if index in (0, 1):
            return kc, index == 1
    return 0, False


def move(x, y):
    xtest.fake_input(d, X.MotionNotify, x=int(x), y=int(y))


def key_down(key, code):
    global shift_down
    ks = keysym_for(key)
    if not ks:
        return
    kc, needs_shift = keycode_and_level(ks)
    if not kc:
        if len(key) == 1:
            out({"t": "miss", "text": key})
        return
    seq = []
    if needs_shift and not shift_down:
        seq.append(SHIFT_KC)  # e.g. CapsLock produced "A" without a Shift press
    seq.append(kc)
    for k in seq:
        xtest.fake_input(d, X.KeyPress, k)
    pressed[code] = seq
    if key == "Shift":
        shift_down = True


def key_up(code):
    global shift_down
    seq = pressed.pop(code, None)
    if not seq:
        return
    for k in reversed(seq):
        xtest.fake_input(d, X.KeyRelease, k)
    if code in ("ShiftLeft", "ShiftRight"):
        shift_down = False


def reset():
    global shift_down
    for code in list(pressed):
        key_up(code)
    for b in list(buttons_down):
        xtest.fake_input(d, X.ButtonRelease, b)
    buttons_down.clear()
    shift_down = False


def wheel(dx, dy):
    wheel_acc["x"] += dx
    wheel_acc["y"] += dy
    for axis, neg, pos in (("y", 4, 5), ("x", 6, 7)):
        while abs(wheel_acc[axis]) >= WHEEL_STEP:
            b = pos if wheel_acc[axis] > 0 else neg
            xtest.fake_input(d, X.ButtonPress, b)
            xtest.fake_input(d, X.ButtonRelease, b)
            wheel_acc[axis] -= WHEEL_STEP if wheel_acc[axis] > 0 else -WHEEL_STEP


def combo(names):
    codes = [d.keysym_to_keycode(XK.string_to_keysym(n)) for n in names]
    codes = [c for c in codes if c]
    for c in codes:
        xtest.fake_input(d, X.KeyPress, c)
    for c in reversed(codes):
        xtest.fake_input(d, X.KeyRelease, c)


def read_clipboard():
    clip_win.convert_selection(A_CLIPBOARD, A_UTF8, A_PROP, X.CurrentTime)
    d.flush()
    deadline = time.time() + 1.5
    while time.time() < deadline:
        while d.pending_events():
            ev = d.next_event()
            if ev.type == X.SelectionNotify:
                if ev.property == X.NONE:
                    return ""
                prop = clip_win.get_full_property(A_PROP, X.AnyPropertyType)
                if not prop:
                    return ""
                val = prop.value
                if isinstance(val, bytes):
                    return val.decode("utf-8", "replace")
                return str(val)
        time.sleep(0.02)
    return ""


def handle(m):
    t = m.get("t")
    if t == "mm":
        move(m["x"], m["y"])
    elif t in ("md", "mu"):
        b = int(m.get("b", 1))
        if b not in (1, 2, 3):
            return
        move(m["x"], m["y"])
        if t == "md":
            xtest.fake_input(d, X.ButtonPress, b)
            buttons_down.add(b)
        else:
            xtest.fake_input(d, X.ButtonRelease, b)
            buttons_down.discard(b)
    elif t == "wh":
        move(m["x"], m["y"])
        wheel(float(m.get("dx", 0)), float(m.get("dy", 0)))
    elif t == "kd":
        key_down(str(m.get("key", "")), str(m.get("code", "")))
    elif t == "ku":
        key_up(str(m.get("code", "")))
    elif t == "combo":
        combo(m.get("keys", []))
    elif t == "reset":
        reset()
    elif t == "clip":
        out({"t": "clip", "text": read_clipboard()})
    d.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        handle(json.loads(line))
    except Exception as e:  # never die on one bad event
        sys.stderr.write("input.py error: %r\n" % (e,))
        sys.stderr.flush()
