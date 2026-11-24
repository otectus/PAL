.pragma library

// Splits one command line into a program and its arguments, as a person types it: quotes group words and a backslash
// keeps the next character. Nothing else is special. The result runs directly and never through a shell, so a shell
// operator outside quotes is reported instead of being passed along as an argument by surprise.
var operators = ["|", "||", "&", "&&", ";", ">", ">>", "<", "2>", "2>&1"]
function split(text) {
    var words = [], word = "", started = false, quote = ""
    for (var index = 0; index < text.length; index++) {
        var c = text[index]
        if (quote) {
            if (c === quote) quote = ""
            else if (c === "\\" && quote === '"' && index + 1 < text.length && ['"', "\\"].indexOf(text[index + 1]) >= 0) word += text[++index]
            else word += c
        } else if (c === "'" || c === '"') { quote = c; started = true }
        else if (c === "\\" && index + 1 < text.length) { word += text[++index]; started = true }
        else if (c === " " || c === "\t" || c === "\n") { if (started) words.push({ text: word, bare: true }); word = ""; started = false }
        else { word += c; started = true }
    }
    if (quote) return { argv: [], problem: "A quote is not closed." }
    if (started) words.push({ text: word, bare: true })
    var argv = words.map(function (item) { return item.text })
    if (!argv.length) return { argv: [], problem: "" }
    // Only a whole unquoted word counts: “a|b” inside an argument is left alone.
    var bare = bareWords(text)
    for (var at = 0; at < bare.length; at++) if (operators.indexOf(bare[at]) >= 0)
        return { argv: argv, problem: "“" + bare[at] + "” is a shell operator and PAL runs one program directly. For a shell line, use sh -c '…'." }
    if (argv.length > 64) return { argv: argv, problem: "Use up to 64 arguments." }
    return { argv: argv, problem: "" }
}
function bareWords(text) { return text.replace(/\\./g, "x").replace(/'[^']*'|"[^"]*"/g, "x").split(/\s+/).filter(function (word) { return word.length > 0 }) }
