# Android practice app

PractiQ uses the same Tauri 2, React and Rust practice app on macOS, Windows and Android. Android adds narrow-screen navigation, 48px touch targets, dynamic viewport dialogs, native safe insets and Back handling. AI document upload, task progress and ZIP download belong to the independent service's Web frontend. Offline practice and local scoring need no service. Optional AI grading requires a reference answer or rubric and an explicit grading/retry action.

## Targets and prerequisites

The Android application ID is `com.practiq.android`. Minimum SDK is 26 (Android 8); compile and target SDK are 36. The download target is an arm64 APK. CI additionally builds x86_64 for an API 35 emulator. Declaring a minimum SDK does not establish acceptance on that OS or its oldest WebView.

Use Node.js 22.12+, the repository-pinned Rust toolchain, JDK 21, Android SDK platform/build-tools 36 and NDK `28.2.13676358`. Select your existing SDK and Java installations through `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME`; keep machine paths out of tracked Gradle files. The Gradle wrapper is pinned to 8.14.3 with its distribution SHA-256. Android host sources under `app/src-tauri/gen/android/` are tracked; build outputs and local SDK settings are ignored. Python 3.14+ is a notice/contract build tool, never an app runtime; do not create a project `.venv`.

The tracked Tauri 2.11.5 lifecycle replacement under `app/src-tauri/gen/android/patches/` rebinds system-result launchers when Android recreates the Activity. Gradle compiles that reviewed replacement instead of the original file; the Cargo cache stays unchanged. Runtime notice provenance binds the replacement source and the resulting local AAR. Keep this pinned patch and its source/license evidence synchronized when upgrading Tauri.

From the repository root, after installing the selected SDK components:

```sh
make install-locked AI_PYTHON=/absolute/path/to/python3.14
make app-install
rustup target add aarch64-linux-android x86_64-linux-android
cargo fetch --locked --manifest-path app/src-tauri/Cargo.toml
```

Linux may host Android builds or the independent service. There is no Linux practice-app target or DEB release asset.

## Develop and build

Run `make android-dev` with a selected emulator or device. This development command starts the app frontend and native Android host; it does not start an AI service or a model call.

A distributable APK must include exactly the generated `bundled/build-manifest.json` and `bundled/THIRD-PARTY.txt` resource leaves, with no Python or LibreOffice engine. Notices cover the locked Cargo/npm dependencies and the actual resolved Gradle runtime artifacts, POMs and source/license evidence. Gradle exports an inventory; package preparation verifies it against the committed Android runtime license lock before generating notices.

On a fresh checkout, bootstrap the generated Tauri Gradle settings and local Android AAR by compiling once without package resources:

```sh
(cd app && npm run tauri -- android build --debug --apk --split-per-abi --target aarch64 --ci --config '{"bundle":{"resources":[]}}')
```

This bootstrap APK is an incomplete build artifact and fails strict package checks. Do not distribute it. Export the actual arm64 runtime inventory and rebuild the complete APK:

```sh
app/src-tauri/gen/android/gradlew -p app/src-tauri/gen/android \
  :app:exportRuntimeNoticeInventory \
  -PpractiqNoticeConfiguration=arm64DebugRuntimeClasspath \
  -PpractiqNoticeOutput="$PWD/app/.build/android-runtime.json" --no-daemon
make android-build AI_PYTHON=/absolute/path/to/python3.14
make android-package-check AI_PYTHON=/absolute/path/to/python3.14
```

The split debug output is `app/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`; the package report defaults to `server/reports/checks/android-package.json`. `ANDROID_RUNTIME_INVENTORY`, `ANDROID_APK`, `ANDROID_AAPT2` and `ANDROID_PACKAGE_REPORT` can select explicit inventory, package, SDK tool and report paths. Inspect the report for version, application ID, native ABI, package resources, notices and absence of embedded engines. A debug keystore signature establishes no release-signing or clean-device acceptance. Release signing credentials remain outside the repository and require separate release verification.

## Files, backups and credentials

Question-bank ZIP import, study-data restore, bank export and backup creation begin with the Android system file picker. The app never asks the frontend to supply a file path or content URI. Inputs become bounded private snapshots before the existing ZIP, checksum and database validation; outputs are complete verified private ZIPs before copying to the selected destination. Write/sync failures are reported, but a provider may retain partial destination bytes; the app does not promise provider-level atomic replacement or rollback. Cancellation starts no import. Bank import appends content; restoring full study data asks for replacement confirmation. The same `v4/`, SQLite schema 11, ZIP version 2 and backup container version 4 apply. Older full backups are rejected without altering old directories.

