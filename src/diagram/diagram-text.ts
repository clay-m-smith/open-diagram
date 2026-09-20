import stringWidth from "string-width"

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" })
export function diagramTextWidth(value: string): number { return stringWidth(value) }

/** Wrap at word boundaries where possible, never inside a Unicode grapheme. */
export function wrapDiagramText(value: string, columns: number): string[] {
  const width = Math.max(2, Math.floor(columns))
  const lines: string[] = []
  let line = ""
  for (const word of value.split(/\s+/u)) {
    if (!word) continue
    if (line && diagramTextWidth(`${line} ${word}`) <= width) { line += ` ${word}`; continue }
    if (line) { lines.push(line); line = "" }
    for (const { segment } of segments.segment(word)) {
      if (diagramTextWidth(line + segment) > width) { lines.push(line); line = "" }
      line += segment
    }
  }
  if (line || !lines.length) lines.push(line)
  return lines
}
