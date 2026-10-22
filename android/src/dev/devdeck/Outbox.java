package dev.devdeck;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.UUID;

/**
 * Copies picked/shared content into getFilesDir()/outbox/ right away (content-URI grants expire
 * once the receiving activity is gone) and queues an upload for each copy.
 */
final class Outbox {
    private static final String TAG = "DevDeck";

    private Outbox() {}

    static File dir(Context c) {
        File d = new File(c.getFilesDir(), "outbox");
        d.mkdirs();
        return d;
    }

    /** Blocking; call off the main thread while the URI grant is still valid. Returns the number queued. */
    static int queue(Context c, List<Uri> uris) {
        JSONArray items = new JSONArray();
        for (Uri u : uris) {
            String id = UUID.randomUUID().toString();
            File f = new File(dir(c), id);
            try (InputStream in = c.getContentResolver().openInputStream(u);
                 OutputStream out = new FileOutputStream(f)) {
                if (in == null) throw new IOException("no stream for " + u);
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            } catch (IOException | SecurityException e) {
                Log.w(TAG, "copy " + u + " failed", e);
                f.delete();
                continue;
            }
            try {
                items.put(LinkService.uploadItem(id, f, displayName(c, u)));
            } catch (JSONException e) {
                f.delete();
            }
        }
        if (items.length() > 0) LinkService.enqueue(c, items);
        return items.length();
    }

    static String summary(int queued, int total) {
        return queued == total ? "Queued " + queued + " file(s) for upload"
                : "Queued " + queued + " of " + total + " file(s) for upload";
    }

    private static String displayName(Context c, Uri u) {
        String name = null;
        try (Cursor cur = c.getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME},
                null, null, null)) {
            if (cur != null && cur.moveToFirst() && !cur.isNull(0)) name = cur.getString(0);
        } catch (RuntimeException e) {
            // Some providers (file://, odd apps) don't support queries; fall back to the path.
        }
        if (name == null || name.isEmpty()) name = u.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "file";
        return name;
    }
}
