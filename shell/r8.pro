# R8 rules for the shell: keep the activity the manifest names, drop the rest of the Kotlin standard library
# that isn't used (2.3 MB of dex → ~30 KB). No obfuscation: stack traces in logcat stay readable.
-keep class dev.nodeapk.shell.MainActivity { <init>(); }
-dontobfuscate
# kotlinc's nullability annotations aren't on the classpath, and don't need to be
-dontwarn org.jetbrains.annotations.**
