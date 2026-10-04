package com.practiq.android

import android.content.pm.ApplicationInfo
import android.security.NetworkSecurityPolicy
import android.util.AtomicFile
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore
import javax.crypto.SecretKey

@RunWith(AndroidJUnit4::class)
class SecureTokenStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val account = "ai-service-token-" + "a".repeat(64)
    private val other = "ai-service-token-" + "b".repeat(64)
    private lateinit var store: SecureTokenStore
    private fun file(id: String) = File(context.noBackupFilesDir, "service-tokens-v1/$id.token")

    @Before fun prepare() {
        store = SecureTokenStore(context)
        store.write(account, null)
        store.write(other, null)
    }

    @After fun cleanup() {
        store.write(account, null)
        store.write(other, null)
    }

    @Test fun credentialsPersistEncryptedAcrossStoreRecreation() {
        assertNull(store.read(account))
        store.write(account, "fixture-token-never-a-real-credential")
        val first = file(account).readBytes()
        assertFalse(first.toString(Charsets.ISO_8859_1).contains("fixture-token"))
        assertEquals("fixture-token-never-a-real-credential", SecureTokenStore(context).read(account))
        val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            .getKey("practiq-service-token-v1-$account", null) as SecretKey
        assertNull(key.encoded)
        store.write(account, "fixture-token-never-a-real-credential")
        assertFalse(first.contentEquals(file(account).readBytes()))
    }

    @Test fun ciphertextTamperingAndLostKeysAreErrorsAndClearRecovers() {
        store.write(account, "fixture-token")
        file(account).writeBytes(file(account).readBytes().apply { this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte() })
        assertThrows(Exception::class.java) { store.read(account) }
        store.write(account, null)
        assertNull(store.read(account))
        store.write(account, "fixture-token")
        KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry("practiq-service-token-v1-$account") }
        assertThrows(Exception::class.java) { store.read(account) }
        store.write(account, null)
        assertNull(store.read(account))
    }

    @Test fun ciphertextCannotBeMovedToAnotherServiceAccount() {
        store.write(account, "first-fixture-token")
        store.write(other, "second-fixture-token")
        file(other).writeBytes(file(account).readBytes())
        assertThrows(Exception::class.java) { store.read(other) }
        assertEquals("first-fixture-token", store.read(account))
    }

    @Test fun atomicBackupRecoversAndExplicitClearRemovesEveryGeneration() {
        store.write(account, "durable-fixture-token")
        val base = file(account)
        check(base.renameTo(File(base.path + ".bak")))
        base.writeBytes(byteArrayOf(1, 2, 3))
        assertEquals("durable-fixture-token", store.read(account))
        val atomic = AtomicFile(base)
        val pending = atomic.startWrite()
        pending.write(byteArrayOf(4, 5, 6))
        atomic.failWrite(pending)
        assertEquals("durable-fixture-token", store.read(account))
        File(base.path + ".new").writeBytes(byteArrayOf(1))
        File(base.path + ".bak").writeBytes(byteArrayOf(1))
        store.write(account, null)
        assertTrue(listOf("", ".new", ".bak").none { File(base.path + it).exists() })
        assertNull(store.read(account))
    }

    @Test fun invalidAndOversizedInputsPreserveExistingCredential() {
        store.write(account, "durable-fixture-token")
        for (invalid in listOf("x".repeat(8193), "with\ncontrol", "非ASCII")) {
            assertThrows(IllegalArgumentException::class.java) { store.write(account, invalid) }
        }
        assertThrows(IllegalArgumentException::class.java) { store.write("../escape", "fixture") }
        assertEquals("durable-fixture-token", store.read(account))
        file(account).writeBytes(ByteArray(TokenEnvelope.MAX_BYTES + 1))
        assertThrows(Exception::class.java) { store.read(account) }
    }

    @Test fun automaticBackupAndNonlocalCleartextAreDisabled() {
        assertEquals(0, context.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
        assertTrue(file(account).canonicalPath.startsWith(context.noBackupFilesDir.canonicalPath + "/"))
        val policy = NetworkSecurityPolicy.getInstance()
        assertFalse(policy.isCleartextTrafficPermitted("example.com"))
        assertFalse(policy.isCleartextTrafficPermitted("10.0.2.2"))
        assertTrue(policy.isCleartextTrafficPermitted("127.0.0.1"))
        assertTrue(policy.isCleartextTrafficPermitted("tauri.localhost"))
    }
}
