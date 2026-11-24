# xAI collections

PAL treats xAI collections as persistent cloud storage attached explicitly to one xAI conversation. Collection management uses `https://management-api.x.ai/v1/` and a separately permissioned Management API key. File upload, inference, collection search, and the Responses `file_search` tool continue to use the named account's ordinary xAI API key at `https://api.x.ai`.

Create a Management key in the xAI Console with the required Collections Endpoint permissions, including `AddFileToCollection` for adding uploaded files. Store it in PAL's private credential store as `xai_management`; never put it in session options, transcripts, SQLite collection rows, exports, or mobile snapshots. Named xAI accounts need separate references (`connection:<id>:xai-management`) so changing one account cannot authorize another.

Only an active, owner-controlled xAI conversation can manage or attach a collection. Adding a document accepts a broker-issued original-file handle, not a path or caller-supplied xAI file ID. PAL resolves the handle again after approval, checks that it is the current xAI account's uploaded PDF and that its Workbench policy still permits cloud processing, then asks the Management API to add that provider file. Removing a document only removes it from the collection; the original provider file retains its own deletion lifecycle.

Collection search is off unless the collection is explicitly attached to the conversation and the `collectionSearch` provider option is enabled. PAL emits the Responses-compatible tool `{ "type": "file_search", "vector_store_ids": [...], "max_num_results": 10 }`. Every use rechecks the conversation, named connection revision, ordinary API-key revision, and Management-key revision. Changing or revoking either credential makes the attachment stale until the owner reviews it again.

The broker operations are create, list, add/remove document, attach/detach, and delete. Mutations require explicit owner acknowledgement and approval. xAI currently permits files up to 100 MB, but PAL's original PDF handle keeps PAL's stricter 16 MiB upload bound.

Official references: [Collections API](https://docs.x.ai/developers/files/collections/api), [Collections management REST API](https://docs.x.ai/developers/rest-api-reference/collections/collection), [Collections Search tool](https://docs.x.ai/developers/tools/collections-search), and [Management API keys](https://docs.x.ai/developers/management-api-guide).
