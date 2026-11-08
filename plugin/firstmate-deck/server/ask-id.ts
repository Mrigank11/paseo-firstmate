// The ask ids a crew's canvas can carry, as the page, the pick relay and the comment targets all read them.
// This is agent-canvas's own id rule (shared/canvas.ts ID_RE): a letter, then letters, digits, "_" and "-", 32 characters at most.
// One definition here so the button render, the pick ingest and the target parsing cannot disagree again.

export const CANVAS_ASK_BODY = "[A-Za-z][A-Za-z0-9_-]{0,31}";
