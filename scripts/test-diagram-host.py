"""Observe the real host TUI in an owned PTY against the isolated fixture service."""

import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from terminal_screen import TerminalScreen

project, session = sys.argv[1:3]
failure_mode = sys.argv[3:] == ["failure"]
viewport_mode = sys.argv[3:] == ["viewport"]
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
stage = -1
screen = TerminalScreen(170, 55)
sidebar_left = 128
ready_position = None
ready_since = 0
tab_position = None
tab_since = 0
pan_remaining = 0
next_pan = 0
def click(position):
    x, y = position
    os.write(master, f"\x1b[<0;{x + 2};{y + 1}M\x1b[<0;{x + 2};{y + 1}m".encode())
def terminate(_signal, _frame):
    # execFile cancellation must unwind finally, not orphan the owned TUI.
    print(f"Native host stopped at stage {stage}:\n{screen.text(sidebar_left)}", file=sys.stderr, flush=True)
    raise SystemExit(128 + _signal)
signal.signal(signal.SIGTERM, terminate)
try:
    deadline = time.monotonic() + (8 if viewport_mode else 20)
    while time.monotonic() < deadline:
        wait = min(0.1, max(0, next_pan - time.monotonic())) if viewport_mode and stage == 1 and pan_remaining else 0.1
        readable, _, _ = select.select([master], [], [], wait)
        # A stable final paint need not emit another frame. Advance initial
        # readiness on select timeouts too, without retrying the eventual click.
        if readable or (stage == -1 and tab_position is not None) or (stage == 0 and ready_position is not None) or (viewport_mode and stage == 1):
            try:
                data = os.read(master, 65536) if readable else b""
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            output.extend(data)
            screen.feed(data)
            if failure_mode:
                with open(os.path.join(project, "host-failure-screen.txt"), "w") as diagnostic:
                    diagnostic.write(f"stage={stage}\n{screen.text()}")
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
            if viewport_mode:
                if stage == -1 and all(screen.find(label) for label in ["[Classic sidebar]", "[circuit]", "Context"]):
                    position = screen.find("[circuit]")
                    if position != tab_position:
                        tab_position, tab_since = position, time.monotonic()
                    if time.monotonic() - tab_since < 0.15:
                        continue
                    sidebar_left = screen.find("View ")[0]
                    click(position)
                    stage = 0
                elif stage == 0 and screen.find("I2C sensor circuit") and screen.find("┌─Controller board (sheet)"):
                    position = (screen.find("I2C sensor circuit"), screen.find("┌─Controller board (sheet)"))
                    if position != ready_position:
                        ready_position, ready_since = position, time.monotonic()
                    if time.monotonic() - ready_since < 0.15:
                        continue
                    assert screen.find("┌─Controller board (sheet)")[0] - sidebar_left == 1, "Initial circuit shows canvas left, not a node's lane"
                    print("OK: actual native sidebar diagram loads at canvas top-left", flush=True)
                    pan_remaining = 30
                    stage = 1
                elif stage == 1:
                    if pan_remaining and time.monotonic() >= next_pan:
                        x, y = sidebar_left + 12, 30
                        os.write(master, f"\x1b[<65;{x};{y}M\x1b[<67;{x};{y}M".encode())
                        pan_remaining -= 1
                        next_pan = time.monotonic() + 0.03
                    elif not pan_remaining and not screen.find("I2C sensor circuit") and not screen.find("Controller board (sheet)"):
                        print("READY: native viewport update", flush=True)
                        stage = 2
                elif stage == 2 and screen.find("Updated viewport circuit") and screen.find("┌─Controller board (sheet)"):
                    assert screen.find("┌─Controller board (sheet)")[0] - sidebar_left == 1, "Update resets horizontal canvas offset"
                    print("OK: actual native sidebar diagram update resets bottom-right pan to top-left")
                    stage = 8
                    break
                continue
            if stage == -1 and all(screen.find(label) for label in ["[Classic sidebar]", "[Files]", "Context", "[Layers]" if failure_mode else "[Model]"]):
                # Startup text can precede final tab hitboxes. Wait for one stable
                # target before the sole click; never retry a failed interaction.
                position = screen.find("[Layers]" if failure_mode else "[Model]")
                if position != tab_position:
                    tab_position, tab_since = position, time.monotonic()
                if time.monotonic() - tab_since < 0.15:
                    continue
                sidebar_left = screen.find("View ")[0]
                assert "[Overview]" not in screen.text(sidebar_left), "Cached diagrams must not take over the default sidebar"
                print("OK: actual native TUI starts on Classic sidebar with diagram tabs retained")
                click(position)
                stage = 0
            if failure_mode:
                if all(word in screen.text() for word in ["Embedding 32", "GELU", "Encoder layers · stale", "commit", "steps"]):
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
    print(f"Rendered screen at interaction stage {stage}:\n{screen.text()}", file=sys.stderr)
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
