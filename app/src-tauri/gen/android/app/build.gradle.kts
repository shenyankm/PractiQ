import java.util.Properties
import java.security.MessageDigest
import java.util.concurrent.Callable

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    ndkVersion = "28.2.13676358"
    namespace = "com.practiq.android"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.practiq.android"
        minSdk = 26
        targetSdk = 36
        testInstrumentationRunner = "com.practiq.android.PractiQTestRunner"
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
}

apply(from = "tauri.build.gradle.kts")

configurations.matching { it.name.endsWith("DebugRuntimeClasspath") }.configureEach {
    resolutionStrategy.activateDependencyLocking()
}

// Export the resolved runtime, not the declared dependency list. Python validates
// every artifact and POM against the reviewed notice lock before preparing assets.
tasks.register("exportRuntimeNoticeInventory") {
    dependsOn(":tauri-android:bundleDebugAar", ":tauri-plugin-dialog:bundleDebugAar")
    val noticeConfigurationName = providers.gradleProperty("practiqNoticeConfiguration")
    val noticeRuntimeArtifacts = noticeConfigurationName.map { configurationName ->
        require(configurationName in setOf("arm64DebugRuntimeClasspath", "x86_64DebugRuntimeClasspath", "universalDebugRuntimeClasspath"))
        configurations.getByName(configurationName).incoming.artifactView {
            attributes.attribute(Attribute.of("artifactType", String::class.java), "android-classes-jar")
        }.artifacts
    }
    inputs.files(noticeRuntimeArtifacts.map { it.artifactFiles }).withPropertyName("noticeRuntimeArtifacts")
    dependsOn(Callable { noticeRuntimeArtifacts.get().artifactFiles.buildDependencies })
    doLast {
        val configurationName = noticeConfigurationName.get()
        val configuration = configurations.getByName(configurationName)
        val runtimeArtifacts = noticeRuntimeArtifacts.get().artifacts.sortedBy { it.id.componentIdentifier.displayName }
        val originalArtifacts = configuration.incoming.artifactView {
            componentFilter { it is org.gradle.api.artifacts.component.ModuleComponentIdentifier }
        }.artifacts.artifacts.associateBy { it.id.componentIdentifier.displayName + "|" + it.file.name }
        val moduleIds = runtimeArtifacts.map { it.id.componentIdentifier }
            .filterIsInstance<org.gradle.api.artifacts.component.ModuleComponentIdentifier>().distinct()
        val poms = dependencies.createArtifactResolutionQuery().forComponents(moduleIds)
            .withArtifacts(org.gradle.maven.MavenModule::class.java, org.gradle.maven.MavenPomArtifact::class.java)
            .execute().resolvedComponents.associate { component ->
                component.id to component.getArtifacts(org.gradle.maven.MavenPomArtifact::class.java)
                    .filterIsInstance<org.gradle.api.artifacts.result.ResolvedArtifactResult>().single().file
            }
        fun digest(file: java.io.File): String = MessageDigest.getInstance("SHA-256")
            .digest(file.readBytes()).joinToString("") { "%02x".format(it) }
        val rows = runtimeArtifacts.map { selected ->
            val component = selected.id.componentIdentifier
            val runtime = mapOf("runtimeArtifactIdentity" to selected.id.displayName,
                "runtimeArtifact" to selected.file.absolutePath, "runtimeArtifactSha256" to digest(selected.file))
            if (component is org.gradle.api.artifacts.component.ModuleComponentIdentifier) {
                // Select the original artifact from this same runtime configuration.
                // Component filtering avoids AGP's local-project secondary variants.
                val sourceName = selected.id.displayName.substringBefore(" -> ").substringBefore(" (")
                val original = originalArtifacts.getValue(component.displayName + "|" + sourceName)
                val artifact = original.file
                val extension = artifact.extension
                require(extension in setOf("aar", "jar"))
                val stem = "${component.module}-${component.version}"
                val sourceStem = artifact.nameWithoutExtension
                val classifier = sourceStem.takeIf { it.startsWith(stem + "-") }?.removePrefix(stem + "-")
                val pom = poms.getValue(component)
                runtime + mapOf("group" to component.group, "name" to component.module, "version" to component.version,
                    "classifier" to classifier, "extension" to extension, "project" to false, "projectDirectory" to null,
                    "artifact" to artifact.absolutePath, "artifactSha256" to digest(artifact),
                    "artifactIdentity" to original.id.displayName, "artifactVariant" to original.variant.displayName,
                    "pom" to pom.absolutePath, "pomSha256" to digest(pom))
            } else {
                require(component is org.gradle.api.artifacts.component.ProjectComponentIdentifier)
                val dependencyProject = rootProject.project(component.projectPath)
                val artifact = dependencyProject.layout.buildDirectory.file("outputs/aar/${dependencyProject.name}-debug.aar").get().asFile
                val overrides = if (dependencyProject.name == "tauri-android") {
                    val original = dependencyProject.file("src/main/java/app/tauri/plugin/PluginManager.kt")
                    val replacement = rootProject.file("patches/tauri-2.11.5/app/tauri/plugin/LifecyclePluginManager.kt")
                    val compiled = rootProject.file("build/generated/tauri-lifecycle-sources/app/tauri/plugin/LifecyclePluginManager.kt")
                    val compiler = dependencyProject.tasks.named("compileDebugKotlin").get() as org.jetbrains.kotlin.gradle.tasks.KotlinCompile
                    val sources = compiler.sources.files.map { it.canonicalFile }
                    listOf(mapOf("originalFile" to original.absolutePath, "originalSha256" to digest(original),
                        "replacementFile" to replacement.absolutePath, "replacementSha256" to digest(replacement),
                        "compiledReplacementFile" to compiled.absolutePath, "compiledReplacementSha256" to digest(compiled),
                        "originalCompiled" to sources.any { it.name == "PluginManager.kt" },
                        "replacementCompiled" to sources.contains(compiled.canonicalFile)))
                } else emptyList()
                runtime + mapOf("group" to dependencyProject.group.toString(), "name" to dependencyProject.name,
                    "version" to dependencyProject.version.toString(), "classifier" to null, "extension" to "aar",
                    "project" to true, "projectDirectory" to dependencyProject.projectDir.absolutePath,
                    "artifact" to artifact.absolutePath, "artifactSha256" to digest(artifact), "pom" to null, "pomSha256" to null,
                    "sourceOverrides" to overrides)
            }
        }
        val output = file(providers.gradleProperty("practiqNoticeOutput").get())
        require(!output.exists()) { "Runtime inventory output already exists" }
        output.parentFile.mkdirs()
        output.writeText(groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(
            mapOf("schemaVersion" to 1, "configuration" to configurationName, "artifacts" to rows))) + "\n")
    }
}
