LLM Workflows module

- Start server:
  npm start
  Defaults to port 3005. UI at http://localhost:3005

- It expects llm-chat to be running at http://localhost:3004 (default) unless LLM_CHAT_URL is set.
  You do not need to provide model credentials here if your workflow overrides include those.

- Execution is disabled by default. To allow actual execution on the host, set:
  export ALLOW_DANGEROUS=true
  and uncheck "Dry-run" and check "Allow execution" in the tester.
  All execution happens in a temp sandbox directory under /tmp.

- Workflow JSON schema defines the expected output. Default schema supports actions:
  - bash: { type, name?, cmd, cwd? }
  - python: { type, name?, script, cwd? }
  - file: { type, name?, path, content }
  - note: { type, name?, content }

Notes and usage:
- Use {{input}} placeholder in the prompt template.
- Provide examples as pure JSON blocks (no backticks). Separate multiple examples with a line of --- between blocks.
- The tester streams:
  - llm.delta for token deltas
  - parse.result when JSON is parsed
  - actions.summary listing all actions
  - exec.stdout/exec.stderr during execution (if enabled)
  - exec.event for other events
  - error on failures

Security:
- Even with ALLOW_DANGEROUS=true, this runs on your machine. Use only on isolated test environments.


How it works
- Builder UI lets you craft a strict JSON-only prompt, schema, and examples.
- On Run Test, the backend streams from llm-chat, assembles full output, parses and validates JSON using AJV, then executes if allowed.
- Actions run in an ephemeral directory via bash/python, or file writes are constrained to this sandbox.

Integration with llm-chat
- The module posts to llm-chat /api/chat, sending provider/baseUrl/apiKey/model from the workflow overrides. You can copy the values from llm-chat’s settings. The UI tries to prefill from llm-chat’s localStorage if on the same origin.

————————

You can now:
- Start llm-chat (default port 3004)
- Start llm-workflows (default port 3005)
- Open http://localhost:3005, create a workflow, test it, and capture JSON-defined commands/scripts/files.