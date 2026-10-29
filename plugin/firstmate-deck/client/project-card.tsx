import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { ProjectSummary } from "../shared/contract";
import { Button, Dot, Muted, countsLine, openPage, sinceText, type Navigation } from "./common";
import { cardText, emptyState, isActiveProject } from "./projects";

type Theme = PluginHostProps["theme"];

export function stateColor(theme: Theme, p: ProjectSummary): string {
  if (p.needsYou.length > 0 || p.counts.needsYou > 0) return theme.colors.accent;
  if (p.running.length > 0 || p.counts.running > 0) return theme.colors.statusSuccess;
  return isActiveProject(p) ? theme.colors.statusWarning : theme.colors.foregroundMuted;
}

/** One project page: name, state dot, page link, counts, banner and its open asks. */
export function ProjectCard({
  p,
  theme,
  nav,
  showAsks = true,
}: {
  p: ProjectSummary;
  theme: Theme;
  nav?: { navigation?: Navigation; workspaceId?: string };
  showAsks?: boolean;
}) {
  return (
    <View
      style={{
        gap: 10,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <View style={{ flexDirection: "row", gap: 10, flexShrink: 1 }}>
          <Dot color={stateColor(theme, p)} />
          <Text style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "700", flexShrink: 1 }}>{p.title}</Text>
        </View>
        {p.pageUrl ? (
          <Button theme={theme} label="Open page" onPress={() => openPage(p.pageUrl!, nav)} />
        ) : (
          <Muted theme={theme}>{cardText(p, "").link}</Muted>
        )}
      </View>
      <Muted theme={theme} size={14}>{countsLine(p)}</Muted>
      {p.banner ? <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>{p.banner}</Text> : null}
      {showAsks
        ? p.needsYou.map((a) => (
            <View
              key={`${a.taskId}#${a.askId ?? ""}`}
              style={{ gap: 4, paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: theme.colors.accent }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 15, lineHeight: 21 }}>{a.text}</Text>
              <Muted theme={theme}>
                {a.taskTitle} · {sinceText(a.since)}
              </Muted>
            </View>
          ))
        : null}
    </View>
  );
}

/** The cards, or the empty state. Holds no state, so it renders the same from a test. */
export function ProjectCards({
  projects,
  theme,
  nav,
  hidden = 0,
}: {
  projects: readonly ProjectSummary[];
  theme: Theme;
  nav?: { navigation?: Navigation; workspaceId?: string };
  hidden?: number;
}) {
  if (projects.length === 0) {
    const e = emptyState(hidden);
    return (
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>{e.title}</Text>
        <Muted theme={theme} size={14}>
          {e.hint}
        </Muted>
      </View>
    );
  }
  return (
    <>
      {projects.map((p) => (
        <ProjectCard key={p.project} p={p} theme={theme} nav={nav} />
      ))}
    </>
  );
}
