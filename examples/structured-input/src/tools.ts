import { tool } from "ai";
import { z } from "zod";

/**
 * Structured input tools — tools with no `execute` function.
 *
 * The model calls these to present structured UI to the user (multiple choice,
 * yes/no, free text, rating). The client renders appropriate interactive
 * components and sends the user's response back via `addToolOutput`.
 */

export const askMultipleChoice = tool({
  description:
    "Present the user with a multiple-choice question. " +
    "Use when you need the user to pick from specific options. " +
    "Set allowMultiple to true if the user can select more than one option.",
  inputSchema: z.object({
    question: z.string().describe("The question to ask"),
    options: z.array(z.string()).min(2).describe("The choices to present"),
    allowMultiple: z
      .boolean()
      .default(false)
      .describe("Whether the user can select multiple options")
  })
});

export const askYesNo = tool({
  description:
    "Ask the user a yes/no question. " +
    "Use for binary decisions, confirmations, or boolean preferences.",
  inputSchema: z.object({
    question: z.string().describe("The yes/no question to ask")
  })
});

export const askFreeText = tool({
  description:
    "Ask the user for free-form text input. " +
    "Use when you need an open-ended response like a name, description, or feedback.",
  inputSchema: z.object({
    question: z.string().describe("The question or prompt"),
    placeholder: z
      .string()
      .optional()
      .describe("Placeholder text for the input field"),
    multiline: z
      .boolean()
      .default(false)
      .describe("Whether to show a multi-line text area")
  })
});

export const askRating = tool({
  description:
    "Ask the user to rate something on a numeric scale. " +
    "Use for satisfaction, quality, priority, or intensity ratings.",
  inputSchema: z.object({
    question: z.string().describe("What to rate"),
    min: z.number().default(1).describe("Minimum value"),
    max: z.number().default(5).describe("Maximum value"),
    labels: z
      .object({
        low: z.string().optional(),
        high: z.string().optional()
      })
      .optional()
      .describe("Labels for the low and high ends of the scale")
  })
});

export const tools = {
  askMultipleChoice,
  askYesNo,
  askFreeText,
  askRating
};
