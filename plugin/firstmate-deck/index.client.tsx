import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ProjectPagePanel } from "./client/panel";
import { NeedsYouScreen } from "./client/screen";
import { NEEDS_YOU_SCREEN, NeedsYouItem } from "./client/sidebar";
import { CommentRowCard } from "./client/timeline";
import { COMMENT_ROW_KIND, COMMENT_ROW_VERSION, commentRowSchema } from "./shared/contract";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: NEEDS_YOU_SCREEN, title: "Needs you", Component: NeedsYouScreen }),
    client.addSidebarHeaderItem({ id: "needs-you", title: "Needs you", Component: NeedsYouItem }),
    client.addWorkspacePanel({ id: "project-page", title: "Project page", icon: "Anchor", context: "workspace", Component: ProjectPagePanel }),
    client.addTimelineRenderer({ kind: COMMENT_ROW_KIND, version: COMMENT_ROW_VERSION, schema: commentRowSchema, Component: CommentRowCard }),
  ];
  return () => {
    for (const c of cleanups) c();
  };
}
