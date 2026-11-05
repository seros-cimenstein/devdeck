package dev.devdeck;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The web UI's durable key/value strings (compose drafts, ask answers, settings, cached chats), one
 * file per key in `dir`. Chromium batches localStorage commits and IndexedDB writes with relaxed
 * durability, so a phone that restarts or runs flat lost what the page had just written; here every
 * write reaches the disk within milliseconds: `<f>.tmp`, fsync, rename over `<f>`, fsync the directory.
 *
 * <p>One background writer thread does all disk writes, coalescing pending writes per key (the
 * latest value wins), so the JS bridge never waits on the disk. Reads are synchronous from an
 * in-memory map that already holds pending values; the key index loads on first use and each value
 * on its first read. One instance per process (the WebView and the activity may be recreated). No
 * android.* imports, so the file logic runs on a plain JVM.
 */
final class UiStore {
    private static UiStore instance;

    /** The process-wide store in `dir` (created on first call; later calls return it). */
    static synchronized UiStore open(File dir) {
        if (instance == null) instance = new UiStore(dir);
        return instance;
    }

    /** Waits up to `ms` for queued writes of the open store, if any; true when all are on disk. */
    static boolean flushOpen(long ms) {
        UiStore s;
        synchronized (UiStore.class) {
            s = instance;
        }
        return s == null || s.flush(ms);
    }

    private static final String TMP = ".tmp";
    private static final Base64.Encoder ENC = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder DEC = Base64.getUrlDecoder();

    /** A key's latest value; `value` is null until read from disk (`loaded`). */
    private static final class Entry {
        String value;
        boolean loaded;
        long stamp;  // last modified (ms), strictly increasing within the process

        Entry(String value, boolean loaded, long stamp) {
            this.value = value;
            this.loaded = loaded;
            this.stamp = stamp;
        }
    }

    /** A queued write: value null deletes. */
    private static final class Write {
        final String value;
        final long stamp;

        Write(String value, long stamp) {
            this.value = value;
            this.stamp = stamp;
        }
    }

    private final File dir;
    private final Object lock = new Object();
    private Map<String, Entry> index;  // guarded by lock; null until first use
    private final LinkedHashMap<String, Write> pending = new LinkedHashMap<>();  // guarded by lock
    private long queued, written;  // write generations, guarded by lock
    private long lastStamp;  // guarded by lock

    UiStore(File dir) {
        this.dir = dir;
        Thread t = new Thread(this::writeLoop, "dd-uistore");
        t.setDaemon(true);
        t.start();
    }

    /** The value of `key`, or null when absent. */
    String get(String key) {
        if (key == null || key.isEmpty()) return null;
        synchronized (lock) {
            Entry e = index().get(key);
            if (e == null) return null;
            if (!e.loaded) {
                // Never written this session, so no write to this file is in flight.
                e.value = read(new File(dir, name(key)));
                e.loaded = true;
                if (e.value == null) index.remove(key);
            }
            return e.value;
        }
    }

    /** Sets `key` (null or empty deletes); on disk shortly after, in the background. */
    void put(String key, String value) {
        if (key == null || key.isEmpty()) return;
        if (value != null && value.isEmpty()) value = null;
        synchronized (lock) {
            Map<String, Entry> idx = index();
            Entry e = idx.get(key);
            if (value == null ? e == null : e != null && e.loaded && value.equals(e.value)) return;
            long stamp = Math.max(System.currentTimeMillis(), lastStamp + 1);
            lastStamp = stamp;
            if (value == null) idx.remove(key);
            else idx.put(key, new Entry(value, true, stamp));
            pending.put(key, new Write(value, stamp));
            queued++;
            lock.notifyAll();
        }
    }

    /** Keys starting with `prefix`, least recently written first. */
    List<String> keys(String prefix) {
        String p = prefix == null ? "" : prefix;
        List<Map.Entry<String, Entry>> found = new ArrayList<>();
        synchronized (lock) {
            for (Map.Entry<String, Entry> me : index().entrySet()) {
                if (me.getKey().startsWith(p)) found.add(me);
            }
            found.sort((a, b) -> a.getValue().stamp != b.getValue().stamp
                    ? Long.compare(a.getValue().stamp, b.getValue().stamp)
                    : a.getKey().compareTo(b.getKey()));
        }
        List<String> out = new ArrayList<>(found.size());
        for (Map.Entry<String, Entry> me : found) out.add(me.getKey());
        return out;
    }

    /** Waits up to `ms` until everything queued so far is on disk; true when it is. */
    boolean flush(long ms) {
        long deadline = System.currentTimeMillis() + ms;
        synchronized (lock) {
            long target = queued;
            while (written < target) {
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) return false;
                try {
                    lock.wait(left);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return written >= target;
                }
            }
            return true;
        }
    }

    // ---- disk ----

    /** Caller holds lock. Lists `dir` once: keys with their file times; stale temp files go. */
    private Map<String, Entry> index() {
        if (index != null) return index;
        index = new HashMap<>();
        File[] files = dir.listFiles();
        if (files == null) return index;
        for (File f : files) {
            String n = f.getName();
            if (n.endsWith(TMP)) {
                f.delete();  // a write cut short before its rename: the old file is still whole
                continue;
            }
            String key;
            try {
                key = new String(DEC.decode(n), StandardCharsets.UTF_8);
            } catch (IllegalArgumentException e) {
                continue;
            }
            long stamp = f.lastModified();
            index.put(key, new Entry(null, false, stamp));
            lastStamp = Math.max(lastStamp, stamp);
        }
        return index;
    }

    private static String name(String key) {
        return ENC.encodeToString(key.getBytes(StandardCharsets.UTF_8));
    }

    private static String read(File f) {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream((int) Math.max(16, f.length()));
            byte[] b = new byte[8192];
            for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n);
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }

    private void writeLoop() {
        while (true) {
            Map<String, Write> batch;
            long gen;
            synchronized (lock) {
                while (pending.isEmpty()) {
                    try {
                        lock.wait();
                    } catch (InterruptedException e) {
                        return;
                    }
                }
                batch = new LinkedHashMap<>(pending);
                pending.clear();
                gen = queued;
            }
            if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
                System.err.println("UiStore: cannot create " + dir);
            }
            for (Map.Entry<String, Write> w : batch.entrySet()) {
                try {
                    write(w.getKey(), w.getValue());
                } catch (IOException | RuntimeException e) {
                    System.err.println("UiStore: writing " + w.getKey() + " failed: " + e);
                }
            }
            syncDir();
            synchronized (lock) {
                written = gen;
                lock.notifyAll();
            }
        }
    }

    private void write(String key, Write w) throws IOException {
        File f = new File(dir, name(key));
        if (w.value == null) {
            if (!f.delete() && f.exists()) throw new IOException("cannot delete " + f);
            return;
        }
        File tmp = new File(dir, f.getName() + TMP);
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(w.value.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        tmp.setLastModified(w.stamp);  // keys() order after a restart
        if (!tmp.renameTo(f)) {
            tmp.delete();
            throw new IOException("cannot rename " + tmp);
        }
    }

    /** Makes the batch's renames and deletes durable. */
    private void syncDir() {
        try (FileChannel ch = FileChannel.open(dir.toPath(), StandardOpenOption.READ)) {
            ch.force(true);
        } catch (IOException | RuntimeException ignored) {
            // Not every file system lets a directory be opened; the files themselves are synced.
        }
    }
}
