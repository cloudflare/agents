import * as z from "zod/mini";

z.config(z.locales.en());

export const TODO_TEXT_MAX_LENGTH = 200;

export const todoTextSchema = z
  .string()
  .check(
    z.trim(),
    z.minLength(1, "Todo text is required."),
    z.maxLength(
      TODO_TEXT_MAX_LENGTH,
      `Todo text must be ${TODO_TEXT_MAX_LENGTH} characters or fewer.`
    ),
    z.describe("The todo text, between 1 and 200 characters.")
  );

export const todoIdSchema = z
  .string()
  .check(
    z.minLength(1, "A todo ID is required."),
    z.describe("The opaque todo ID returned by list_todos or add_todo.")
  );

export const todoSchema = z.object({
  id: todoIdSchema,
  text: todoTextSchema,
  completed: z.boolean(),
  createdAt: z.string()
});

export const storedTodosSchema = z.array(todoSchema);

export const listTodosArgsSchema = z.object({
  status: z.optional(
    z
      .enum(["all", "active", "completed"])
      .check(z.describe("Which todos to return. Defaults to all."))
  )
});

export const renameTodoArgsSchema = z.object({
  id: todoIdSchema,
  text: todoTextSchema
});

export const setTodoCompletedArgsSchema = z.object({
  id: todoIdSchema,
  completed: z
    .boolean()
    .check(z.describe("True to complete the todo; false to make it active."))
});

export const deleteTodoArgsSchema = z.object({
  id: todoIdSchema
});

// Generate the JSON Schemas agents discover from the same contracts used to
// validate tool calls at runtime.
export const toolInputSchemas = {
  listTodos: z.toJSONSchema(listTodosArgsSchema, {
    target: "draft-07",
    io: "input"
  }),
  renameTodo: z.toJSONSchema(renameTodoArgsSchema, {
    target: "draft-07",
    io: "input"
  }),
  setTodoCompleted: z.toJSONSchema(setTodoCompletedArgsSchema, {
    target: "draft-07",
    io: "input"
  }),
  deleteTodo: z.toJSONSchema(deleteTodoArgsSchema, {
    target: "draft-07",
    io: "input"
  })
} as const;

export type Todo = z.infer<typeof todoSchema>;
export type TodoStatus = "all" | "active" | "completed";

export function parseArgs<Schema extends z.ZodMiniType>(
  schema: Schema,
  input: unknown
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(z.prettifyError(result.error));
  }
  return result.data;
}
