// A crew on another host writes its canvas with a key in the x-canvas-key header (agent-canvas). Wherever the deck logs,
// shows or forwards a command or a crew's text, the header's value goes, however it is quoted. Redact BEFORE cutting text
// short: a cut value would no longer be recognised. Dependency-free.
const HEADER = /(x-canvas-key(?![\w-])[\s"'`\\]*[:=,](?:[\s"'`\\]|\$(?=["']))*)([^\s"'`\\,;|&()<>}]+)/gi;

/** `text` without any x-canvas-key value. A bare variable ($KEY, ${KEY}, $(...)) is not a value and stays. */
export const redact = (text: string): string =>
  text.replace(HEADER, (all, head: string, value: string) => (/^\$\{?\w*$/.test(value) || value.startsWith("[redacted]") ? all : `${head}[redacted]`));
