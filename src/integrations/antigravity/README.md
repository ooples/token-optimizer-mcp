Antigravity deferred context uses its `PreInvocation` hook, whose response accepts
`injectSteps: [{ ephemeralMessage: "..." }]`. Configure that lifecycle event to
execute `node <absolute-installed-package-path>/integrations/antigravity/pre-invocation.mjs`.
Keep this entry in the installed package rather than copying it alone.

Send the same `conversationId` and transcript path used by tool hooks. The entry
drains the corresponding scoped context once, during the current session; tool
hooks retain deferred messages until this supported delivery event runs.

Structural `view_file_outline` and `view_code_item` calls keep their original source
paths. They are already bounded views and are not substituted with outline text files.
