import { requireNativeModule, type EventSubscription } from "expo-modules-core";

type HardwareKeyboardSubmitHandler = () => void;

interface JAgentDeskHardwareKeyboardModule {
  setHardwareKeyboardSubmitEnabled(enabled: boolean): void;
  addListener(
    eventName: "onHardwareKeyboardSubmit",
    handler: HardwareKeyboardSubmitHandler,
  ): EventSubscription;
}

const module = requireNativeModule<JAgentDeskHardwareKeyboardModule>("JAgentDeskHardwareKeyboard");

export function setHardwareKeyboardSubmitEnabled(enabled: boolean) {
  module.setHardwareKeyboardSubmitEnabled(enabled);
}

export function addHardwareKeyboardSubmitListener(handler: HardwareKeyboardSubmitHandler) {
  return module.addListener("onHardwareKeyboardSubmit", handler);
}
