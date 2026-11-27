// Tests run inside agent sessions too. Never hand a spawned server the running session's inbox:
// a test handoff would start real turns in the agent that runs the tests. Tests that need an inbox set a fake one.
delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
