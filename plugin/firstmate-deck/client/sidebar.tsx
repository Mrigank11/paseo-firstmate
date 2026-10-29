import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { DeckProvider, totalAsks, useSummary } from "./common";

export const NEEDS_YOU_SCREEN = "needs-you";

function ProjectPagesRow({ theme, openScreen, currentScreen }: PluginSidebarItemProps) {
  const { projects, unavailable } = useSummary();
  const n = totalAsks(projects);
  const hot = n > 0;
  const label = unavailable ? "Project pages · unavailable" : "Project pages";
  // The row's own text color is host-owned, so the accent lives on the icon dot and the badge.
  return (
    <SidebarRow
      icon="Anchor"
      label={label}
      active={currentScreen?.screenId === NEEDS_YOU_SCREEN}
      onPress={() => openScreen({ screenId: NEEDS_YOU_SCREEN })}
      trailing={
        !hot ? undefined : (
        <View
          style={{
            minWidth: 22,
            height: 22,
            marginRight: 8,
            paddingHorizontal: 6,
            borderRadius: 11,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.colors.accent,
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.accentForeground }}>{n}</Text>
        </View>
        )
      }
    />
  );
}

export function ProjectPagesItem(props: PluginSidebarItemProps) {
  return (
    <DeckProvider>
      <ProjectPagesRow {...props} />
    </DeckProvider>
  );
}
