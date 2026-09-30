import { validateDatabaseTree } from './database-migrations.mjs';

const result = validateDatabaseTree(process.cwd());
console.log(JSON.stringify({
	ok: true,
	format: result.database.format,
	migrationCount: result.database.migrationCount,
	totalBytes: result.totalBytes
}, null, 2));
