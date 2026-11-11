# Recover desktop data when PractiQ cannot start

Use this procedure on macOS when PractiQ cannot open its current database, for example after a `file is not a database` error. It preserves the complete damaged directory and restores a valid study-data backup into a separate, empty directory. It does not repair the damaged database or recover changes made after that backup.

If the app still opens and only images or audio are damaged, use [Repair resources and restore backup](question-bank-package.md#difference-from-study-data-backups) instead.

## Preserve the failed installation's data

1. Quit PractiQ and stop any `make app-dev` or `tauri dev` process. In Activity Monitor, confirm that no PractiQ process remains before moving data. Do not attempt recovery while another instance is writing.
2. In Finder, choose **Go → Go to Folder** and enter `~/Library/Application Support/com.practiq.desktop/`. The current app's data is in `v4/`; leave older version directories untouched. If this directory is absent, stop and locate the data directory for the build you used rather than creating or renaming another version.
3. Rename the **entire** `v4` directory to a unique name such as `v4-damaged-20261031-143000`, in the same parent directory. Keep every file and subdirectory, including hidden files, `practiq.sqlite`, its `-journal`, `-wal` and `-shm` files if present, `service-settings-v1.sqlite` and its journals, `assets/`, and `recoveries/`. A pending restore record is inside the settings sidecar; keep it with that database generation.
4. Confirm that the renamed directory contains the original files and that no directory named `v4` remains. Keep a second complete copy on reliable storage before attempting manual database repairs. If moving or copying reports an error, stop and preserve the available bytes before continuing.

Do not delete journals, clear a pending restore record, edit schema versions or copy only the main SQLite file. Do not open the preserved directory with an app or repair tool that could modify it. It is retained evidence for manual recovery, not an ordinary backup ZIP. Leave macOS Keychain credentials untouched.

## Restore into a new directory

1. Start PractiQ normally. It creates a new, empty `v4/` directory using the supported database schema. The renamed damaged directory remains separate. Do not copy its settings sidecar, journals or individual resource files into the new directory.
2. Open **Settings → Import and restore → Restore study-data backup**. Select a valid full study-data backup and confirm replacement of the new directory's data. A question-bank ZIP imports banks only; it cannot restore answers or practice history.
3. If the backup is rejected, retain the error and choose another compatible backup. The current format is backup version 4 with database schema 11, subject to the [documented size and validation limits](question-bank-package.md#difference-from-study-data-backups). Do not change its manifest or disable validation to force an older or damaged backup through. A rejected backup leaves the new directory usable and the preserved damaged directory untouched.
4. Verify your banks, a saved practice session, scores, images and listening audio. Check the restored grading connection settings before explicitly grading again. Backups exclude credentials and AI task state; this procedure makes no model requests.
5. Export a fresh full backup to a location outside the application-data directory. Keep the original backup and preserved damaged directory until you have verified the recovered data and any later records have been salvaged separately.

Without a valid supported backup, the preserved directory may still be useful for manual diagnosis, but this procedure cannot reconstruct its records. Keep it intact; reinstallation, an empty database or a bank ZIP does not restore lost practice history.
