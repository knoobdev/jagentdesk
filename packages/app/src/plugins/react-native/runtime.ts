import * as pluginUiRuntime from "./ui";
import { Icon } from "../icons";
import { Modal } from "./modal";
import { ScrollView, FlatList } from "./scroll-view";
import { TextInput } from "./text-input";
import { copyText } from "./clipboard";
import { useToast } from "./toast";
import { useRevealedText } from "@/hooks/use-revealed-text";

// COMPAT(pluginReactNativeEntrypoint): added in v0.9.59, remove after 2027-04-20.
export const pluginReactNativeRuntime = {
  ...pluginUiRuntime,
  Icon,
  Modal,
  ScrollView,
  FlatList,
  TextInput,
  copyText,
  useRevealedText,
  useToast,
};
