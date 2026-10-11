import { HttpError } from '../../middleware/errors.js';
export function createController(context) {
  let lastManualBackupAt;
  const { now, backupStorage, backups } = context;
  return {
    getBackupsStatus: (_req, res) => res.json(backups.status()),
    getBackups: async (_req, res) => res.json(await backupStorage.listBackupMetadata()),
    postBackups: async (_req, res) => {
      const time = now().getTime();
      if (!backups.status().running && lastManualBackupAt !== undefined && time - lastManualBackupAt < 60_000)
        throw new HttpError(429, 'Please wait one minute before creating another database backup.');
      lastManualBackupAt = time;
      res.status(201).json(await backups.create());
    },
    getBackupsIdDownload: async (req, res) => {
      const filename = await backupStorage.getVerifiedDatabasePath(req.params.id);
      res.download(filename, `${req.params.id}.ejson`, (error) => {
        if (error && !res.headersSent)
          res.status(503).json({
            error: 'The verified backup could not be downloaded. Please retry.',
          });
      });
    },
    getBackupsIdManifest: async (req, res) => {
      const metadata = await backupStorage.verifyBackup(req.params.id);
      res.attachment(`${metadata.id}.manifest.json`).json({
        schemaVersion: metadata.schemaVersion,
        kind: 'venturecore-mongodb-backup',
        id: metadata.id,
        createdAt: metadata.createdAt,
        databaseVersion: metadata.databaseVersion,
        database: {
          file: 'database.ejson',
          byteLength: metadata.byteLength,
          sha256: metadata.sha256,
        },
      });
    },
  };
}
