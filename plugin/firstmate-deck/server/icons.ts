// The task navigator's icons: Lucide paths (ISC licence), drawn at 24x24 with a round 1.75 stroke. One set, so every
// icon on the page has the same weight.
export const ICON = {
  you: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>', // circle-alert
  fm: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>', // message-circle
  running: '<circle cx="12" cy="12" r="10"/><path d="m10 8 6 4-6 4Z"/>', // circle-play
  blocked: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>', // ban
  next: '<path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/>', // circle-dashed
  parked: '<circle cx="12" cy="12" r="10"/><path d="M10 15V9"/><path d="M14 15V9"/>', // circle-pause
  done: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>', // circle-check
  panelOpen: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>',
  panelClose: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  focus: '<circle cx="12" cy="12" r="3"/><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
  more: '<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/>', // chevrons-down
} as const;

export const svg = (paths: string): string =>
  `<svg class="tn-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
