export type IncomingMessage =
  | {
      type: "schedule";
      input: string;
    }
  | {
      type: "delete-schedule";
      id: string;
    };

export type OutgoingMessage =
  | {
      type: "schedules";
      data: ScheduledItem[];
    }
  | {
      type: "run-schedule";
      data: ScheduledItem;
    }
  | {
      type: "error";
      data: string;
    }
  | {
      type: "schedule";
      data: ScheduledItem;
    };

export type ScheduledItem = {
  id: string;
  type: "cron" | "scheduled" | "delayed" | "interval";
  trigger: string;
  nextTrigger: string;
  description: string;
};
