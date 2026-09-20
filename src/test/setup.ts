// Supplies `indexedDB` and friends as globals, which is the only browser API
// the data layer touches. Imported once per test file by vitest.config.ts.
import 'fake-indexeddb/auto';
