import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail, id, now } from './validation.js';

export const CAREER_MIGRATIONS = [{ version: 1, sql: `
CREATE TABLE materials(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('resume','job','company','experience')),created_at TEXT NOT NULL);
CREATE TABLE versions(id TEXT PRIMARY KEY,material_id TEXT NOT NULL REFERENCES materials(id),revision INTEGER NOT NULL CHECK(revision>0),text TEXT NOT NULL,hash TEXT NOT NULL CHECK(length(hash)=64),source_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(material_id,revision));
CREATE TABLE confirmations(version_id TEXT PRIMARY KEY REFERENCES versions(id),confirmed_at TEXT NOT NULL);
CREATE TABLE goals(id TEXT PRIMARY KEY,title TEXT NOT NULL,company TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','archived')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE goal_materials(goal_id TEXT NOT NULL REFERENCES goals(id),version_id TEXT NOT NULL REFERENCES versions(id),kind TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(goal_id,kind));
CREATE TABLE conversations(id TEXT PRIMARY KEY,goal_id TEXT REFERENCES goals(id),session_id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('chat','interview')),created_at TEXT NOT NULL);
CREATE TABLE runs(id TEXT PRIMARY KEY,task TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),input_hash TEXT NOT NULL,input_json TEXT NOT NULL,prompt_version TEXT NOT NULL,rubric_version TEXT,provider TEXT,model TEXT,usage_json TEXT,result_hash TEXT,error_code TEXT,created_at TEXT NOT NULL,finished_at TEXT);
CREATE TABLE artifacts(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('assessment','rewrite','report')),run_id TEXT NOT NULL REFERENCES runs(id),data_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE rewrite_acceptances(rewrite_id TEXT NOT NULL REFERENCES artifacts(id),selection_hash TEXT NOT NULL,version_id TEXT NOT NULL REFERENCES versions(id),item_ids_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(rewrite_id,selection_hash));
CREATE TABLE interviews(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),version_id TEXT NOT NULL REFERENCES versions(id),session_id TEXT NOT NULL UNIQUE REFERENCES conversations(session_id),status TEXT NOT NULL CHECK(status IN ('active','paused','completed')),data_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX versions_material ON versions(material_id,revision);
CREATE INDEX runs_created ON runs(created_at);
CREATE INDEX artifacts_kind ON artifacts(kind,created_at);
CREATE TRIGGER immutable_versions_update BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'immutable_version'); END;
CREATE TRIGGER immutable_versions_delete BEFORE DELETE ON versions BEGIN SELECT RAISE(ABORT,'immutable_version'); END;
CREATE TRIGGER immutable_artifacts_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT,'immutable_artifact'); END;
CREATE TRIGGER immutable_artifacts_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT,'immutable_artifact'); END;
` }, { version: 2, sql: `
ALTER TABLE conversations ADD COLUMN context_state TEXT NOT NULL DEFAULT 'legacy-unbound' CHECK(context_state IN ('legacy-unbound','frozen'));
ALTER TABLE conversations ADD COLUMN goal_snapshot_json TEXT;
CREATE TABLE conversation_materials(conversation_id TEXT NOT NULL REFERENCES conversations(id),version_id TEXT NOT NULL REFERENCES versions(id),kind TEXT NOT NULL,PRIMARY KEY(conversation_id,kind));
CREATE TRIGGER immutable_conversation_materials_update BEFORE UPDATE ON conversation_materials BEGIN SELECT RAISE(ABORT,'immutable_conversation_material'); END;
CREATE TRIGGER immutable_conversation_materials_delete BEFORE DELETE ON conversation_materials BEGIN SELECT RAISE(ABORT,'immutable_conversation_material'); END;
` }, { version: 3, sql: `
CREATE TABLE realtime_calls(id TEXT PRIMARY KEY,interview_id TEXT NOT NULL REFERENCES interviews(id),epoch INTEGER NOT NULL CHECK(epoch>0),status TEXT NOT NULL CHECK(status IN ('active','paused','failed','ended')),provider TEXT NOT NULL,model TEXT NOT NULL,created_at TEXT NOT NULL,ended_at TEXT,reason TEXT,UNIQUE(interview_id,epoch));
CREATE UNIQUE INDEX realtime_single_active ON realtime_calls(interview_id) WHERE status='active';
CREATE TABLE realtime_events(id TEXT PRIMARY KEY,call_id TEXT NOT NULL REFERENCES realtime_calls(id),event_key TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('user','assistant')),text TEXT NOT NULL,text_hash TEXT NOT NULL,question_id TEXT,data_json TEXT NOT NULL,created_at TEXT NOT NULL,mirrored_at TEXT,UNIQUE(call_id,event_key));
CREATE INDEX realtime_events_call ON realtime_events(call_id,created_at,id);
CREATE TRIGGER immutable_realtime_event BEFORE UPDATE OF call_id,event_key,role,text,text_hash,question_id,data_json ON realtime_events BEGIN SELECT RAISE(ABORT,'immutable_realtime_event'); END;
CREATE TRIGGER immutable_realtime_event_delete BEFORE DELETE ON realtime_events BEGIN SELECT RAISE(ABORT,'immutable_realtime_event'); END;
` }];

function checkedDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('STORAGE_DIRECTORY_REQUIRED');
  const resolved = path.resolve(directory);
  let current = path.parse(resolved).root;
  for (const part of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()
      || path.relative(current, fs.realpathSync.native(current)) !== '') fail('STORAGE_DIRECTORY_INVALID');
  }
  return resolved;
}

export function openStore(directory) {
  const file = path.join(checkedDirectory(directory), 'career.sqlite');
  const ownerFile = `${file}.owner`;
  const token = id();
  function acquire() {
    try { fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(ownerFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) fail('STORAGE_OWNER_INVALID');
      let prior;
      try { prior = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); }
      catch { fail('STORAGE_BUSY'); }
      if (!Number.isSafeInteger(prior.pid) || prior.pid < 1) fail('STORAGE_OWNER_INVALID');
      let gone = false;
      try { process.kill(prior.pid, 0); }
      catch (probe) { if (probe.code === 'ESRCH') gone = true; }
      if (!gone) fail('STORAGE_BUSY');
      const after = fs.lstatSync(ownerFile);
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs) fail('STORAGE_BUSY');
      fs.unlinkSync(ownerFile);
      try { fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); }
      catch (retry) { if (retry.code === 'EEXIST') fail('STORAGE_BUSY'); throw retry; }
    }
  }
  function release() {
    if (!fs.existsSync(ownerFile)) return;
    const stat = fs.lstatSync(ownerFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return;
    const current = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    if (current.token === token) fs.unlinkSync(ownerFile);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const entry = file + suffix;
    if (fs.existsSync(entry)) {
      const stat = fs.lstatSync(entry);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('STORAGE_FILE_INVALID');
    }
  }
  acquire();
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);');
    const current = db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get().version;
    if (current > CAREER_MIGRATIONS.at(-1).version) fail('STORAGE_NEWER_VERSION');
    for (const migration of CAREER_MIGRATIONS) {
      if (migration.version <= current) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(migration.version, now());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    // Accepted/running model work is never silently resent after restart.
    db.prepare("UPDATE runs SET status='interrupted',error_code='PROCESS_RESTARTED',finished_at=? WHERE status='running'").run(now());
    db.prepare("UPDATE interviews SET status='paused',updated_at=? WHERE status='active'").run(now());
    db.prepare("UPDATE realtime_calls SET status='paused',reason='PROCESS_RESTARTED',ended_at=? WHERE status='active'").run(now());
  } catch (error) { db?.close(); release(); throw error; }
  return {
    db,
    transaction(operation) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = operation(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { try { db.close(); } finally { release(); } },
  };
}
