import type { Thread } from "chat";

export type DemoThread = Thread<unknown, unknown>;

export interface Demo {
  id: string;
  label: string;
  run(thread: DemoThread): Promise<void>;
}
