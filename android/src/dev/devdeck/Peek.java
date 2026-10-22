package dev.devdeck;

/**
 * Reads single top-level members of a JSON object string without building a tree. Server
 * screens and transcripts can be hundreds of KB; the shell only needs a few small fields of
 * them and forwards the original string to the UI untouched.
 */
final class Peek {
    private Peek() {}

    /** Top-level string member, or null if absent or not a string. */
    static String str(String s, String key) {
        int i = find(s, key);
        if (i < 0 || s.charAt(i) != '"') return null;
        StringBuilder sb = null;
        int start = i + 1;
        for (int j = start; j < s.length(); j++) {
            char c = s.charAt(j);
            if (c == '"') {
                if (sb == null) return s.substring(start, j);
                return sb.append(s, start, j).toString();
            }
            if (c != '\\') continue;
            if (sb == null) sb = new StringBuilder();
            sb.append(s, start, j);
            if (++j >= s.length()) return null;
            char e = s.charAt(j);
            switch (e) {
                case 'n': sb.append('\n'); break;
                case 't': sb.append('\t'); break;
                case 'r': sb.append('\r'); break;
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
                case 'u':
                    if (j + 4 >= s.length()) return null;
                    try {
                        sb.append((char) Integer.parseInt(s.substring(j + 1, j + 5), 16));
                    } catch (NumberFormatException x) {
                        return null;
                    }
                    j += 4;
                    break;
                default: sb.append(e);
            }
            start = j + 1;
        }
        return null;
    }

    /** Top-level integer member, or def if absent or not a number. */
    static long num(String s, String key, long def) {
        int i = find(s, key);
        if (i < 0) return def;
        int j = i;
        if (j < s.length() && s.charAt(j) == '-') j++;
        while (j < s.length() && Character.isDigit(s.charAt(j))) j++;
        if (j == i) return def;
        try {
            return Long.parseLong(s.substring(i, j));
        } catch (NumberFormatException e) {
            return def;
        }
    }

    /** Index of the first character of the value of top-level member key, or -1. */
    private static int find(String s, String key) {
        int n = s.length();
        int i = skipWs(s, 0);
        if (i >= n || s.charAt(i) != '{') return -1;
        i++;
        while (true) {
            i = skipWs(s, i);
            if (i >= n || s.charAt(i) != '"') return -1;
            int kEnd = endOfString(s, i);
            if (kEnd < 0) return -1;
            boolean hit = kEnd - i - 1 == key.length() && s.startsWith(key, i + 1);
            i = skipWs(s, kEnd + 1);
            if (i >= n || s.charAt(i) != ':') return -1;
            i = skipWs(s, i + 1);
            if (hit) return i < n ? i : -1;
            i = skipValue(s, i);
            if (i < 0) return -1;
            i = skipWs(s, i);
            if (i >= n || s.charAt(i) != ',') return -1;
            i++;
        }
    }

    private static int skipWs(String s, int i) {
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c != ' ' && c != '\n' && c != '\r' && c != '\t') break;
            i++;
        }
        return i;
    }

    /** s[i] is the opening quote; returns the index of the closing quote or -1. */
    private static int endOfString(String s, int i) {
        for (int j = i + 1; j < s.length(); j++) {
            char c = s.charAt(j);
            if (c == '\\') j++;
            else if (c == '"') return j;
        }
        return -1;
    }

    /** Returns the index just past the value starting at i, or -1. */
    private static int skipValue(String s, int i) {
        int n = s.length();
        if (i >= n) return -1;
        char c = s.charAt(i);
        if (c == '"') {
            int e = endOfString(s, i);
            return e < 0 ? -1 : e + 1;
        }
        if (c == '{' || c == '[') {
            int depth = 0;
            for (int j = i; j < n; j++) {
                char d = s.charAt(j);
                if (d == '"') {
                    j = endOfString(s, j);
                    if (j < 0) return -1;
                } else if (d == '{' || d == '[') {
                    depth++;
                } else if (d == '}' || d == ']') {
                    if (--depth == 0) return j + 1;
                }
            }
            return -1;
        }
        int j = i;
        while (j < n) {
            char d = s.charAt(j);
            if (d == ',' || d == '}' || d == ']' || d == ' ' || d == '\n' || d == '\r' || d == '\t') break;
            j++;
        }
        return j == i ? -1 : j;
    }
}
