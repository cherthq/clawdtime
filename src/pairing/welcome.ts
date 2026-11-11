/** One durable text contains the greeting and exact same-chat setup instruction. */
export function welcomeMessage(input: {
  origin: string;
  token: string;
  deviceId: string;
  displayId: string;
}) {
  const origin = new URL(input.origin);
  if (
    origin.origin !== input.origin ||
    origin.username ||
    origin.password ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(origin.hostname))
    )
  ) {
    throw new Error("Welcome links require an exact configured origin.");
  }
  const setup = `${input.origin}/setup#token=${encodeURIComponent(input.token)}&device=${encodeURIComponent(input.deviceId)}&display=${encodeURIComponent(input.displayId)}`;
  return `Hey! I'm ClawdTime. Your coding agent can FaceTime you when it needs a hand and show you your Mac's screen.\n\nPaste this into the Claude Code or Codex chat you're already using:\n\nSet up ClawdTime for this project. Follow ${input.origin}/agents using my setup link: ${setup}\n\nKeep using that same chat for setup. When you're ready, ask your agent for one test call.`;
}
