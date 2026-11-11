import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunRecord, RunStore } from '../../core/src/types.ts';
export class Store implements RunStore {
  private db:Database.Database;
  constructor(path:string){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new Database(path);this.db.pragma('journal_mode = WAL');this.db.exec('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)');}
  save(run:RunRecord){this.db.prepare('INSERT INTO runs(id,created_at,status,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(run.id,run.createdAt,run.status,JSON.stringify(run));}
  get(id:string):RunRecord|undefined{const row=this.db.prepare('SELECT data FROM runs WHERE id=?').get(id) as {data:string}|undefined;return row?JSON.parse(row.data):undefined;}
  list():RunRecord[]{return (this.db.prepare('SELECT data FROM runs ORDER BY created_at DESC').all() as {data:string}[]).map(r=>JSON.parse(r.data));}
  close(){this.db.close();}
}
