// Colour for console warnings - only when the stream is a real terminal, so a piped or redirected log (systemd, a file) never
// has raw escape codes embedded in it instead of a colour.
function red(text, stream = process.stderr) {
  return stream.isTTY ? `\x1b[31m${text}\x1b[0m` : text;
}
function orange(text, stream = process.stderr) {
  return stream.isTTY ? `\x1b[38;5;208m${text}\x1b[0m` : text;
}

module.exports = { red, orange };
