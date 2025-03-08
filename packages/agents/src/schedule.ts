function getPrompt(event: { date: Date; input: string }) {
  return `
Today is ${event.date.toUTCString()}.
You are given a string that has a string and probably has a date/time/cron pattern to be input as an object into a scheduler.

Here is the string:
${event.input}
`;
}
