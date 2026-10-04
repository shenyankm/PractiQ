package com.practiq.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Ciphertext and keys stay outside study backups and Android automatic transfers. */
internal class SecureTokenStore(context: Context) {
    companion object { private val storageLock = Any() }
    private val directory = File(context.noBackupFilesDir, "service-tokens-v1")
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun file(account: String): AtomicFile {
        TokenRules.validateAccount(account)
        check(directory.isDirectory || directory.mkdirs()) { "SECURE_STORAGE_UNAVAILABLE" }
        return AtomicFile(File(directory, "$account.token"))
    }

    private fun alias(account: String) = "practiq-service-token-v1-$account"

    private fun key(account: String, create: Boolean): SecretKey {
        val existing = keyStore.getKey(alias(account), null)
        if (existing is SecretKey) return existing
        check(create) { "SECURE_STORAGE_UNAVAILABLE" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias(account), KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build())
            generateKey()
        }
    }

    private fun bytes(file: AtomicFile): ByteArray? {
        try {
            return file.openRead().use { input ->
                val buffer = ByteArray(TokenEnvelope.MAX_BYTES + 1)
                var count = 0
                while (count < buffer.size) {
                    val read = input.read(buffer, count, buffer.size - count)
                    if (read < 0) break
                    check(read > 0) { "SECURE_STORAGE_UNAVAILABLE" }
                    count += read
                }
                check(count <= TokenEnvelope.MAX_BYTES) { "SECURE_STORAGE_UNAVAILABLE" }
                buffer.copyOf(count)
            }
        } catch (_: FileNotFoundException) {
            check(!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) {
                "SECURE_STORAGE_UNAVAILABLE"
            }
            return null
        }
    }

    fun read(account: String): String? = synchronized(storageLock) {
        val payload = bytes(file(account)) ?: return@synchronized null
        val envelope = TokenEnvelope.decode(payload)
        val value = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key(account, false), GCMParameterSpec(TokenEnvelope.TAG_BITS, envelope.iv))
            updateAAD(account.toByteArray(Charsets.US_ASCII))
            doFinal(envelope.ciphertext).toString(Charsets.US_ASCII)
        }
        TokenRules.validateToken(value)
        value
    }

    fun write(account: String, token: String?) = synchronized(storageLock) {
        val target = file(account)
        if (token == null) {
            // Explicit Clear must also recover a corrupt ciphertext or a lost key.
            target.delete()
            // Android 8 AtomicFile.delete() predates the .new generation.
            for (suffix in listOf("", ".new", ".bak")) {
                val generation = File(target.baseFile.path + suffix)
                check(!generation.exists() || generation.delete()) { "SECURE_STORAGE_UNAVAILABLE" }
            }
            check(listOf("", ".new", ".bak").none { File(target.baseFile.path + it).exists() }) {
                "SECURE_STORAGE_UNAVAILABLE"
            }
            keyStore.deleteEntry(alias(account))
            check(!keyStore.containsAlias(alias(account))) { "SECURE_STORAGE_UNAVAILABLE" }
            return@synchronized
        }
        TokenRules.validateToken(token)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key(account, true))
            updateAAD(account.toByteArray(Charsets.US_ASCII))
        }
        val payload = TokenEnvelope.encode(cipher.iv, cipher.doFinal(token.toByteArray(Charsets.US_ASCII)))
        var stream: FileOutputStream? = null
        try {
            stream = target.startWrite()
            stream.write(payload)
            target.finishWrite(stream)
            stream = null
            // AtomicFile may log a rename failure; success requires durable readback.
            check(read(account) == token) { "SECURE_STORAGE_UNAVAILABLE" }
        } finally {
            if (stream != null) target.failWrite(stream)
        }
    }
}
