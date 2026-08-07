import { Command } from "commander";

export function createSpeechCommand(): Command {
  return new Command("speech").description("Speech commands");
}
