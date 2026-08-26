const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const errorsPage = fs.readFileSync(path.join(root, 'src', 'pages', 'ErrorsPage.tsx'), 'utf8');
const adminSupabase = fs.readFileSync(path.join(root, 'src', 'lib', 'adminSupabase.ts'), 'utf8');

assert.ok(errorsPage.includes('const PRIMARY_SOURCE_ROW_LIMIT = 250;'), 'ErrorsPage initial source rows should stay capped for fast local loading');

const initialExecutionSelect = errorsPage.match(/from\('trade_execution_logs'\)\s*\.select\('([^']+)'\)\s*\.in\('status'/s)?.[1] ?? '';
assert.ok(initialExecutionSelect, 'Initial execution-log select should be found');
assert.ok(!initialExecutionSelect.includes('request_payload'), 'Initial execution-log list query must not fetch request_payload');
assert.ok(!initialExecutionSelect.includes('response_payload'), 'Initial execution-log list query must not fetch response_payload');

const initialSignalSelect = errorsPage.match(/from\('signals'\)\s*\.select\('([^']+)'\)\s*\.eq\('status', 'failed'\)/s)?.[1] ?? '';
assert.ok(initialSignalSelect, 'Initial signal select should be found');
assert.ok(!initialSignalSelect.includes('raw_message'), 'Initial signal list query must not fetch raw_message');

const initialDeadLetterSelect = errorsPage.match(/from\('signal_queue_dead_letters'\)\s*\.select\('([^']+)'\)\s*\.neq\('status', 'replayed'\)/s)?.[1] ?? '';
assert.ok(initialDeadLetterSelect, 'Initial dead-letter select should be found');
assert.ok(!initialDeadLetterSelect.includes('payload'), 'Initial dead-letter list query must not fetch payload');

assert.ok(!errorsPage.includes('visibleSignalIdsNeedingEvidence'), 'Visible-row linked-log enrichment must not run automatically after list load');
assert.ok(errorsPage.includes('selectedError && itemNeedsLinkedExecutionEvidence'), 'Selected modal enrichment should remain available');

assert.ok(adminSupabase.includes('displayNameCache'), 'Display names should be cached across polling loads');
assert.ok(adminSupabase.includes('DISPLAY_NAME_CACHE_TTL_MS'), 'Display-name cache should have an explicit TTL');
assert.ok(adminSupabase.includes('DISPLAY_NAME_CHUNK_SIZE'), 'Display-name lookup should be chunked');

console.log('errors page fast-load checks passed');
