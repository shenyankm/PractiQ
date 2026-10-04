package com.practiq.android

import androidx.test.runner.AndroidJUnitRunner

// Tauri's native event loop belongs to the process. Keep one real Activity for
// this bridge suite instead of destroying it before every test method.
class PractiQTestRunner : AndroidJUnitRunner() {
    override fun shouldWaitForActivitiesToComplete(): Boolean = false
}
