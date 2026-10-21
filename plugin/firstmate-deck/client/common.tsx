import { useRpc, openExternalUrl, type PluginHostProps } from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { summaryRpc, type ProjectSummary } from "../shared/contract";

// Own client so the plugin never depends on whether the host mounts a QueryClientProvider.
// Shared by every surface, so the sidebar, the screen and the panel poll one cache entry.
const queryClient = new QueryClient();

export function DeckProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

export const REFRESH_MS = 10_000;

export type Summary = {
  projects: ProjectSummary[];
  /** True until the first response, and while the last request failed with nothing cached. */
  loading: boolean;
  unavailable: boolean;
  /** Why the plugin cannot work (e.g. firstmateRoot is wrong), else null. */
  problem: string | null;
};

export function useSummary(): Summary {
  const call = useRpc(summaryRpc);
  const q = useQuery({
    queryKey: ["firstmate-deck", "summary"],
    queryFn: () => call({}),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  });
  return {
    projects: q.data?.projects ?? [],
    loading: q.isPending,
    unavailable: q.isError && !q.data,
    problem: q.data?.problem ?? null,
  };
}

export function totalAsks(projects: readonly ProjectSummary[]): number {
  return projects.reduce((n, p) => n + p.needsYou.length, 0);
}

export function normalizePath(p: string | null | undefined): string {
  if (!p) return "";
  const t = p.replace(/\/+$/, "");
  return t === "" ? "/" : t;
}

export function matchProject(projects: readonly ProjectSummary[], paths: readonly string[]): ProjectSummary | null {
  const wanted = new Set(paths.map(normalizePath).filter(Boolean));
  return projects.find((p) => p.repo && wanted.has(normalizePath(p.repo))) ?? null;
}

export function countsLine(p: ProjectSummary): string {
  const parts: string[] = [];
  if (p.counts.needsYou > 0) parts.push(`${p.counts.needsYou} needs you`);
  if (p.counts.withFirstMate) parts.push(`${p.counts.withFirstMate} with the first mate`);
  parts.push(`${p.counts.running} running`);
  parts.push(`${p.counts.done} done`);
  if (p.counts.failed) parts.push(`${p.counts.failed} failed`);
  return parts.join(" · ");
}

export function sinceText(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export type Navigation = {
  openBrowser?: (input: { url: string; workspaceId: string; serverId?: string }) => void;
};

/** In-app browser tab when the host offers one (Electron, from a workspace), else the external opener. */
export function openPage(url: string, nav?: { navigation?: Navigation; workspaceId?: string }): void {
  const openBrowser = nav?.navigation?.openBrowser;
  if (openBrowser && nav?.workspaceId) {
    openBrowser({ url, workspaceId: nav.workspaceId });
    return;
  }
  openExternalUrl(url).catch(() => {});
}

export function Button({
  label,
  onPress,
  theme,
  disabled,
}: {
  label: string;
  onPress: () => void;
  theme: PluginHostProps["theme"];
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        alignSelf: "flex-start",
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: disabled ? theme.colors.surface2 : theme.colors.accent,
      }}
    >
      <Text style={{ color: disabled ? theme.colors.foregroundMuted : theme.colors.accentForeground, fontWeight: "600", fontSize: 14 }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Muted({ theme, children, size = 13 }: { theme: PluginHostProps["theme"]; children: ReactNode; size?: number }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: size }}>{children}</Text>;
}

export function statusColor(theme: PluginHostProps["theme"], status: string): string {
  switch (status) {
    case "running":
    case "initializing":
      return theme.colors.statusSuccess;
    case "error":
      return theme.colors.statusDanger;
    case "idle":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, marginTop: 6 }} />;
}
