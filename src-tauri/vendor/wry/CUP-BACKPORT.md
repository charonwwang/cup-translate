Source: crates.io wry 0.24.12 (MIT OR Apache-2.0). Cup's only source changes are
the opt-in WebKitGTK 4.1 feature and the GTK request header adapter. The other
platforms retain the upstream implementation. This backport keeps Tauri 1's
GTK 3 bindings and must be removed when the application moves to Tauri 2.

The adapter uses the libsoup 3 append API on WebKit's borrowed header object.
The unrelated upstream linux-headers feature (custom protocol response headers)
is disabled in Cup and is deliberately incompatible with this backport.
