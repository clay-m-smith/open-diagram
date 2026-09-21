"""Observe the real host TUI in an owned PTY against the isolated fixture service."""

import errno
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time
from terminal_screen import TerminalScreen

project, session = sys.argv[1:3]
failure_mode = sys.argv[3:] == ["failure"]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 55, 170, 0, 0))
env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
child = subprocess.Popen(
    ["opencode", project, "--session", session],
    stdin=slave, stdout=slave, stderr=slave, cwd=project, env=env,
    start_new_session=True,
)
os.close(slave)
output = bytearray()
text = ""
stage = 0
screen = TerminalScreen(170, 55)
sidebar_left = 128
ready_position = None
ready_since = 0
def click(position):
    x, y = position
    os.write(master, f"\x1b[<0;{x + 2};{y + 1}M\x1b[<0;{x + 2};{y + 1}m".encode())
try:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.1)
        # A stable final paint need not emit another frame. Advance initial
        # readiness on select timeouts too, without retrying the eventual click.
        if readable or (stage == 0 and ready_position is not None):
            try:
                data = os.read(master, 65536) if readable else b""
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            output.extend(data)
            screen.feed(data)
            if len(output) > 1024 * 1024:
                del output[:-1024 * 1024]
            # Answer standard terminal capability/background/cursor probes.
            if b"\x1b[c" in data or b"\x1b[0c" in data:
                os.write(master, b"\x1b[?1;2c")
            if b"\x1b[6n" in data:
                os.write(master, b"\x1b[1;1R")
            if b"\x1b]11;?" in data:
                os.write(master, b"\x1b]11;rgb:1a1a/1b1b/2626\x07")
            # Hosts may paint adjacent words in separate cursor-positioned runs.
            # Assert the rendered screen, not concatenated incremental VT writes.
            text = screen.text()
            if failure_mode:
                if "Embedding 32" in screen.text() and "GELU" in screen.text() and "Field repair" in screen.text():
                    print("OK: actual native TUI retains cached layers beside failed-update warning")
                    stage = 8
                    break
                continue
            if stage == 0 and "Embedding classifier" in text and "[Model]" in text and "[Files]" in text and "[Classic sidebar]" in text and screen.find("Embedding *"):
                # Initial paint precedes measured-width reflow. Do not press an
                # old card that gets replaced before its mouse-up is delivered.
                position = screen.find("Embedding *")
                if position != ready_position:
                    ready_position, ready_since = position, time.monotonic()
                if time.monotonic() - ready_since < 0.1:
                    continue
                normal, muted = screen.foreground("[Overview]"), screen.foreground("Depth ")
                assert normal is not None and muted is not None and normal != muted, "Plugin must render distinct host text/muted theme colors, not undefined-token white"
                print("OK: actual native diagram retains distinct host theme colors")
                print("OK: actual OpenCode TUI loaded standalone bridge and rendered compact native sidebar tabs")
                sidebar_left = screen.find("Depth ")[0]
                assert "[1]" not in screen.text(sidebar_left) and "▼" in screen.text(sidebar_left)
                assert screen.foreground("features") == screen.foreground("▼") != muted, "Native connection label and arrow must share their route color"
                print("OK: actual native arrow and label share connection color")
                click(screen.find("Embedding *"))
                stage = 1
            elif stage == 1 and "Maps token indices" in screen.text() and "Encoder layer" in screen.text() and screen.find("[Sources]"):
                assert "read ·" not in screen.text(sidebar_left)
                print("OK: actual host expanded block keeps description and shows functional explanation")
                click(screen.find("[Sources]"))
                stage = 2
            elif stage == 2 and screen.find("[Hide sources]") and "model.py" in screen.text(sidebar_left):
                assert "read ·" not in screen.text(sidebar_left) and "completed" not in screen.text(sidebar_left)
                print("OK: actual host Sources click exposes file reference without tool-call logs")
                click(screen.find("[Granular]"))
                stage = 3
            elif stage == 3 and "Embedding 32 × 8" in screen.text() and "GELU" in screen.text() and "[Layers]" in screen.text():
                print("OK: actual host Granular control generates individual layers and observed parameters")
                stage = 4
                output.clear()
                os.write(master, b"/open-diagram sidebar\r")
            elif stage == 4 and "Context" in text:
                print("OK: native Sidebar contents restored")
                stage = 5
                output.clear()
                os.write(master, b"/open-diagram panel\r")
            elif stage == 5 and "Drag divider to resize" in text and screen.find("[Fullscreen]"):
                assert all(screen.find(label) for label in ["[PNG]", "[SVG]", "[Save]"])
                print("OK: expanded native panel shows resize hint")
                stage = 6
                output.clear()
                # Focused panel has single-letter shortcuts: typing a slash
                # command here can invoke Pause. Use its actual fullscreen button.
                click(screen.find("[Fullscreen]"))
            elif stage == 6 and "[Restore]" in text:
                assert all(screen.find(label) for label in ["[PNG]", "[SVG]", "[Save]"])
                print("OK: native fullscreen panel exercised")
                # Reload the isolated fixture plugin while the actual host is
                # still attached. Viewing must restore its graph without a model
                # call or manual Refresh, and expose retained ready/stale state.
                config_path = os.path.join(project, "opencode.json")
                with open(config_path) as source:
                    config = json.load(source)
                config["plugins"][0]["options"]["intervalMs"] = 1002
                with open(config_path, "w") as target:
                    json.dump(config, target)
                stage = 7
            elif stage == 7 and "ready" in screen.text() and "stale" in screen.text() and "Embedding 32" in screen.text():
                print("OK: attached native TUI recovers cached layers after plugin reload without Refresh")
                stage = 8
                break
        if child.poll() is not None:
            break
    else:
        raise AssertionError(f"Native diagram interaction deadline at stage {stage}")
    if stage != 8:
        raise AssertionError(f"Native TUI exited before interaction stage {stage}")
except BaseException:
    print(output.decode("utf-8", "replace")[-12000:], file=sys.stderr)
    raise
finally:
    child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=3)
    os.close(master)
