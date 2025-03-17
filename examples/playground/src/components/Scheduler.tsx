import { useState } from "react";
import { useAgent } from "agents/react";
import type {
  IncomingMessage,
  OutgoingMessage,
  ScheduledItem,
} from "../shared";
import "./Schedule.css";

interface SchedulerProps {
  addToast: (message: string, type?: "success" | "error" | "info") => void;
}

export function Scheduler({ addToast }: SchedulerProps) {
  const agent = useAgent({
    agent: "scheduler",
    onMessage: (message) => {
      const parsedMessage = JSON.parse(message.data) as OutgoingMessage;
      if (parsedMessage.type === "schedules") {
        setScheduledItems(parsedMessage.data);
      } else if (parsedMessage.type === "run-schedule") {
        addToast(`Running schedule ${parsedMessage.data.description}`, "info");
        if (parsedMessage.data.type !== "cron") {
          // remove the schedule from the list
          setScheduledItems((items) =>
            items.filter((item) => item.id !== parsedMessage.data.id)
          );
        }
      } else if (parsedMessage.type === "error") {
        addToast(parsedMessage.data, "error");
      } else if (parsedMessage.type === "schedule") {
        setScheduledItems((items) => [...items, parsedMessage.data]);
      }
    },
  });

  const [scheduledItems, setScheduledItems] = useState<ScheduledItem[]>([]);
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    agent.send(
      JSON.stringify({
        type: "schedule",
        input: input,
      } satisfies IncomingMessage)
    );
    setInput("");
  };

  const handleDelete = (id: string) => {
    agent.send(
      JSON.stringify({
        type: "delete-schedule",
        id,
      } satisfies IncomingMessage)
    );
    setScheduledItems((items) => items.filter((item) => item.id !== id));
    addToast("Task removed", "info");
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="inputForm">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter your schedule in natural language..."
          className="scheduleInput"
        />
      </form>

      <div className="itemsList">
        {scheduledItems.map((item) => (
          <div key={item.id} className="scheduledItem">
            <div className="itemContent">
              <div className="itemDetails">
                <span className="trigger">Trigger: {item.trigger}</span>
                <span className="nextTrigger">
                  Next: {item.nextTrigger.toLocaleString()}
                </span>
                <span className="description">{item.description}</span>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(item.id)}
                className="deleteButton"
                aria-label="Delete item"
              >
                ⨉
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
