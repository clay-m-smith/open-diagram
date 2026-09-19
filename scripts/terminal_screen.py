"""Small VT screen used only to locate controls in the owned OpenTUI PTY test."""
import codecs
import re
import unicodedata


class TerminalScreen:
    def __init__(self, width, height):
        self.width, self.height = width, height
        self.rows = [[" "] * width for _ in range(height)]
        self.foregrounds = [[None] * width for _ in range(height)]
        self.fg = None
        self.x = self.y = 0
        self.saved = (0, 0)
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def feed(self, data):
        text = self.pending + self.decoder.decode(data)
        i = 0
        while i < len(text):
            char = text[i]
            if char == "\x1b":
                if i + 1 >= len(text):
                    break
                if text[i + 1] == "[":
                    match = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", text[i:])
                    if not match:
                        break
                    self.csi(match[1], match[3])
                    i += len(match[0])
                    continue
                if text[i + 1] in "]P_":
                    match = re.search(r"\x07|\x1b\\", text[i + 2:])
                    if not match:
                        break
                    i += 2 + match.end()
                    continue
                if text[i + 1] in "()":
                    if i + 2 >= len(text):
                        break
                    i += 3
                    continue
                i += 2
                continue
            if char == "\r":
                self.x = 0
            elif char == "\n":
                self.y += 1
            elif char == "\b":
                self.x = max(0, self.x - 1)
            elif char == "\t":
                self.x = min(self.width - 1, (self.x // 8 + 1) * 8)
            elif ord(char) >= 32 and not unicodedata.combining(char):
                width = 2 if unicodedata.east_asian_width(char) in "WF" else 1
                if self.x + width > self.width:
                    self.x = 0
                    self.y += 1
                self.scroll()
                self.rows[self.y][self.x] = char
                self.foregrounds[self.y][self.x] = self.fg
                if width == 2:
                    self.rows[self.y][self.x + 1] = ""
                    self.foregrounds[self.y][self.x + 1] = self.fg
                self.x += width
            self.scroll()
            i += 1
        self.pending = text[i:]

    def scroll(self):
        while self.y >= self.height:
            self.rows.pop(0)
            self.rows.append([" "] * self.width)
            self.foregrounds.pop(0)
            self.foregrounds.append([None] * self.width)
            self.y -= 1

    def csi(self, raw, command):
        params = [int(value or 0) for value in raw.lstrip("?>").split(";") if value.isdigit() or not value]
        first = params[0] if params else 0
        count = first or 1
        if command in "Hf":
            self.y = min(self.height - 1, count - 1)
            self.x = min(self.width - 1, (params[1] or 1) - 1 if len(params) > 1 else 0)
        elif command == "G": self.x = min(self.width - 1, count - 1)
        elif command == "d": self.y = min(self.height - 1, count - 1)
        elif command == "A": self.y = max(0, self.y - count)
        elif command == "B": self.y = min(self.height - 1, self.y + count)
        elif command == "C": self.x = min(self.width - 1, self.x + count)
        elif command == "D": self.x = max(0, self.x - count)
        elif command == "s": self.saved = self.x, self.y
        elif command == "u": self.x, self.y = self.saved
        elif command == "m":
            i = 0
            while i < len(params):
                value = params[i]
                if value in (0, 39):
                    self.fg = None
                elif value in (38, 48) and i + 1 < len(params):
                    length = 3 if params[i + 1] == 2 else 1 if params[i + 1] == 5 else 0
                    if length and i + 2 + length <= len(params):
                        if value == 38:
                            self.fg = tuple(params[i + 1:i + 2 + length])
                        i += 1 + length
                elif 30 <= value <= 37 or 90 <= value <= 97:
                    self.fg = (value,)
                i += 1
        elif command == "J" and first in (2, 3):
            self.rows = [[" "] * self.width for _ in range(self.height)]
            self.foregrounds = [[None] * self.width for _ in range(self.height)]
        elif command == "K":
            start, end = (0, self.width) if first == 2 else (0, self.x + 1) if first == 1 else (self.x, self.width)
            self.rows[self.y][start:end] = [" "] * (end - start)
            self.foregrounds[self.y][start:end] = [None] * (end - start)

    def find(self, label):
        for y, row in enumerate(self.rows):
            for x in range(self.width):
                if "".join(row[x:]).startswith(label):
                    return x, y
        return None

    def text(self, left=0):
        return "\n".join("".join(row[left:]) for row in self.rows)

    def foreground(self, label):
        position = self.find(label)
        return self.foregrounds[position[1]][position[0]] if position else None
