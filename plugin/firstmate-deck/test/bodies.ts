// Done and parked cards are one line in the live payload; their bodies travel separately (render.ts `bodies`). Tests that read a
// finished card's content use this: the payload with every body put back in its card and the bodies' stylesheets hoisted once.
export const withBodies = (r: { live: string; bodies: Record<string, { html: string; css: string }> }): string => {
  const live = r.live.replace(/<details class="lz" id="lz-([^"]+)"><summary>Show card<\/summary><div class="lzb"><\/div><\/details>/g, (m, id: string) => r.bodies[id]?.html ?? m);
  const css = [...new Set(Object.values(r.bodies).map((b) => b.css).filter(Boolean))];
  return css.length ? `${live}\n<style data-cv-snap>\n${css.join("\n")}\n</style>` : live;
};
