import com.android.build.gradle.LibraryExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension

buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

// The pinned upstream singleton must rebind launchers to a recreated Activity.
// Compile the reviewed one-line replacement without changing the Cargo cache.
subprojects {
    if (name == "tauri-android") {
        plugins.withId("org.jetbrains.kotlin.android") {
            val replacement = rootProject.file("patches/tauri-2.11.5")
            val sources = rootProject.layout.buildDirectory.dir("generated/tauri-lifecycle-sources")
            val prepareSources = tasks.register<Sync>("syncPractiQTauriSources") {
                from(layout.projectDirectory.dir("src/main/java")) {
                    exclude("**/PluginManager.kt")
                }
                from(replacement)
                into(sources)
            }
            extensions.configure<LibraryExtension> {
                sourceSets.getByName("main").java.setSrcDirs(listOf(sources))
            }
            extensions.configure<KotlinAndroidProjectExtension> {
                sourceSets.getByName("main").kotlin.setSrcDirs(listOf(sources))
            }
            tasks.matching { it.name.startsWith("compile") }.configureEach {
                dependsOn(prepareSources)
            }
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}
