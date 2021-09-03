const path = require("path");
const os = require("os");

const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const DB_PATH = path.join(getScriptFolder(), "mpvremote", "remote.db");

let db;

// Get scripts folder
function getScriptFolder() {
  let mpvHome;

  if (os.platform() === "win32") {
    // TODO Get appdata
    mpvHome =
      process.env["MPV_HOME"] ||
      path.join(os.homedir(), "AppData", "Roaming", "mpv");
  } else {
    mpvHome = process.env["MPV_HOME"];
    if (!mpvHome) {
      const xdgConfigHome =
        process.env["XDG_CONFIG_HOME"] || `${os.homedir()}/.config`;
      mpvHome = path.join(xdgConfigHome, "mpv");
    }
  }

  return path.join(mpvHome, "scripts");
}

async function init_tables() {
  // Collections
  // TYPE Can be: Movies - 1, TVShows - 2, Music - 3
  await db.exec(
    `CREATE TABLE IF NOT EXISTS collection(
        id INTEGER PRIMARY KEY ASC, name TEXT NOT NULL, type INTEGER NOT NULL
      )`
  );

  // Collection entry
  await db.exec(
    `CREATE TABLE IF NOT EXISTS collection_entry(
        id INTEGER PRIMARY KEY ASC,
        collection_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        CONSTRAINT fk_collection
          FOREIGN KEY (collection_id)
          REFERENCES collection(id)
          ON DELETE CASCADE
      )`
  );

  // Media status
  await db.exec(
    `CREATE TABLE IF NOT EXISTS mediastatus(
        id INTEGER PRIMARY KEY ASC,
        directory TEXT,
        file_name TEXT NOT NULL,
        current_time REAL,
        finished INTEGER
      )`
  );
}

async function initDB() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });
  await db.get("PRAGMA foreign_keys=on;");
  await init_tables();
}

async function getMediastatusEntries(filepath = null, directory = null) {
  /*
    filepath: Gets entry for a single file path
    directory: Gets entries for a directory
  */
  try {
    if (filepath != null) {
      // If last char is path.sep remove it
      if (filepath[filepath.length - 1] == path.sep)
        filepath = filepath.slice(0, -1);
      let spl = filepath.split(path.sep);
      const fileName = spl[spl.length - 1];
      spl.pop();

      const directory = spl.join(path.sep);
      return await db.get(
        "SELECT * FROM mediastatus WHERE directory=? AND file_name=? ORDER BY file_name",
        [directory, fileName]
      );
    } else if (directory != null) {
      // directory = directory.split(path.sep);
      if (directory[directory.length - 1] == path.sep)
        directory = directory.slice(0, -1);
      const entries = await db.all(
        "SELECT * FROM mediastatus WHERE directory=? ORDER BY file_name",
        [directory]
      );
      return entries;
    } else {
      return await db.all("SELECT * FROM mediastatus");
    }
  } catch (exc) {
    console.log(exc);
  }
}

async function createMediaStatusEntry(filepath, time, finished) {
  try {
    const statusEntry = await getMediastatusEntries(filepath);

    let spl = filepath.split(path.sep);
    const fileName = spl[spl.length - 1];
    spl.pop();

    const directory = spl.join(path.sep);

    // Update status
    if (statusEntry) {
      await db.run(
        "UPDATE mediastatus set current_time=?, finished=? WHERE directory=? AND file_name=?",
        [time, finished, directory, fileName]
      );
    } else {
      await db.run(
        "INSERT INTO mediastatus (current_time, finished, directory, file_name) VALUES (?, ?, ?, ?)",
        [time, finished, directory, fileName]
      );
    }
  } catch (exc) {
    console.log(exc);
  }
}

async function addMediaStatusEntry(filepath, time, percentPos) {
  /* 
  If percentPos 90% consider file finished
  If <= 5% don't save status to database.
  */
  let finished = 0;
  percentPos = parseFloat(percentPos);
  time = parseFloat(time);

  if (percentPos >= 90) finished = 1;
  else if (percentPos <= 5) return;

  await createMediaStatusEntry(filepath, time, finished);
  // Check if entry already exists
}

/*
  ***
    COLLECTIONS CRUD
  ***
*/

async function createCollection(data) {
  const dbres = await db.run(
    "INSERT INTO collection (name, type) VALUES (?, ?)",
    data.name,
    data.type || 1
  );

  // Get new object
  let collection = await db.get(
    "SELECT * FROM collection WHERE id=?",
    dbres.lastID
  );
  collection.paths = [];
  if (data.paths && data.paths.length > 0) {
    data.paths.forEach(async (element) => {
      // Add path
      const entryRes = await db.run(
        "INSERT INTO collection_entry (collection_id, path) VALUES (?, ?)",
        collection.id,
        element.path
      );
      // Get path
      const entry = await db.get(
        "SELECT * FROM collection_entry WHERE id=?",
        entryRes.lastID
      );
      collection.paths.push(entry);
    });
  }

  return collection;
}

async function getCollections(id = null) {
  if (id) {
    let collection = await db.get("SELECT * FROM collection WHERE id=?", id);

    if (collection) {
      collection.paths = await getCollectionEntries(collection.id);
      return collection;
    } else {
      return null;
    }
  } else {
    let collections = await db.all("SELECT * FROM collection");
    return collections;
  }
}

async function updateCollection(id, data) {
  let collection = await db.get("SELECT * FROM collection WHERE id=?", id);
  // TODO Raise an error
  if (!collection) res.status(404);

  // Update collection
  await db.run(
    "UPDATE collection SET name=COALESCE(?,name), type=COALESCE(?, type) WHERE id=?",
    [data.name, data.type, id]
  );

  // Update paths
  if (data.paths) {
    data.paths.forEach(async (element) => {
      // Add collection entry
      if (!element.id) {
        await db.run(
          "INSERT INTO collection_entry (collection_id, path) VALUES (?, ?)",
          collection.id,
          element.path
        );
      }
      // Update path
      else {
        await db.run(
          "UPDATE collection_entry SET path=COALESCE(?, path) WHERE id=?",
          [element.path, element.id]
        );
      }
    });
  }
  return await getCollections(id);
}

async function deleteCollection(id) {
  await db.run("DELETE FROM collection WHERE id=?", id);
}

/*
  ***
  COLLECTION ENTIRES CRUD
  ***
*/
async function createCollectionEntry(collection_id, data) {
  const dbres = await db.run(
    "INSERT INTO collection_entry (collection_id, path) VALUES (?, ?)",
    collection_id,
    data.path
  );
  const collection_entry = await db.get(
    "SELECT * FROM collection_entry WHERE id=?",
    dbres.lastID
  );
  return collection_entry;
}

async function getCollectionEntries(collection_id) {
  return await db.all(
    "SELECT * FROM collection_entry WHERE collection_id=?",
    collection_id
  );
}

async function deleteCollectionEntry(id) {
  await db.run("DELETE FROM collection_entry WHERE id=?", id);
}

exports.initDB = initDB;
// Media status entries
exports.addMediaStatusEntry = addMediaStatusEntry;
exports.getMediastatusEntries = getMediastatusEntries;

// Collections
exports.createCollection = createCollection;
exports.getCollections = getCollections;
exports.updateCollection = updateCollection;
exports.deleteCollection = deleteCollection;

// Collection Entries
exports.createCollectionEntry = createCollectionEntry;
exports.getCollectionEntries = getCollectionEntries;
exports.deleteCollectionEntry = deleteCollectionEntry;