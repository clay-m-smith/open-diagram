"""Exercise diagram-only clipboard/save actions in an isolated native TUI PTY."""
import errno
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time
import xml.etree.ElementTree as ET
import zlib
from terminal_screen import TerminalScreen

project, session = sys.argv[1:3]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 55, 170, 0, 0))
clipboard_path = os.path.join(project, "native-clipboard.svg")
clipboard_png = os.path.join(project, "native-clipboard.png")
allow_png = os.path.join(project, "allow-image-clipboard")
bin_path = os.path.join(project, "clipboard-fixture")
os.mkdir(bin_path)
with open(os.path.join(bin_path, "xclip"), "w") as fixture:
    fixture.write(f'''#!{sys.executable}
import sys, os
args = sys.argv[1:]
if args == ["-selection", "clipboard", "-out", "-target", "TARGETS"]:
    print("TARGETS\\nimage/svg+xml\\nimage/png")
    sys.exit(0)
if args == ["-selection", "clipboard", "-t", "image/svg+xml", "-i"]:
    path = {clipboard_path!r}
elif args == ["-selection", "clipboard", "-t", "image/png", "-i"] and os.path.exists({allow_png!r}):
    path = {clipboard_png!r}
else:
    sys.exit(1)
with open(path, "wb") as target:
    target.write(sys.stdin.buffer.read())
''')
os.chmod(os.path.join(bin_path, "xclip"), 0o700)
env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", SSH_TTY="/fixture/forwarded",
           DISPLAY="localhost:99.0", PATH=bin_path + os.pathsep + os.environ["PATH"])
env.pop("WAYLAND_DISPLAY", None)
child = subprocess.Popen(["opencode", project, "--session", session], stdin=slave, stdout=slave, stderr=slave,
                         cwd=project, env=env, start_new_session=True)
os.close(slave)
screen = TerminalScreen(170, 55)
output = bytearray()
stage = 0
png_path = os.path.join(project, "native-diagram.png")
svg_path = os.path.join(project, "native-diagram.svg")

def click(label):
    x, y = screen.find(label)
    os.write(master, f"\x1b[<0;{x + 2};{y + 1}M\x1b[<0;{x + 2};{y + 1}m".encode())

def export_idle():
    position = screen.find("[Save]")
    return position and "…" not in "".join(screen.rows[position[1]][position[0]:])

def stop_child():
    child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=3)

def check_svg(data, mode="dark"):
    root = ET.fromstring(data)
    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    text = " ".join(root.itertext())
    assert "Embedding" in text and "GELU" in text
    assert all(chrome not in text for chrome in ["[PNG]", "[SVG]", "[Save]", "[Theme:", "[Refresh]", "[Pause]", "[Sources]", "stale"])
    background = root.find("{http://www.w3.org/2000/svg}rect")
    assert background.attrib["fill"] == ("#111827" if mode == "dark" else "#ffffff"), "Export must honor resolved color mode"

def check_png(png):
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", png[16:24])[0] == 960
    assert png[24] == 8 and png[25] in (2, 6), "8-bit RGB/RGBA output"
    offset, compressed = 8, bytearray()
    while offset < len(png):
        length = struct.unpack(">I", png[offset:offset + 4])[0]
        if png[offset + 4:offset + 8] == b"IDAT":
            compressed.extend(png[offset + 8:offset + 8 + length])
        offset += length + 12
    # Every PNG filter predicts zero for the first pixel of the first row.
    assert zlib.decompress(compressed)[1:4] == bytes.fromhex("111827"), "Native PNG uses system dark background"

try:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            output.extend(data)
            screen.feed(data)
            if b"\x1b[c" in data or b"\x1b[0c" in data:
                os.write(master, b"\x1b[?1;2c")
            if b"\x1b[6n" in data:
                os.write(master, b"\x1b[1;1R")
            if b"\x1b]11;?" in data:
                os.write(master, b"\x1b]11;rgb:1a1a/1b1b/2626\x07")
        if stage == 0 and all(screen.find(label) for label in ["[PNG]", "[SVG]", "[Save]", "GELU"]):
            click("[SVG]")
            stage = 1
        elif stage == 1:
            if os.path.exists(clipboard_path) and "SVG copied to image clipboard" in screen.text() and export_idle():
                with open(clipboard_path, "rb") as image:
                    check_svg(image.read())
                assert b"\x1b]52;" not in output, "SVG must not use text clipboard fallback"
                print("OK: actual native SVG action sends image/svg+xml without UI chrome or text clipboard fallback")
                click("[PNG]")
                stage = 2
        elif stage == 2 and "Save PNG diagram" in screen.text():
            os.write(master, b"\x01\x0b" + png_path.encode() + b"\r")
            stage = 3
        elif stage == 3 and os.path.exists(png_path) and export_idle() and "Saved PNG:" in screen.text() and "Save PNG diagram" not in screen.text():
            with open(png_path, "rb") as image:
                png = image.read()
            check_png(png)
            print("OK: actual native PNG action falls back to saving valid full diagram image")
            click("[Save]")
            stage = 4
        elif stage == 4 and "PNG image" in screen.text() and "SVG vector" in screen.text():
            os.write(master, b"\x1b[B\r")
            stage = 5
        elif stage == 5 and "Save SVG diagram" in screen.text():
            os.write(master, b"\x01\x0b" + svg_path.encode() + b"\r")
            stage = 6
        elif stage == 6 and os.path.exists(svg_path) and export_idle() and "Saved SVG:" in screen.text():
            with open(svg_path, "rb") as image:
                check_svg(image.read())
            print("OK: actual native Save action selects SVG and writes diagram-only artifact")
            click("[Expand]")
            stage = 7
        elif stage == 7 and "Drag divider to resize" in screen.text() and export_idle():
            os.unlink(clipboard_path)
            click("[SVG]")
            stage = 8
        elif stage == 8 and os.path.exists(clipboard_path) and export_idle() and screen.find("[Fullscreen]"):
            with open(clipboard_path, "rb") as image:
                check_svg(image.read())
            click("[Fullscreen]")
            stage = 9
        elif stage == 9 and screen.find("[Restore]") and export_idle():
            os.unlink(clipboard_path)
            click("[SVG]")
            stage = 10
        elif stage == 10 and os.path.exists(clipboard_path) and export_idle():
            with open(clipboard_path, "rb") as image:
                check_svg(image.read())
            print("OK: actual expanded and fullscreen SVG clicks export the active cached diagram")
            with open(allow_png, "w") as marker:
                marker.write("fixture")
            click("[PNG]")
            stage = 11
        elif stage == 11 and os.path.exists(clipboard_png) and export_idle() and "PNG copied to image clipboard" in screen.text():
            with open(clipboard_png, "rb") as image:
                check_png(image.read())
            print("OK: actual native PNG action sends image/png to clipboard adapter")
            click("[Theme: System]")
            stage = 12
        elif stage == 12 and "Diagram export theme" in screen.text():
            os.write(master, b"\x1b[B\x1b[B\r")
            stage = 13
        elif stage == 13 and screen.find("[Theme: Light]") and export_idle():
            # Preference write completed before export_idle. Either graceful or
            # forced exit of this owned TUI must preserve the next startup mode.
            stop_child()
            os.close(master)
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 55, 170, 0, 0))
            child = subprocess.Popen(["opencode", project, "--session", session], stdin=slave, stdout=slave, stderr=slave,
                                     cwd=project, env=env, start_new_session=True)
            os.close(slave)
            screen = TerminalScreen(170, 55)
            output.clear()
            stage = 14
        elif stage == 14 and screen.find("[Theme: Light]") and export_idle() and "GELU" in screen.text():
            os.unlink(clipboard_path)
            click("[SVG]")
            stage = 15
        elif stage == 15 and os.path.exists(clipboard_path) and export_idle():
            with open(clipboard_path, "rb") as image:
                check_svg(image.read(), "light")
            print("OK: export-only Light override persists across native TUI restart and reaches SVG")
            click("[Theme: Light]")
            stage = 16
        elif stage == 16 and "Diagram export theme" in screen.text():
            os.write(master, b"\x1b[A\x1b[A\r")
            stage = 17
        elif stage == 17 and screen.find("[Theme: System]") and export_idle():
            os.unlink(clipboard_path)
            click("[SVG]")
            stage = 18
        elif stage == 18 and os.path.exists(clipboard_path) and export_idle():
            with open(clipboard_path, "rb") as image:
                check_svg(image.read())
            print("OK: System restores current host dark mode; SVG, PNG and Save honor it")
            stage = 19
            break
        if child.poll() is not None:
            break
    if stage != 19:
        raise AssertionError(f"Native export deadline at stage {stage}\n{screen.text()}\n{output[-1500:]!r}")
finally:
    stop_child()
    os.close(master)
