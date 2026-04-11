'use strict';

// ---------------------------------------------------------------------------
// Theme Snapshot Manager
//
// Before any file is modified, we snapshot its original content.
// Rollback restores every file in the snapshot to its original state.
// Snapshots are stored in the database — not in memory.
// ---------------------------------------------------------------------------

const { getAsset, putAsset, deleteAsset } = require('../../services/shopify-admin.service');

// ---------------------------------------------------------------------------
// captureSnapshot
// Reads the current content of all specified asset keys from the draft theme
// and saves them to the database as a ThemeSnapshot record.
// ---------------------------------------------------------------------------
async function captureSnapshot(prisma, store, themeId, themeName, assetKeys) {
  const files = {};
  const missing = []; // keys that don't exist yet (new files being created)

  for (const key of assetKeys) {
    try {
      const asset = await getAsset(store, themeId, key);
      files[key] = {
        existed: true,
        content: asset.value || null,         // text files
        attachment: asset.attachment || null,  // binary files (base64)
        contentType: asset.content_type,
      };
    } catch (err) {
      if (err.message.includes('404') || err.message.includes('Not Found')) {
        // File doesn't exist yet — record that so rollback can delete it
        files[key] = { existed: false, content: null };
        missing.push(key);
      } else {
        throw err;
      }
    }
  }

  const snapshot = await prisma.themeSnapshot.create({
    data: {
      storeId: store.id,
      themeId: String(themeId),
      themeName,
      files,
    },
  });

  return { snapshot, missing };
}

// ---------------------------------------------------------------------------
// rollback
// Restores every file in the snapshot to its original state.
// Files that didn't exist before the patch are deleted.
// Files that did exist are restored to their captured content.
// ---------------------------------------------------------------------------
async function rollback(prisma, store, snapshotId) {
  const snapshot = await prisma.themeSnapshot.findUnique({ where: { id: snapshotId } });
  if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);

  const results = [];
  const files = snapshot.files;

  for (const [key, entry] of Object.entries(files)) {
    try {
      if (!entry.existed) {
        // File was created by the patch — delete it on rollback
        await deleteAsset(store, snapshot.themeId, key);
        results.push({ key, action: 'deleted', ok: true });
      } else if (entry.content !== null) {
        // File existed — restore its original content
        await putAsset(store, snapshot.themeId, key, entry.content);
        results.push({ key, action: 'restored', ok: true });
      }
    } catch (err) {
      results.push({ key, action: 'failed', ok: false, error: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// describeSnapshot — returns a human-readable diff summary
// ---------------------------------------------------------------------------
function describeSnapshot(snapshot) {
  const files = snapshot.files;
  const created  = Object.entries(files).filter(([, v]) => !v.existed).map(([k]) => k);
  const modified = Object.entries(files).filter(([, v]) => v.existed).map(([k]) => k);

  return {
    snapshotId: snapshot.id,
    themeId: snapshot.themeId,
    themeName: snapshot.themeName,
    createdAt: snapshot.createdAt,
    willCreate: created,
    willModify: modified,
    totalFiles: Object.keys(files).length,
  };
}

module.exports = { captureSnapshot, rollback, describeSnapshot };
