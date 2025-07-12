import { createMimeMessage } from "mimetext";
import PostalMime from "postal-mime";

const msg = createMimeMessage();
msg.setSender({ addr: "john.doe@example.com", name: "John Doe" });
msg.setRecipient("jane.doe@example.com");
msg.setSubject("Hello, world!");
msg.addMessage({
  contentType: "text/plain",
  data: "Hello, world!"
});

const raw = msg.asRaw();

console.log(raw);

const parsed = await PostalMime.parse(raw);
console.log(parsed);
