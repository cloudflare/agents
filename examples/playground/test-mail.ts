import PostalMime from "postal-mime";
import { createMimeMessage } from "mimetext";

const msg = createMimeMessage();
msg.setSender({ name: "John Doe", addr: "john.doe@example.com" });
msg.setRecipient("jane.doe@example.com");
msg.setSubject("Hello, world!");
msg.addMessage({
  contentType: "text/plain",
  data: "Hello, world!",
});

const raw = msg.asRaw();

console.log(raw);

const parsed = await PostalMime.parse(raw);
console.log(parsed);
