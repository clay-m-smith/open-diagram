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

def check_svg(data):
    root = ET.fromstring(data)
    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    text = " ".join(root.itertext())
    assert "Embedding" in text and "GELU" in text
    assert all(chrome not in text for chrome in ["[PNG]", "[SVG]", "[Save]", "[Refresh]", "[Pause]", "[Sources]", "stale"])

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
            assert png[:8] == b"\x89PNG\r\n\x1a\n"
            assert struct.unpack(">II", png[16:24])[0] == 960
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
        elif stage == 8 and os.path.exists(clipboard_path) and export_idle() and screen.find("[Full]"):
            with open(clipboard_path, "rb") as image:
                check_svg(image.read())
            click("[Full]")
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
                assert image.read(8) == b"\x89PNG\r\n\x1a\n"
            print("OK: actual native PNG action sends image/png to clipboard adapter")
            stage = 12
            break
        if child.poll() is not None:
            break
    if stage != 12:
        raise AssertionError(f"Native export deadline at stage {stage}\n{screen.text()}\n{output[-1500:]!r}")
finally:
    child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=3)
    os.close(master)
