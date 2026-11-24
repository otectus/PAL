.pragma library
// Times and lines of a recording, shared by the Recordings pane and the time links under replies.
/** 12:34, or 1:02:03 from an hour on. */
function clock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0)), pad = number => String(number).padStart(2, "0")
    return total >= 3600 ? Math.floor(total / 3600) + ":" + pad(Math.floor(total / 60) % 60) + ":" + pad(total % 60) : Math.floor(total / 60) + ":" + pad(total % 60)
}
/** Reads 12:34, 1:02:03, 75 or 12:34.5; undefined when it is none of these. */
function seconds(text) {
    const match = /^\s*(?:(\d{1,2}):)?(?:(\d{1,3}):)?(\d{1,5})(?:[.,](\d{1,3}))?\s*$/.exec(String(text))
    if (!match) return undefined
    // With one colon the first number is minutes; with two it is hours.
    const hours = match[2] === undefined ? 0 : Number(match[1]), minutes = match[2] === undefined ? Number(match[1] || 0) : Number(match[2])
    const rest = Number(match[3]), colons = (match[1] !== undefined ? 1 : 0) + (match[2] !== undefined ? 1 : 0)
    if (colons && rest > 59 || colons === 2 && minutes > 59) return undefined
    return hours * 3600 + minutes * 60 + rest + (match[4] ? Number(match[4].padEnd(3, "0")) / 1000 : 0)
}
function range(start, end) { return clock(start) + "–" + clock(end) }
/** The line being said at a position, or the last one before it; -1 before the first. */
function lineAt(cues, position) {
    let low = 0, high = cues.length - 1, found = -1
    while (low <= high) { const middle = (low + high) >> 1; if (cues[middle].start <= position + 0.05) { found = middle; low = middle + 1 } else high = middle - 1 }
    return found
}
/** Lines that contain every word of a query, by position in the list. */
function matches(cues, query) {
    const words = String(query).toLowerCase().split(/\s+/).filter(word => word)
    if (!words.length) return []
    const found = []
    for (let i = 0; i < cues.length; i++) { const text = ((cues[i].speaker || "") + " " + cues[i].text).toLowerCase(); if (words.every(word => text.includes(word))) found.push(i) }
    return found
}
/** Selected lines as text a person or a model can read, each with its time. */
function quote(cues, name) {
    return cues.map(cue => "> [" + clock(cue.start) + "] " + (cue.speaker ? cue.speaker + ": " : "") + String(cue.text).replace(/\s*\n\s*/g, " ")).join("\n") + (name ? "\n> — " + name + (cues.length ? ", " + range(cues[0].start, cues[cues.length - 1].end) : "") : "")
}
/** Times a reply cites, such as [12:34] or [1:02:03–1:02:10]: each once, in the order they appear. */
function cited(text, limit) {
    const pattern = /\[\s*((?:\d{1,2}:)?\d{1,3}:\d{2})(?:\s*[–-]\s*((?:\d{1,2}:)?\d{1,3}:\d{2}))?\s*\]/g, seen = ({}), found = []
    for (let match = pattern.exec(text); match && found.length < (limit || 8); match = pattern.exec(text)) {
        const start = seconds(match[1])
        if (start === undefined || seen[start]) continue
        seen[start] = true; found.push({ start: start, end: match[2] ? seconds(match[2]) : undefined, label: clock(start) })
    }
    return found
}
