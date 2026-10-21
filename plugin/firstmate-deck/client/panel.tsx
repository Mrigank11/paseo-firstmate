import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import type { ProjectSummary } from "../shared/contract";
import {
  Button,
  DeckProvider,
  Dot,
  Muted,
  countsLine,
  matchProject,
  openPage,
  sinceText,
  statusColor,
  useSummary,
} from "./common";

const SEP = "\n";

function ProjectView({ p, props }: { p: ProjectSummary; props: PluginWorkspacePanelProps }) {
  const { theme, navigation, workspaceId } = props;
  return (
    <>
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700" }}>{p.title}</Text>
        <Muted theme={theme} size={14}>{countsLine(p)}</Muted>
      </View>

      {p.banner ? (
        <View style={{ padding: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.statusWarning, backgroundColor: theme.colors.surface1 }}>
          <Text style={{ color: theme.colors.statusWarning, fontSize: 14 }}>{p.banner}</Text>
        </View>
      ) : null}

      {p.pageUrl ? (
        <Button theme={theme} label="Open page" onPress={() => openPage(p.pageUrl!, { navigation, workspaceId })} />
      ) : (
        <Muted theme={theme}>The page has not been opened yet.</Muted>
      )}

      {p.needsYou.length > 0 ? (
        <View style={{ gap: 10 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.8 }}>NEEDS YOU</Text>
          {p.needsYou.map((a) => (
            <View
              key={`${a.taskId}#${a.askId ?? ""}`}
              style={{
                gap: 6,
                padding: 14,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: theme.colors.accent,
                backgroundColor: theme.colors.surface1,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 17, lineHeight: 24, fontWeight: "600" }}>{a.text}</Text>
              <Muted theme={theme}>
                {a.taskTitle} · {sinceText(a.since)}
              </Muted>
            </View>
          ))}
        </View>
      ) : null}

      {p.running.length > 0 ? (
        <View style={{ gap: 10 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.8 }}>RUNNING</Text>
          {p.running.map((r) => (
            <View key={r.taskId} style={{ flexDirection: "row", gap: 10 }}>
              <Dot color={statusColor(theme, r.agentStatus)} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{r.taskTitle}</Text>
                {r.current ? <Muted theme={theme}>{r.current}</Muted> : <Muted theme={theme}>{r.agentStatus}</Muted>}
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

function PanelBody(props: PluginWorkspacePanelProps) {
  const { theme, layout, workspaceId, navigation } = props;
  const paths = useWorkspace(workspaceId, (w) => `${w.projectRootPath}${SEP}${w.directory}`);
  const { projects, loading, unavailable, problem } = useSummary();
  const match = paths ? matchProject(projects, paths.split(SEP)) : null;
  const pad = layout.compact ? 16 : 24;
  const withPages = projects.filter((p) => p.pageUrl);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 16 }}>
      {problem ? <Text style={{ color: theme.colors.statusWarning, fontSize: 14 }}>{problem}</Text> : null}
      {unavailable ? (
        <Muted theme={theme} size={14}>Project pages are unavailable right now. Retrying.</Muted>
      ) : loading ? (
        <Muted theme={theme} size={14}>Loading…</Muted>
      ) : match ? (
        <ProjectView p={match} props={props} />
      ) : (
        <>
          <View style={{ gap: 4 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "700" }}>No project page for this workspace</Text>
            <Muted theme={theme} size={14}>
              This workspace's repository does not match any project the first mate keeps a page for.
            </Muted>
          </View>
          {withPages.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.8 }}>PROJECTS WITH PAGES</Text>
              {withPages.map((p) => (
                <View
                  key={p.project}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: 12,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.surface1,
                  }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{p.title}</Text>
                    <Muted theme={theme}>{countsLine(p)}</Muted>
                  </View>
                  <Button theme={theme} label="Open" onPress={() => openPage(p.pageUrl!, { navigation, workspaceId })} />
                </View>
              ))}
            </View>
          ) : (
            <Muted theme={theme}>No project pages exist yet.</Muted>
          )}
        </>
      )}
    </ScrollView>
  );
}

export function ProjectPagePanel(props: PluginWorkspacePanelProps) {
  return (
    <DeckProvider>
      <PanelBody {...props} />
    </DeckProvider>
  );
}
