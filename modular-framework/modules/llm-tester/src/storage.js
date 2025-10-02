import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const files = {
  tests: path.join(DATA_DIR, "tests.json"),
  suites: path.join(DATA_DIR, "suites.json"),
  runs: path.join(DATA_DIR, "runs.json"),
  webhooks: path.join(DATA_DIR, "webhooks.json")
};

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of Object.values(files)) {
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify([], null, 2));
  }
}
ensure();

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function write(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export const Storage = {
  // Tests
  listTests({ suite, tag, limit } = {}) {
    let items = read(files.tests);
    if (suite) items = items.filter(t => t.suite === suite);
    if (tag) items = items.filter(t => (t.tags || []).includes(tag));
    if (limit) items = items.slice(0, limit);
    return items;
  },
  getTest(id) {
    return read(files.tests).find(t => t.id === id);
  },
  saveTest(test) {
    const arr = read(files.tests);
    let existing = arr.find(t => t.id === test.id);
    if (!test.id) test.id = "t_" + crypto.randomUUID();
    if (existing) {
      test.version = (existing.version || 0) + 1;
      Object.assign(existing, test);
    } else {
      test.version = 1;
      arr.push(test);
    }
    write(files.tests, arr);
    return test;
  },
  // Suites
  listSuites() {
    return read(files.suites);
  },
  saveSuite(suite) {
    const arr = read(files.suites);
    if (!suite.name) throw new Error("suite.name required");
    const existing = arr.find(s => s.name === suite.name);
    if (existing) {
      Object.assign(existing, suite);
    } else {
      arr.push(suite);
    }
    write(files.suites, arr);
    return suite;
  },
  // Runs
  listRuns(limit = 50) {
    const arr = read(files.runs).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    return arr.slice(0, limit);
  },
  getRun(runId) {
    return read(files.runs).find(r => r.runId === runId);
  },
  saveRun(run) {
    const arr = read(files.runs);
    arr.push(run);
    write(files.runs, arr);
    return run;
  },
  // Webhooks
  addWebhook(hook) {
    const arr = read(files.webhooks);
    hook.id = "wh_" + crypto.randomUUID();
    arr.push(hook);
    write(files.webhooks, arr);
    return hook;
  },
  listWebhooks() {
    return read(files.webhooks);
  }
};
