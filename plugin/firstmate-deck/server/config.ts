// Plugin settings + environment -> the effective configuration. Pure.
export type SettingsValues = { firstmateRoot?: string; firstmateLabel?: string; lavishPort?: number; lavishStateDir?: string };

export type DeckConfig = {
  root: string;
  firstmateLabel: string;
  lavishPort?: string;
  lavishStateDir?: string;
};

export const LAVISH_DEFAULT_PORT = 4387;

export function resolveConfig(s: SettingsValues, env: Record<string, string | undefined>): DeckConfig {
  // The settings schema always yields a port (default 4387, Lavish's own default), so "unset" means "still the
  // default": only then does the environment get a say.
  const port = s.lavishPort && s.lavishPort !== LAVISH_DEFAULT_PORT ? String(s.lavishPort) : env.LAVISH_AXI_PORT || (s.lavishPort ? String(s.lavishPort) : undefined);
  return {
    root: s.firstmateRoot || env.FIRSTMATE_ROOT || "",
    firstmateLabel: s.firstmateLabel || "firstmate=true",
    lavishPort: port,
    lavishStateDir: s.lavishStateDir || env.LAVISH_AXI_STATE_DIR || undefined,
  };
}
