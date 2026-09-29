/**
 * Load and validate the Plivo credentials from .env for the deploy and dev
 * provisioning scripts.
 */

export interface PlivoEnv {
  authId: string;
  authToken: string;
  phoneNumber: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function requirePlivoEnv(): PlivoEnv {
  try {
    process.loadEnvFile(".env");
  } catch {
    fail("No .env file found. Copy .env.example to .env and fill it in.");
  }

  const authId = process.env.PLIVO_AUTH_ID;
  const authToken = process.env.PLIVO_AUTH_TOKEN;
  const phoneNumber = process.env.PLIVO_PHONE_NUMBER;
  if (!authId || !authToken || !phoneNumber) {
    fail(
      "Missing Plivo credentials in .env — need PLIVO_AUTH_ID, " +
        "PLIVO_AUTH_TOKEN, and PLIVO_PHONE_NUMBER."
    );
  }
  return { authId, authToken, phoneNumber };
}
