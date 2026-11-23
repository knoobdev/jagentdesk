import type { BotRoom } from "@jagentdesk/protocol/bots/types";
interface RoomDraft {
  name: string;
  memberBotIds: string[];
}
export class RoomFormModel {
  private listeners = new Set<() => void>();
  private state: RoomDraft;
  constructor(room: BotRoom | null) {
    this.state = { name: room?.name ?? "", memberBotIds: room?.memberBotIds ?? [] };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  setName(name: string) {
    this.state = { ...this.state, name };
    this.publish();
  }
  toggleMember(botId: string) {
    const previous = this.state.memberBotIds;
    const memberBotIds = previous.includes(botId)
      ? previous.filter((id) => id !== botId)
      : [...previous, botId];
    this.state = { ...this.state, memberBotIds };
    this.publish();
  }
  private publish() {
    for (const listener of this.listeners) listener();
  }
}
