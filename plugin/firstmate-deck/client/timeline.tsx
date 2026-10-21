import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import type { commentRowSchema } from "../shared/contract";
import { openPage } from "./common";

export function CommentRowCard({ item, theme, layout }: PluginTimelineItemProps<z.output<typeof commentRowSchema>>) {
  const d = item.data;
  const n = d.comments.length;
  return (
    <View
      style={{
        gap: 6,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View
        style={{
          flexDirection: layout.compact ? "column" : "row",
          alignItems: layout.compact ? "flex-start" : "center",
          justifyContent: "space-between",
          gap: layout.compact ? 2 : 8,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "700", flexShrink: 1, maxWidth: "100%" }} numberOfLines={1}>
          {n} page comment{n === 1 ? "" : "s"} · {d.project}
        </Text>
        <Text style={{ color: d.replied ? theme.colors.statusSuccess : theme.colors.statusWarning, fontSize: 12, fontWeight: "600" }}>
          {d.replied ? "replied" : "awaiting reply"}
        </Text>
      </View>
      {d.comments.map((c, i) => (
        <Text key={i} numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          <Text style={{ color: theme.colors.foreground }}>[{c.target}]</Text> {c.text}
        </Text>
      ))}
      {d.pageUrl ? (
        <Pressable accessibilityRole="link" onPress={() => openPage(d.pageUrl!)} style={{ alignSelf: "flex-start" }}>
          <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>Open page</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
