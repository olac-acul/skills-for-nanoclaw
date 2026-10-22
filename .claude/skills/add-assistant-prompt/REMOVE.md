# Remove the assistant prompt

1. Revert the two edits in `container/agent-runner/src/providers/opencode-config.ts`, before deleting the files (it imports `assistant-prompt.ts`, and the agent would no longer start):
   - delete the line `import { asAssistant } from '../assistant-prompt.js';`
   - `OPENCODE_CONFIG_CONTENT: JSON.stringify(asAssistant(config)),` becomes `OPENCODE_CONFIG_CONTENT: JSON.stringify(config),`

   Or `git checkout` that file if your tree was clean when they were applied.
2. Delete the copied files:

```text files
container/agent-runner/src/assistant-prompt.md
container/agent-runner/src/assistant-prompt.test.ts
container/agent-runner/src/assistant-prompt.ts
scripts/assistant-prompt-seams.mjs
```

3. Delete any `groups/<folder>/assistant-prompt.md` you wrote.
4. Restart NanoClaw (or each group): the agents get OpenCode's own prompt and tools back.
