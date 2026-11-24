# Importing PyGPT provider settings

PAL imports PyGPT JSON as inert data. It does not execute Python values, environment expressions, tools, plug-ins, add-ons, or arbitrary keyword arguments.

## Preview first

Every import starts with `connections.importPreview`. The preview lists the named accounts PAL can create, duplicate accounts, fields it cannot map, migration notices, and the number of credentials detected. Importing credentials is off by default. A normal apply creates only the reviewed account records; API keys remain unset.

PAL understands current PyGPT `providers` entries, `api_custom_providers`, and the legacy flat `api_key_*` / `api_endpoint_*` fields for supported providers. Ordinary PyGPT application preferences are ignored rather than reported as thousands of provider warnings. `app.env` is always excluded.

## Optional credential import

Credential import is a separate, explicit choice:

1. Request a preview with `includeSecrets: true`.
2. Show the returned credential targets to the owner. The preview identifies the account, provider, key type, source field, and whether the target is new or existing. It never returns a key value.
3. Apply the exact same JSON and preview digest with `includeSecrets: true` and `acknowledgeSecrets: true`.

Only non-empty literal strings without whitespace, environment placeholders, command substitutions, or file references are eligible. Unknown providers and unsafe values are reported as skipped. PAL never evaluates a value to obtain a secret.

Imported keys are written only to the owner-private credential file. Shared SQLite state contains account metadata and opaque credential references, never key material. Each key is bound to the named account's exact destination, variant, deployment, API version, and authentication mode. A compatible endpoint key is bound to its origin. Changing or selecting another account cannot reuse it.

xAI's management key is treated as a distinct credential from its inference API key and is bound to the reviewed xAI account. It is sent only to the xAI management API.

Applying accounts and credential references is transactional. If account creation or commit fails, PAL restores the previous private credential references and rolls back the account changes. Retrying requires a new preview if the JSON or selection changes.

## Supported safety boundaries

- Import files must be JSON and are limited to the broker's bounded import size.
- Secrets never appear in generated preview or apply responses, snapshots, or the shared database.
- Duplicate account targets are shown before apply; an explicitly selected credential can update the matching named account only.
- Provider options that have no safe PAL mapping remain visible as unmapped fields and are not silently enabled.
- Keep the original PyGPT file private: the request body itself may contain credentials even though PAL does not return or persist that body in shared state.

PAL records recognized retired model selections with their original setting paths. The preview shows the suggested Perplexity Agent preset for each Sonar selection. The named account starts without a replacement model. Choose the reviewed model or effort when creating its first conversation. Reimporting the same settings preserves one migration record per selection. **Settings › Connections** lists the records; the broker exposes them through `connections.importMigrations`.
