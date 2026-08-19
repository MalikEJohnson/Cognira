import "dotenv/config";
import { listContactMessages } from "./db.js";

/**
 * Reads the contact form's inbox.
 *
 *   npm run messages
 *
 * Messages are stored in the database rather than emailed, so there is no mail
 * provider to configure and nothing silently fails in the background.
 */

const messages = listContactMessages();

if (messages.length === 0) {
  console.log("\nNo messages yet.\n");
} else {
  console.log(`\n${messages.length} message(s), newest first\n`);

  for (const m of messages) {
    console.log("=".repeat(66));
    console.log(`From    ${m.name} <${m.email}>`);
    console.log(`Sent    ${new Date(m.createdAt).toLocaleString()}`);
    if (m.wallet) console.log(`Wallet  ${m.wallet}`);
    console.log("-".repeat(66));
    console.log(m.message);
    console.log("");
  }
}
