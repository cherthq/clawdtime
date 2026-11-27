#!/bin/sh
# The clawdtime command of a release runtime. The runtime builder copies this
# file to runtime/bin/clawdtime. It runs the runtime's own Node on the compiled
# command, so the Mac needs no Node, npm, Git or Xcode.
#
# It finds its runtime through any chain of links, such as
# ~/.local/bin/clawdtime -> .../runtime/current/bin/clawdtime, and works in
# folders with spaces, such as ~/Library/Application Support. It runs only
# shell built-ins and tools of /usr/bin, never a tool of the same name from
# the PATH.
set -eu
# /bin/sh takes functions and CDPATH from the environment: neither may change
# cd, pwd or test here. unset is a special built-in, which no function hides.
unset -f cd pwd test
unset CDPATH

self=$0
while test -L "$self"; do
  target=$(/usr/bin/readlink "$self")
  case $target in
    /*) self=$target ;;
    *) self=$(/usr/bin/dirname "$self")/$target ;;
  esac
done
# -P resolves "current" to the version folder, so a running command keeps its
# own files when an update switches "current" to a newer version.
runtime=$(cd "$(/usr/bin/dirname "$self")/.." && pwd -P)

# Node may load a library of any signer (it loads the native addons of
# app/node_modules), so nothing from the environment may make it load code,
# options or data from another folder: the options and module folders of
# Node, its compile cache, ICU data and REPL module, the configuration,
# engines and providers of OpenSSL, and the DYLD_ variables of a Node that is
# not hardened. Certificates (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE) stay: they
# are data, and a company proxy may need them.
unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE NODE_COMPILE_CACHE NODE_ICU_DATA \
  NODE_PRESERVE_SYMLINKS OPENSSL_CONF OPENSSL_CONF_INCLUDE OPENSSL_ENGINES OPENSSL_MODULES \
  OPENSSL_armcap DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH \
  DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH DYLD_VERSIONED_LIBRARY_PATH \
  DYLD_VERSIONED_FRAMEWORK_PATH DYLD_IMAGE_SUFFIX
exec "$runtime/node/bin/node" "$runtime/app/dist/cli/main.js" "$@"