The service URL remains in SQLite. Access tokens are encrypted using Android Keystore, with account-bound authenticated encryption and atomic private files under the no-backup directory. The private native bridge rejects frontend invocation. Android automatic backup and device-transfer backup are disabled; user-created study backups omit tokens and AI task state. Reinstalling or clearing app storage can remove local practice data and credentials, so export a study backup before doing either.

Android Back closes the current dialog or navigation drawer first. Unsaved editors retain the Continue editing/Discard changes confirmation. At the bank home page, Back backgrounds the app task. Leaving a practice route persists its draft; a failed save keeps the session visible. Timed exams retain their deadline across suspension or app closure and submit the last saved answers when reopened after expiry.

## Test the actual Android host

Run shared native/frontend checks and the touch-browser scenarios first:

```sh
make app-check AI_PYTHON=/absolute/path/to/python3.14
npm --prefix app run test:android-browser
```

Browser scenarios mock native commands; they do not validate a device file picker, Keystore or Android lifecycle. For native checks, start a selected arm64 API 35 emulator and finish the actual CLI APK build above. Gradle can then reuse that JNI artifact for Kotlin unit and instrumented tests:

```sh
app/src-tauri/gen/android/gradlew -p app/src-tauri/gen/android \
  :app:testArm64DebugUnitTest :app:connectedArm64DebugAndroidTest \
  -x rustBuildArm64Debug -PabiList=arm64-v8a -ParchList=arm64 \
  -PtargetList=aarch64 --no-daemon
```

Skipping the Rust hook is valid only after compiling the same source and target through the Tauri CLI. CI uses the corresponding x86_64 tasks after its actual x86_64 APK build. Preserve Gradle test reports and first failures; a successful test compile is not a successful instrumentation run. The connected Gradle test task uninstalls its target app during cleanup, removing that installation's practice data. Use a disposable test installation for this task.

For a manual flow, set the exact emulator/device serial, install the final APK, resolve the launch activity, and start it:

```sh
PRACTIQ_ANDROID_SERIAL=emulator-5560
adb -s "$PRACTIQ_ANDROID_SERIAL" install -r app/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
adb -s "$PRACTIQ_ANDROID_SERIAL" shell cmd package resolve-activity --brief com.practiq.android
adb -s "$PRACTIQ_ANDROID_SERIAL" shell am start -n com.practiq.android/.MainActivity
```

To retain this installation and its synthetic practice state after instrumentation, build the matching test APK without running the connected Gradle task, install it with `adb -s "$PRACTIQ_ANDROID_SERIAL" install -r -t /absolute/path/to/the-matching-test.apk`, then run:

```sh
adb -s "$PRACTIQ_ANDROID_SERIAL" shell am instrument -w \
  com.practiq.android.test/com.practiq.android.PractiQTestRunner
```

Keep the test APK, final app APK and source hashes together. Instrumentation can change its own synthetic fixtures; preserving installation does not mean every test leaves all app data unchanged.

Use isolated synthetic banks to verify native ZIP selection/import, image and audio playback, practice and draft recovery, dirty-editor Back, export/restore confirmation, rotation, background/resume and Activity recreation. Capture the actual OS/API, WebView version, APK SHA-256, source commit, commands and outcomes. Do not reset unrelated devices or personal app data.

An emulator can reach a host-loopback independent service through an explicit port reverse:

```sh
adb -s "$PRACTIQ_ANDROID_SERIAL" reverse tcp:8090 tcp:8090
```

Then configure `http://127.0.0.1:8090` in Settings → AI service. Connection testing is passive. Use a read-only service or test double for checks that must make no model call. The app never starts a service process; provider credentials stay in that independently running service. Remove the reverse after testing with `adb -s "$PRACTIQ_ANDROID_SERIAL" reverse --remove tcp:8090`. Services remain bound to loopback.

## CI and acceptance

The `Android CI` final job gates shared UI/contracts and package regressions, a complete arm64 debug APK, and API 35 x86_64 unit/instrumentation tests. `Desktop CI` covers macOS/Windows; `Service CI` covers the separate service and Web frontend. Required checks, review conversations and candidate identity must pass before merging. APK and emulator evidence does not establish physical-device, minimum-OS/WebView, release-signing, live-model or participant acceptance.
