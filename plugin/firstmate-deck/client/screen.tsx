import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { DeckProvider, Muted, totalAsks, useSummary } from "./common";
import { ProjectCards } from "./project-card";
import { isActiveProject, toggleLabel, visibleProjects } from "./projects";

function ProjectPagesBody({ theme, layout }: PluginScreenProps) {
  const { projects, loading, unavailable, problem } = useSummary();
  const [showAll, setShowAll] = useState(false);
  const shown = visibleProjects(projects, showAll);
  const hidden = projects.filter((p) => !isActiveProject(p)).length;
  const total = totalAsks(projects);
  const pad = layout.compact ? 16 : 28;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 16 }}>
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700" }}>Project pages</Text>
          {toggleLabel(showAll, hidden) ? (
            <Pressable accessibilityRole="button" onPress={() => setShowAll((v) => !v)}>
              <Text style={{ color: theme.colors.accent, fontSize: 14, fontWeight: "600" }}>
                {toggleLabel(showAll, hidden)}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <Muted theme={theme}>
          {total > 0 ? `${total} open question${total === 1 ? "" : "s"} waiting on you.` : "One page per project the first mate runs."}
        </Muted>
      </View>

      {problem ? <Text style={{ color: theme.colors.statusWarning, fontSize: 14 }}>{problem}</Text> : null}
      {unavailable ? (
        <Muted theme={theme} size={14}>Unavailable right now. The deck will retry on its own.</Muted>
      ) : loading ? (
        <Muted theme={theme} size={14}>Loading…</Muted>
      ) : (
        <ProjectCards projects={shown} theme={theme} hidden={showAll ? 0 : hidden} />
      )}
    </ScrollView>
  );
}

// The screen id stays "needs-you" (routes store it); only the title changed.
export function ProjectPagesScreen(props: PluginScreenProps) {
  return (
    <DeckProvider>
      <ProjectPagesBody {...props} />
    </DeckProvider>
  );
}
