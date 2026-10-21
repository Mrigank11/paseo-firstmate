import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { Button, DeckProvider, Muted, openPage, sinceText, totalAsks, useSummary } from "./common";

function NeedsYouBody({ theme, layout }: PluginScreenProps) {
  const { projects, loading, unavailable } = useSummary();
  const withAsks = projects.filter((p) => p.needsYou.length > 0);
  const total = totalAsks(projects);
  const pad = layout.compact ? 16 : 28;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 16 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700" }}>
          {unavailable ? "Needs you" : `Needs you · ${total}`}
        </Text>
        <Muted theme={theme}>Open questions the first mate is waiting on, per project page.</Muted>
      </View>

      {unavailable ? (
        <Muted theme={theme} size={14}>Unavailable right now. The deck will retry on its own.</Muted>
      ) : loading ? (
        <Muted theme={theme} size={14}>Loading…</Muted>
      ) : withAsks.length === 0 ? (
        <Muted theme={theme} size={14}>Nothing needs you.</Muted>
      ) : (
        withAsks.map((p) => (
          <View
            key={p.project}
            style={{
              gap: 12,
              padding: 16,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "700", flexShrink: 1 }}>{p.title}</Text>
              {p.pageUrl ? (
                <Button theme={theme} label="Open page" onPress={() => openPage(p.pageUrl!)} />
              ) : (
                <Muted theme={theme}>Page not opened yet</Muted>
              )}
            </View>
            {p.banner ? <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>{p.banner}</Text> : null}
            {p.needsYou.map((a) => (
              <View
                key={a.taskId}
                style={{ gap: 4, paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: theme.colors.accent }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 15, lineHeight: 21 }}>{a.text}</Text>
                <Muted theme={theme}>
                  {a.taskTitle} · {sinceText(a.since)}
                </Muted>
              </View>
            ))}
          </View>
        ))
      )}
    </ScrollView>
  );
}

export function NeedsYouScreen(props: PluginScreenProps) {
  return (
    <DeckProvider>
      <NeedsYouBody {...props} />
    </DeckProvider>
  );
}
