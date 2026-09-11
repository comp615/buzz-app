// FOUNDATION: Type-only author entry. Runtime capabilities come from injected ctx.
export type { PluginManifest, PluginModule } from "./api";
export type { Context } from "@deepseek-ai/cordis";
export type { Page, Pages } from "../features/pages/service";
export type {
  Panel,
  Panels,
  ChannelPanelContext,
  ChannelLauncherProps,
} from "../features/panels/service";
export type { Conversation } from "../features/conversation/service";
export type {
  ComposerObservation,
  CompletionContext,
  CompletionQuery,
  CompletionEdit,
  CompletionSuggestion,
  CompletionResult,
  ComposerCompletionProps,
  ComposerCompletion,
  ComposerToolProps,
  ComposerTool,
  InlineContent,
  InlineRange,
  InlineRenderer,
} from "../features/conversation/contracts";
export type { RelayData, RelaySnapshot } from "../features/relay/service";

export type {
  Shortcuts,
  Shortcut,
  KeyBinding,
  RegisteredShortcut,
} from "../features/shortcuts/service";

export type {
  UnreadCapability,
  UnreadSnapshot,
  ThreadActivityItem,
  ThreadActivitySnapshot,
  ReadingHandle,
} from "../features/relay/unread";
export type { ReadTarget } from "../features/relay/read-state-model";
export type {
  ReadMutationResult,
  ReadSyncSnapshot,
} from "../features/relay/read-state";

export type {
  Navigation,
  NavigationSnapshot,
  OpenResult,
  OpenFailure,
} from "../features/navigation/controller";
export type {
  OpenTarget,
  SharedTarget,
  NavigationScope,
  JsonValue,
} from "../features/navigation/targets";
export type { PageNavigation } from "../features/navigation/service";
