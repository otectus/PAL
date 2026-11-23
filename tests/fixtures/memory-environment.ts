// A temporary SQLite profile still uses the broker's default projection endpoints.
// Fixture tests that exercise a projection supply their own local server.
for (const prefix of ['PAL', 'CERE']) {
  for (const key of ['MEMORY_CREDENTIALS_FILE', 'NEO4J_PASSWORD', 'QDRANT_API_KEY'])
    delete process.env[prefix + '_' + key];
}
process.env.PAL_NEO4J_URI = 'bolt://127.0.0.1:9';
process.env.PAL_QDRANT_URL = 'http://127.0.0.1:9';
