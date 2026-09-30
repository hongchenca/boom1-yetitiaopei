const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.resolve(process.env.APP_DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const source = path.join(dataDir, 'telemetry-v1.db');
if (!fs.existsSync(source)) throw new Error(`数据库不存在：${source}`);
const output = path.resolve(process.argv[2] || path.join(dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
if (fs.existsSync(output)) throw new Error(`备份目标已存在：${output}`);
const db = new DatabaseSync(source);
db.exec(`VACUUM INTO '${output.replace(/'/g, "''")}'`);
db.close();
console.log(`一致性备份已生成：${output}`);
