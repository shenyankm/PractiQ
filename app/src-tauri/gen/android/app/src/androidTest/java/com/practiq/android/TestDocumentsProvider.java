package com.practiq.android;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Test APK only, including its separate provider process: no app dependencies. */
public final class TestDocumentsProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "application/octet-stream"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String path = uri.getLastPathSegment();
        if ("missing".equals(path)) return null;
        if ("denied".equals(path)) throw new SecurityException("sensitive-provider-detail-must-not-leak");
        try {
            if ("pipe".equals(path)) {
                ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
                new Thread(() -> {
                    try (ParcelFileDescriptor.AutoCloseOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                        output.write("pipe-fixture".getBytes(StandardCharsets.UTF_8));
                    } catch (IOException exception) { throw new AssertionError("fixture pipe failed"); }
                }).start();
                return pipe[0];
            }
            if ("source".equals(path) || "fixture".equals(path)) {
                File file = new File(getContext().getCacheDir(), "practiq-provider-" + path);
                if (!file.exists()) try (FileOutputStream output = new FileOutputStream(file)) {
                    output.write("original-fixture-content".getBytes(StandardCharsets.UTF_8));
                }
                return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode));
            }
            throw new SecurityException("unknown-fixture");
        } catch (IOException exception) { throw new FileNotFoundException("fixture unavailable"); }
    }
}
